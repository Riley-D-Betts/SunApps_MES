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

  const lotDate = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const creamLot = `${sourceSilo}-${lotDate}-CR`
  const skimLot  = `${sourceSilo}-${lotDate}-SK`

  const body = {
    item: { id: sourceItem.id },
    quantity: inputVolume,
    location: { id: 23 },
    subsidiary: { id: 2 },
    custbody_milk_source_silo: sourceSilo,
    custbody_milk_batch_start: row.batchStart,
    custbody_milk_batch_end: row.batchEnd,
    custbody_milk_transfer_name: row.transferName || row.batchId,
    custbody_milk_destinations: destsRaw.join(', '),
  }

  if (sourceBinId) {
    body.inventoryDetail = {
      inventoryAssignment: {
        items: [{ quantity: inputVolume, binnumber: { id: sourceBinId } }],
      },
    }
  }

  // Build explicit component items. When component items are present, omit
  // billOfMaterials — specifying a BOM locks the component sublist and NS rejects
  // any attempt to set componentInventoryDetail on those lines via REST.
  const componentItems = []
  if (needCream && creamDest.item?.id) {
    componentItems.push({
      item: creamDest.item.id,
      quantity: creamVolume,
      componentInventoryDetail: creamDest.binId ? {
        inventoryAssignment: {
          items: [{ quantity: creamVolume, receiptInventoryNumber: creamLot, binnumber: { id: creamDest.binId } }],
        },
      } : undefined,
    })
  }
  if (needSkim && skimDest.item?.id) {
    componentItems.push({
      item: skimDest.item.id,
      quantity: skimVolume,
      componentInventoryDetail: skimDest.binId ? {
        inventoryAssignment: {
          items: [{ quantity: skimVolume, receiptInventoryNumber: skimLot, binnumber: { id: skimDest.binId } }],
        },
      } : undefined,
    })
  }
  if (componentItems.length > 0) {
    body.component = { items: componentItems }
    // BOM omitted intentionally — specifying it locks the sublist (REST limitation)
  } else {
    // No explicit components: include BOM so NS knows which fat-level items to create
    const bomId = itemConfig.getSeparationBomId(sourceItem.id, skimDest?.productIndex)
    if (bomId) body.billOfMaterials = { id: bomId }
  }

  console.log('  Request body:', JSON.stringify(body, null, 2))

  let nsResult
  try {
    nsResult = await core.netsuitePost('/record/v1/assemblyUnbuild', body)
  } catch (err) {
    console.log('  NS error:', err.message)
    const isComponentError = err.message?.includes('USER_ERROR') && err.message?.includes('component')
    const isInvalidItem = err.message?.includes('INVALID_VALUE') && err.message?.includes('item')
    const isNotFound = err.message?.includes('404') || err.message?.includes('not found')
    if (isComponentError || isInvalidItem || isNotFound) {
      // NS REST cannot set componentInventoryDetail on BOM-controlled sublists.
      // The RESTlet uses N/record dynamic mode which bypasses this restriction.
      // TODO: fix the SunApps_Gateway route for /api/netsuite/restlet — it currently
      //       routes to the NS record API instead of the RESTlet endpoint.
      console.log('  Falling back to RESTlet (requires gateway fix in SunApps_Gateway)')
      nsResult = await core.callRestlet('customscript_sa_milk_unbuild_rl', 'customdeploy1', body)
    } else {
      throw err
    }
  }

  const locHeader = nsResult?.headers?.location || nsResult?.headers?.Location || ''
  const locId = locHeader.match(/\/(\d+)(?:\?.*)?$/)?.[1] || null
  const nsTransactionId = nsResult?.body?.id || nsResult?.body?.unbuildId || nsResult?.id || locId || null
  return nsTransactionId
}

async function main() {
  const rows = await db.MesSeparationBatch.findAll({
    where: { status: 'error' },
    order: [['createdAt', 'ASC']],
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
