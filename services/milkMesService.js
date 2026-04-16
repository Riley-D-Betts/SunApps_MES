const core = require('../clients/coreClient')
const itemConfig = require('./mesItemConfig')
const config = require('../config')
const db = require('../models')

async function processSeparationBatch(data) {
  const {
    batchId, sourceSilo, destinations, inputVolume, creamVolume, skimVolume,
    batchStart, batchEnd, itemId, transferName, unit, targetVolume,
  } = data

  if (!batchId) throw new Error('batchId is required')
  if (!sourceSilo) throw new Error('sourceSilo is required')
  if (!inputVolume || inputVolume <= 0) throw new Error('inputVolume must be greater than 0')

  const existing = await db.MesSeparationBatch.findOne({
    where: { batchId, sourceSilo, batchEnd: batchEnd || null },
  })
  if (existing) {
    console.log(`[MilkMesService] Batch ${batchId} / ${sourceSilo} already processed (status: ${existing.status}) — skipping`)
    return { success: true, duplicate: true, batchId, status: existing.status }
  }

  const inputItem = itemConfig.getItem(itemId, sourceSilo)

  console.log(`[MilkMesService] Processing batch ${batchId} (${sourceSilo} → ${(destinations || []).join(', ')}):`)
  console.log(`  Input: ${inputItem.name} (itemId: ${itemId || 'none'}, transfer: ${transferName || 'none'})`)

  const wasteVolume = inputVolume - (creamVolume || 0) - (skimVolume || 0)
  const wastePercent = inputVolume > 0 ? (wasteVolume / inputVolume) * 100 : 0

  console.log(`  Volumes: input=${inputVolume} LBS, cream=${creamVolume}, skim=${skimVolume}, waste=${wasteVolume.toFixed(1)} (${wastePercent.toFixed(1)}%)`)

  if (wastePercent > itemConfig.WASTE_ALERT_THRESHOLD) {
    console.warn(`[MilkMesService] High waste alert: ${wastePercent.toFixed(1)}% (threshold: ${itemConfig.WASTE_ALERT_THRESHOLD}%)`)
    await core.sendStagingNotification(
      'MES Separation: High Waste Alert',
      `Batch ${batchId} from ${sourceSilo}\nWaste: ${wasteVolume.toFixed(1)} LBS (${wastePercent.toFixed(1)}%)\nThreshold: ${itemConfig.WASTE_ALERT_THRESHOLD}%\nInput: ${inputVolume} | Cream: ${creamVolume} | Skim: ${skimVolume}`
    )
  }

  let record
  try {
    record = await db.MesSeparationBatch.create({
      batchId,
      sourceSilo,
      inputVolume,
      creamVolume: creamVolume || 0,
      skimVolume: skimVolume || 0,
      wasteVolume: parseFloat(wasteVolume.toFixed(2)),
      wastePercent: parseFloat(wastePercent.toFixed(2)),
      batchStart,
      batchEnd,
      transferName: transferName || null,
      destinations: destinations ? JSON.stringify(destinations) : null,
      itemId: itemId || null,
      unit: unit || null,
      targetVolume: targetVolume ?? null,
      status: 'pending',
    })
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      console.log(`[MilkMesService] Batch ${batchId} / ${sourceSilo} lost insert race — skipping`)
      return { success: true, duplicate: true, batchId, status: 'race_dedup' }
    }
    throw err
  }

  let nsResult = null
  try {
    const { cream: creamItem, skim: skimItem } = itemConfig.getOutputItems(sourceSilo)

    const body = {
      item: inputItem.id || undefined,
      quantity: inputVolume,
      location: { id: 23 },
      subsidiary: { id: 2 },
      custbody_milk_source_silo: sourceSilo,
      custbody_milk_batch_start: batchStart,
      custbody_milk_batch_end: batchEnd,
      custbody_milk_transfer_name: transferName || batchId,
      custbody_milk_destinations: (destinations || []).join(', '),
    }

    const componentItems = []
    if (creamItem.id && creamVolume > 0) {
      componentItems.push({
        item: creamItem.id,
        quantity: creamVolume,
        inventoryDetail: {
          inventoryAssignment: { items: [{ quantity: creamVolume }] },
        },
      })
    }
    if (skimItem.id && skimVolume > 0) {
      componentItems.push({
        item: skimItem.id,
        quantity: skimVolume,
        inventoryDetail: {
          inventoryAssignment: { items: [{ quantity: skimVolume }] },
        },
      })
    }
    if (componentItems.length > 0) body.component = { items: componentItems }

    if (config.MES_DRY_RUN) {
      console.log(`[MilkMesService] DRY RUN — batch ${batchId} saved, skipping NS unbuild`)
      await record.update({ status: 'dry_run', processedAt: new Date() })
      await db.MesProcessingLog.create({
        eventType: 'separation_unbuild', sourceId: batchId,
        nsTransactionType: 'assemblyUnbuild', nsTransactionId: null,
        payload: JSON.stringify(data), result: JSON.stringify({ dryRun: true, body }), success: true,
      })
      return { success: true, duplicate: false, batchId, nsTransactionId: null, status: 'dry_run', wastePercent: parseFloat(wastePercent.toFixed(2)) }
    }

    if (!inputItem.id) {
      console.log(`[MilkMesService] No NS item ID for input — skipping unbuild (record saved for later)`)
      await record.update({ status: 'pending_ns', processedAt: new Date() })
      await db.MesProcessingLog.create({
        eventType: 'separation_unbuild', sourceId: batchId,
        nsTransactionType: 'assemblyUnbuild', nsTransactionId: null,
        payload: JSON.stringify(data), result: JSON.stringify({ skipped: 'no NS item ID configured' }), success: true,
      })
      return { success: true, duplicate: false, batchId, nsTransactionId: null, status: 'pending_ns' }
    }

    try {
      nsResult = await core.netsuitePost('/record/v1/assemblyUnbuild', body)
    } catch (err) {
      if (err.message?.includes('404') || err.message?.includes('not found')) {
        console.warn('[MilkMesService] assemblyUnbuild REST endpoint not available, trying RESTlet')
        nsResult = await core.callRestlet('customscript_sa_milk_unbuild', 'customdeploy_sa_milk_unbuild', body)
      } else {
        throw err
      }
    }

    const nsTransactionId = nsResult?.body?.id || nsResult?.body?.unbuildId || nsResult?.id || null

    await record.update({ status: 'completed', nsTransactionId, processedAt: new Date() })
    await db.MesProcessingLog.create({
      eventType: 'separation_unbuild', sourceId: batchId,
      nsTransactionType: 'assemblyUnbuild', nsTransactionId,
      payload: JSON.stringify(data), result: JSON.stringify(nsResult), success: true,
    })

    console.log(`[MilkMesService] Batch ${batchId} completed — NS transaction: ${nsTransactionId}`)
    return { success: true, duplicate: false, batchId, nsTransactionId }

  } catch (err) {
    console.error(`[MilkMesService] Failed to create unbuild for batch ${batchId}:`, err.message)
    await record.update({ status: 'error', errorMessage: err.message, processedAt: new Date() })
    await db.MesProcessingLog.create({
      eventType: 'separation_unbuild', sourceId: batchId,
      nsTransactionType: 'assemblyUnbuild', nsTransactionId: null,
      payload: JSON.stringify(data), result: null, success: false, errorMessage: err.message,
    })
    throw err
  }
}

