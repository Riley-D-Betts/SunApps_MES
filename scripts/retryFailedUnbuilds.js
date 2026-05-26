/**
 * Retry MesSeparationBatch rows that are stuck in status='error'.
 *
 * Rebuilds the NS assemblyUnbuild payload from the stored destinations JSON
 * and re-fires the call (with the same REST→RESTlet fallback used at runtime).
 * On success the row is updated to 'completed'; on failure it stays 'error'
 * with the new error message.
 *
 * Defaults to dry-run. Pass --confirm to actually fire NS calls.
 *
 * Usage:
 *   node scripts/retryFailedUnbuilds.js
 *   node scripts/retryFailedUnbuilds.js --confirm
 */

const core = require('../clients/coreClient')
const itemConfig = require('../services/mesItemConfig')
const db = require('../models')
const { sequelize } = require('../config')

const confirm = process.argv.includes('--confirm')
const limitArg = process.argv.find(a => a.startsWith('--limit='))
const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : null

async function fireUnbuild(row) {
  let parsed = {}
  try { parsed = JSON.parse(row.destinations || '{}') } catch { /**/ }

  const sourceSilo = row.sourceSilo
  const inputVolume = parseFloat(row.inputVolume) || 0
  const creamVolume = parseFloat(row.creamVolume) || 0
  const skimVolume = parseFloat(row.skimVolume) || 0
  // New format: { source, resolved, raw }. Legacy format: plain array of silo names.
  const isLegacy = Array.isArray(parsed)
  const src = (!isLegacy && parsed.source) || {}
  const sourceBinId = itemConfig.getBinId(sourceSilo)

  // Source item: prefer stored nsItemId, fall back to SILO_ITEM_MAP by silo name.
  const sourceItem = src.nsItemId
    ? { id: src.nsItemId }
    : itemConfig.getItem(row.itemId, sourceSilo)
  if (!sourceItem.id) throw new Error(`Cannot resolve source NS item for batch ${row.batchId} (silo=${sourceSilo})`)

  // Resolved destinations: new format has the full array; legacy format is a plain
  // array of silo name strings — classify by prefix and look up from SILO_ITEM_MAP.
  let resolved
  if (!isLegacy && Array.isArray(parsed.resolved)) {
    resolved = parsed.resolved
  } else {
    const legacyNames = isLegacy ? parsed : (parsed.raw || [])
    resolved = legacyNames.map(raw => {
      const silo = itemConfig.normalizeSiloName(raw)
      const kind = itemConfig.classifySiloDestination(raw)
      const item = silo ? itemConfig.getItem(null, silo) : { id: null, name: '' }
      return { raw, silo, kind, binId: silo ? itemConfig.getBinId(silo) : null,
               productIndex: 0, productName: '', item }
    })
  }

  const creamDest = resolved.find(d => d.kind === 'cream') || null
  const skimDest  = resolved.find(d => d.kind === 'skim' && (d.silo || d.raw) !== sourceSilo) || null

  const needCream = !!(creamDest && creamVolume > 0)
  const needSkim  = !!(skimDest  && skimVolume  > 0)

  const destsRaw = isLegacy ? parsed : (parsed.raw || [])

  // The BOM defines exactly which product items the unbuild should produce.
  // We must send those same item IDs (NOT the source silo's raw-milk item IDs)
  // so NS updates existing BOM lines with our exact quantities instead of trying
  // to add new lines to a static sublist.
  const rawSkimProductIndex = skimDest?.productIndex
  const skimProductIndex = itemConfig.normalizeSkimIndex(sourceItem.id, rawSkimProductIndex)
  if (skimProductIndex !== rawSkimProductIndex) {
    console.log(`[retryFailedUnbuilds] Normalized skim index ${rawSkimProductIndex} → ${skimProductIndex} (organic source ${sourceItem.id} with conventional skim index)`)
  }
  const bomId = itemConfig.getSeparationBomId(sourceItem.id, skimProductIndex)
  if (!bomId) throw new Error(`No BOM mapped for source=${sourceItem.id} skim productIndex=${skimProductIndex}`)

  // Cream item: 5483 for organic source (5404), 5480 for conventional (5417)
  const creamItemId = sourceItem.id === 5404 ? 5483 : 5480
  // Skim item: look up by productIndex (e.g. 8 → 5410 Organic 2%)
  const skimItem = itemConfig.getItemByProductIndex(skimProductIndex)
  if (needSkim && !skimItem.id) throw new Error(`No NS item for skim productIndex=${skimProductIndex}`)

  const body = {
    item: { id: sourceItem.id },
    quantity: inputVolume,
    location: { id: 23 },
    subsidiary: { id: 2 },
    billOfMaterials: { id: bomId },
    custbody_milk_source_silo: sourceSilo,
    custbody_milk_batch_start: row.batchStart,
    custbody_milk_batch_end: row.batchEnd,
    custbody_milk_transfer_name: row.transferName || row.batchId,
    custbody_milk_destinations: destsRaw.join(', '),
  }

  // Source assembly item is bin-tracked — tell NS which bin to pull from.
  if (sourceBinId) {
    body.inventoryDetail = {
      inventoryAssignment: {
        items: [{ quantity: inputVolume, binnumber: { id: sourceBinId } }],
      },
    }
  }

  // Output items are bin-tracked (not lot-tracked), so each component line
  // needs a componentInventoryDetail with just binnumber — no receiptInventoryNumber.
  const componentItems = []
  if (needCream) {
    componentItems.push({
      item: creamItemId,
      quantity: creamVolume,
      componentInventoryDetail: creamDest.binId ? {
        inventoryAssignment: { items: [{ quantity: creamVolume, binnumber: { id: creamDest.binId } }] },
      } : undefined,
    })
  }
  if (needSkim) {
    componentItems.push({
      item: skimItem.id,
      quantity: skimVolume,
      componentInventoryDetail: skimDest.binId ? {
        inventoryAssignment: { items: [{ quantity: skimVolume, binnumber: { id: skimDest.binId } }] },
      } : undefined,
    })
  }
  if (componentItems.length > 0) body.component = { items: componentItems }

  console.log('  Request body:', JSON.stringify(body, null, 2))

  const nsResult = await core.netsuitePost('/record/v1/assemblyUnbuild', body)

  const locHeader = nsResult?.headers?.location || nsResult?.headers?.Location || ''
  const locId = locHeader.match(/\/(\d+)(?:\?.*)?$/)?.[1] || null
  const nsTransactionId = nsResult?.body?.id || nsResult?.body?.unbuildId || nsResult?.id || locId || null
  return nsTransactionId
}

async function main() {
  const order = process.argv.includes('--newest-first') ? 'DESC' : 'ASC'
  const rows = await db.MesSeparationBatch.findAll({
    where: { status: 'error' },
    order: [['createdAt', order]],
    limit: limit || undefined,
    raw: false,
  })

  if (rows.length === 0) {
    console.log('No error batches found.')
    return
  }

  console.log(`Found ${rows.length} error batch(es). ${confirm ? 'Retrying...' : '[dry run]'}\n`)

  for (const row of rows) {
    console.log(`Batch ${row.batchId} (${row.sourceSilo}) — ${parseFloat(row.inputVolume).toFixed(0)} lb`)
    if (!confirm) {
      console.log('  [dry run] would re-fire NS assemblyUnbuild\n')
      continue
    }
    try {
      const nsTransactionId = await fireUnbuild(row)
      await row.update({ status: 'completed', nsTransactionId, errorMessage: null, processedAt: new Date() })
      console.log(`  OK — NS transaction: ${nsTransactionId}\n`)
    } catch (err) {
      await row.update({ errorMessage: err.message, processedAt: new Date() })
      console.error(`  FAILED: ${err.message}\n`)
    }
  }
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => sequelize.close())
