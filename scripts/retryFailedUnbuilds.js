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
  const destsRaw = parsed.raw || []

  const src = parsed.source || {}
  const sourceItem = src.nsItemId ? { id: src.nsItemId } : { id: null }
  const sourceBinId = itemConfig.getBinId(sourceSilo)

  const resolved = Array.isArray(parsed.resolved) ? parsed.resolved : []
  const creamDest = resolved.find(d => d.kind === 'cream') || null
  const skimDest  = resolved.find(d => d.kind === 'skim' && (d.silo || d.raw) !== sourceSilo) || null

  const needCream = !!(creamDest && creamVolume > 0)
  const needSkim  = !!(skimDest  && skimVolume  > 0)

  if (!sourceItem.id) throw new Error(`No source NS item ID stored for batch ${row.batchId}`)

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

  const bomId = itemConfig.getSeparationBomId(sourceItem.id, skimDest?.productIndex)
  if (bomId) body.billOfMaterials = { id: bomId }

  if (sourceBinId) {
    body.inventoryDetail = {
      inventoryAssignment: {
        items: [{ quantity: inputVolume, binnumber: { id: sourceBinId } }],
      },
    }
  }

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
  if (componentItems.length > 0) body.component = { items: componentItems }

  let nsResult
  try {
    nsResult = await core.netsuitePost('/record/v1/assemblyUnbuild', body)
  } catch (err) {
    const isInvalidItem = err.message?.includes('INVALID_VALUE') && err.message?.includes('item')
    const isNotFound = err.message?.includes('404') || err.message?.includes('not found')
    if (isInvalidItem || isNotFound) {
      console.log(`  REST failed (${isInvalidItem ? 'INVALID_VALUE/item' : '404'}) — trying RESTlet`)
      nsResult = await core.callRestlet('customscript_sa_milk_unbuild', 'customdeploy_sa_milk_unbuild', body)
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