async function processBulkMilkFlow(data) {
  const { creamVolume, skimVolume } = data

  if (!creamVolume && !skimVolume) {
    return { success: true, message: 'No flow volumes to process' }
  }

  const activeRuns = await db.MesBulkMilkRun.findAll({ where: { status: 'active' } })

  if (activeRuns.length === 0) {
    console.log('[MilkMesService] No active bulk milk runs — skipping flow reading')
    return { success: true, message: 'No active bulk milk runs', issued: 0 }
  }

  const results = []

  for (const run of activeRuns) {
    try {
      const componentItems = []

      if (creamVolume > 0 && itemConfig.CREAM_ITEM.id) {
        componentItems.push({ item: { id: itemConfig.CREAM_ITEM.id }, quantity: creamVolume })
      }
      if (skimVolume > 0 && itemConfig.SKIM_ITEM.id) {
        componentItems.push({ item: { id: itemConfig.SKIM_ITEM.id }, quantity: skimVolume })
      }

      if (componentItems.length === 0) {
        results.push({ workOrderId: run.workOrderId, success: true, skipped: true })
        continue
      }

      const nsResult = await core.netsuitePost(
        `/record/v1/workOrder/${run.workOrderId}/!transform/workOrderIssue`,
        { component: { items: componentItems } }
      )

      await run.update({
        cumulativeCream: parseFloat(run.cumulativeCream) + (creamVolume || 0),
        cumulativeSkim: parseFloat(run.cumulativeSkim) + (skimVolume || 0),
      })

      await db.MesProcessingLog.create({
        eventType: 'bulk_milk_issue', sourceId: run.workOrderId,
        nsTransactionType: 'workOrderIssue', nsTransactionId: nsResult?.id || null,
        payload: JSON.stringify(data), result: JSON.stringify(nsResult), success: true,
      })

      results.push({ workOrderId: run.workOrderId, success: true, issueId: nsResult?.id })
    } catch (err) {
      console.error(`[MilkMesService] Failed to issue to WO ${run.workOrderId}:`, err.message)
      await db.MesProcessingLog.create({
        eventType: 'bulk_milk_issue', sourceId: run.workOrderId,
        nsTransactionType: 'workOrderIssue', nsTransactionId: null,
        payload: JSON.stringify(data), success: false, errorMessage: err.message,
      })
      results.push({ workOrderId: run.workOrderId, success: false, error: err.message })
    }
  }

  return { success: true, issued: results.length, results }
}

async function registerBulkMilkRun(data) {
  const { workOrderId, workOrderNumber, registeredBy } = data

  if (!workOrderId) throw new Error('workOrderId is required')

  const existing = await db.MesBulkMilkRun.findOne({ where: { workOrderId, status: 'active' } })
  if (existing) return { success: true, duplicate: true, run: existing }

  const run = await db.MesBulkMilkRun.create({ workOrderId, workOrderNumber, registeredBy })

  console.log(`[MilkMesService] Registered bulk milk run: WO ${workOrderId} (${workOrderNumber})`)
  return { success: true, duplicate: false, run }
}

async function completeBulkMilkRun(data) {
  const { workOrderId } = data

  if (!workOrderId) throw new Error('workOrderId is required')

  const run = await db.MesBulkMilkRun.findOne({ where: { workOrderId, status: 'active' } })
  if (!run) throw new Error(`No active bulk milk run found for work order ${workOrderId}`)

  await run.update({ status: 'completed', completedAt: new Date() })

  console.log(`[MilkMesService] Completed bulk milk run: WO ${workOrderId} — Cream: ${run.cumulativeCream}, Skim: ${run.cumulativeSkim}`)
  return { success: true, workOrderId, cumulativeCream: parseFloat(run.cumulativeCream), cumulativeSkim: parseFloat(run.cumulativeSkim) }
}

async function getActiveBulkMilkRuns() {
  const runs = await db.MesBulkMilkRun.findAll({ where: { status: 'active' } })
  return { success: true, runs }
}

module.exports = {
  processSeparationBatch,
  processBulkMilkFlow,
  registerBulkMilkRun,
  completeBulkMilkRun,
  getActiveBulkMilkRuns,
}
