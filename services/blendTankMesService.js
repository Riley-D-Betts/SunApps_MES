const core = require('../clients/coreClient')
const itemConfig = require('./mesItemConfig')
const productParser = require('./blendTankProductParser')
const lineMapper = require('./lineIngredientMapper')
const config = require('../config')
const db = require('../models')

async function processWOStart(data) {
  const { tankId, productName, batchSize, fromEntName, toEntName, detectedAt } = data

  if (!tankId) throw new Error('tankId is required')
  if (!productName) throw new Error('productName is required')

  const existing = await db.MesBlendTankBatch.findOne({
    where: { tankId, productName, status: ['active', 'dry_run'] },
  })
  if (existing) {
    console.log(`[BlendTankMesService] "${productName}" on ${tankId} already active (status: ${existing.status}, nsWO: ${existing.nsWorkOrderId || 'none'}) — skipping`)
    return { success: true, duplicate: true, tankId, productName, status: existing.status }
  }

  const COOLDOWN_MINUTES = 5
  const recentBatch = await db.MesBlendTankBatch.findOne({
    where: {
      tankId,
      detectedAt: { [db.Sequelize.Op.gte]: new Date(Date.now() - COOLDOWN_MINUTES * 60 * 1000) },
    },
    order: [['detectedAt', 'DESC']],
  })
  if (recentBatch) {
    const ageSec = Math.round((Date.now() - new Date(recentBatch.detectedAt).getTime()) / 1000)
    console.warn(`[BlendTankMesService] COOLDOWN: "${productName}" on ${tankId} rejected — last batch "${recentBatch.productName}" was ${ageSec}s ago (min ${COOLDOWN_MINUTES * 60}s)`)
    return { success: true, cooldown: true, tankId, productName, lastBatchAge: ageSec }
  }

  const parsed = productParser.parseProductName(productName)
  const assemblyItem = parsed
    ? { id: parsed.nsId, name: parsed.name, confidence: parsed.confidence }
    : { id: null, name: `Unrecognized: "${productName}"`, confidence: 'none' }

  console.log(`[BlendTankMesService] Processing batch start: ${tankId} / "${productName}"`)
  console.log(`  Parsed: ${assemblyItem.name} (NS ${assemblyItem.id}, confidence: ${assemblyItem.confidence})`)
  console.log(`  BatchSize: ${batchSize}, From: ${fromEntName}, To: ${toEntName}`)

  const record = await db.MesBlendTankBatch.create({
    tankId,
    productName,
    mesItem: parsed?.nsId ? String(parsed.nsId) : null,
    batchSize: batchSize || null,
    fromEntName: fromEntName || null,
    toEntName: toEntName || null,
    parserConfidence: assemblyItem.confidence,
    status: 'active',
    detectedAt: detectedAt || new Date(),
  })

  let nsResult = null
  try {
    if (config.MES_DRY_RUN) {
      console.log(`[BlendTankMesService] DRY RUN — "${productName}" saved, skipping NS creation`)
      await record.update({ status: 'dry_run' })
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_wo_create', sourceId: `${tankId}:${productName}`,
        nsTransactionType: 'workOrder', payload: JSON.stringify(data),
        result: JSON.stringify({ dryRun: true, parsed }), success: true,
      })
      return { success: true, duplicate: false, tankId, productName, status: 'dry_run', parsed }
    }

    if (!assemblyItem.id) {
      console.log(`[BlendTankMesService] No NS item for "${productName}" — skipping NS WO creation`)
      await record.update({ status: 'pending_ns' })
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_wo_create', sourceId: `${tankId}:${productName}`,
        nsTransactionType: 'workOrder', payload: JSON.stringify(data),
        result: JSON.stringify({ skipped: 'product not recognized', parsed }), success: true,
      })
      return { success: true, duplicate: false, tankId, productName, status: 'pending_ns', parsed }
    }

    const body = {
      assemblyItem: { id: assemblyItem.id },
      quantity: batchSize || 1,
      location: { id: 23 },
      subsidiary: { id: 2 },
      custbody_mes_tank_id: tankId,
      custbody_mes_product_name: productName,
      custbody_mes_source_entity: fromEntName || null,
      custbody_mes_dest_entity: toEntName || null,
    }

    console.log(`[BlendTankMesService] Creating NS WO for "${productName}" on ${tankId}`)
    nsResult = await core.netsuitePost('/record/v1/workOrder', body)
    console.log(`[BlendTankMesService] NS WO response: status=${nsResult?.status}`)

    let nsWorkOrderId = nsResult?.id || null
    let nsWorkOrderNumber = nsResult?.tranid || null

    if (!nsWorkOrderId && nsResult?.headers?.location) {
      const match = nsResult.headers.location.match(/\/(\d+)$/)
      if (match) {
        nsWorkOrderId = match[1]
        try {
          const woDetail = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?fields=tranId`)
          nsWorkOrderNumber = woDetail?.tranId || woDetail?.tranid || null
        } catch (e) {
          console.warn(`[BlendTankMesService] Could not fetch WO details: ${e.message}`)
        }
      }
    }

    await record.update({ nsWorkOrderId, nsWorkOrderNumber, status: 'active' })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_wo_create', sourceId: `${tankId}:${productName}`,
      nsTransactionType: 'workOrder', nsTransactionId: nsWorkOrderId,
      payload: JSON.stringify(data), result: JSON.stringify(nsResult), success: true,
    })

    console.log(`[BlendTankMesService] "${productName}" → NS WO ${nsWorkOrderNumber} (${nsWorkOrderId})`)
    return { success: true, duplicate: false, tankId, productName, nsWorkOrderId, nsWorkOrderNumber, status: 'active', parsed }

  } catch (err) {
    console.error(`[BlendTankMesService] Failed to create NS WO for "${productName}":`, err.message)
    await record.update({ status: 'error', errorMessage: err.message })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_wo_create', sourceId: `${tankId}:${productName}`,
      nsTransactionType: 'workOrder', payload: JSON.stringify(data), success: false, errorMessage: err.message,
    })
    throw err
  }
}

async function processWOEnd(data) {
  const { tankId, productName, detectedAt } = data

  if (!tankId) throw new Error('tankId is required')

  const where = { tankId, status: 'active' }
  if (productName) where.productName = productName

  const record = await db.MesBlendTankBatch.findOne({ where })

  if (!record) {
    console.log(`[BlendTankMesService] No active batch for ${tankId}${productName ? ` / "${productName}"` : ''} — ignoring end event`)
    return { success: true, message: 'No active batch found' }
  }

  const inflows = await db.MesBlendTankInflow.findAll({
    where: { blendTankBatchId: record.id, status: 'completed' },
  })
  const totalInflowLbs = inflows.reduce((sum, i) => sum + (i.totalLbs || 0), 0)
  const completionQty = totalInflowLbs > 0
    ? Math.round(totalInflowLbs)
    : Math.round(record.batchSize || 1)

  let nsCompletionId = null
  if (record.nsWorkOrderId && completionQty > 0 && !config.MES_DRY_RUN) {
    try {
      const lotNumber = `${tankId}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`
      const qtySource = totalInflowLbs > 0 ? 'inflows' : 'batchSize'

      const body = {
        quantity: completionQty,
        inventorydetail: {
          inventoryassignment: {
            items: [{ quantity: completionQty, receiptInventoryNumber: lotNumber }],
          },
        },
      }

      console.log(`[BlendTankMesService] Completing NS WO ${record.nsWorkOrderId} for "${record.productName}": ${completionQty} LBS (${qtySource}), lot=${lotNumber}`)
      const nsResult = await core.netsuitePost(
        `/record/v1/workOrder/${record.nsWorkOrderId}/!transform/workOrderCompletion`,
        body
      )

      if (nsResult?.headers?.location) {
        const match = nsResult.headers.location.match(/\/(\d+)$/)
        if (match) nsCompletionId = match[1]
      }
      if (!nsCompletionId && nsResult?.id) nsCompletionId = nsResult.id

      console.log(`[BlendTankMesService] WO ${record.nsWorkOrderNumber || record.nsWorkOrderId} completed: ${completionQty} LBS → completion ${nsCompletionId}`)
    } catch (err) {
      console.error(`[BlendTankMesService] Failed to complete NS WO ${record.nsWorkOrderId}:`, err.message)
    }
  } else if (record.nsWorkOrderId && !completionQty) {
    console.log(`[BlendTankMesService] No completion quantity for batch "${record.productName}" on ${tankId} — skipping NS completion`)
  }

  await record.update({ status: 'completed', completedAt: detectedAt || new Date() })
  await db.MesProcessingLog.create({
    eventType: 'blend_tank_wo_complete', sourceId: `${tankId}:${record.productName}`,
    nsTransactionType: 'workOrderCompletion', nsTransactionId: nsCompletionId || record.nsWorkOrderId,
    payload: JSON.stringify(data), result: JSON.stringify({ completed: true, totalInflowLbs, nsCompletionId }), success: true,
  })

  console.log(`[BlendTankMesService] Batch "${record.productName}" on ${tankId} completed (${Math.round(totalInflowLbs).toLocaleString()} LBS from ${inflows.length} inflow(s))`)
  return { success: true, tankId, productName: record.productName, status: 'completed', totalInflowLbs, nsCompletionId }
}

async function processLineFlow(data) {
  const { line, totalLbs, lineProductName, ingredientType, siloName, destination, resetTime } = data

  if (!line) throw new Error('line is required')
  if (!totalLbs || totalLbs <= 0) throw new Error('totalLbs must be greater than 0')

  if (resetTime) {
    const existing = await db.MesBlendTankInflow.findOne({ where: { line, resetTime } })
    if (existing) {
      console.log(`[BlendTankMesService] Duplicate line-flow for ${line} at ${resetTime} — returning existing (id=${existing.id}, status=${existing.status})`)
      return { success: true, duplicate: true, inflowId: existing.id, status: existing.status }
    }
  }

  const activeBatches = await db.MesBlendTankBatch.findAll({ where: { status: 'active' } })

  if (activeBatches.length === 0) {
    console.log(`[BlendTankMesService] No active blend tank batches — saving line flow as unmatched`)
    const record = await db.MesBlendTankInflow.create({
      line, ingredientType: lineProductName || ingredientType || 'unknown', totalLbs, status: 'unmatched', resetTime,
    })
    return { success: true, message: 'No active batch', inflowId: record.id }
  }

  let targetBatch = null
  if (destination) {
    const destNorm = destination.toLowerCase().replace(/[^a-z0-9]/g, '')
    targetBatch = activeBatches.find(b => {
      const tankNorm = b.tankId.toLowerCase().replace(/[^a-z0-9]/g, '')
      return tankNorm === destNorm || tankNorm.includes(destNorm) || destNorm.includes(tankNorm)
    })
    if (!targetBatch) {
      console.warn(`[BlendTankMesService] Destination "${destination}" doesn't match any active batch — falling back`)
    }
  }

  if (!targetBatch) {
    targetBatch = activeBatches[0]
    if (activeBatches.length > 1) {
      console.warn(`[BlendTankMesService] ${activeBatches.length} active batches, no destination match — assigning ${line} flow to ${targetBatch.tankId} (first match)`)
    }
  } else {
    console.log(`[BlendTankMesService] Routed ${line} flow to ${targetBatch.tankId} via destination "${destination}"`)
  }

  let componentItem = null
  let resolvedFrom = 'none'

  if (lineProductName) {
    componentItem = lineMapper.resolveLineProduct(lineProductName)
    if (componentItem) {
      resolvedFrom = 'scada'
      console.log(`[BlendTankMesService] Resolved "${lineProductName}" → ${componentItem.name} (NS ${componentItem.id})`)
    }
  }

  if (!componentItem && ingredientType) {
    componentItem = ingredientType === 'cream' ? itemConfig.CREAM_ITEM_CONV : itemConfig.SKIM_ITEM_CONV
    resolvedFrom = 'legacy'
    console.log(`[BlendTankMesService] Legacy fallback: ${ingredientType} → ${componentItem.name} (NS ${componentItem.id})`)
  }

  if (!componentItem) {
    componentItem = line.startsWith('CL') ? itemConfig.CREAM_ITEM_CONV : itemConfig.SKIM_ITEM_CONV
    resolvedFrom = 'line-prefix'
    console.log(`[BlendTankMesService] Line-prefix fallback: ${line} → ${componentItem.name} (NS ${componentItem.id})`)
  }

  const inflowRecord = await db.MesBlendTankInflow.create({
    blendTankBatchId: targetBatch.id,
    line,
    ingredientType: lineProductName || ingredientType || (line.startsWith('CL') ? 'cream' : 'skim'),
    totalLbs,
    nsItemId: componentItem.id ? String(componentItem.id) : null,
    status: 'pending',
    resetTime,
  })

  try {
    if (config.MES_DRY_RUN) {
      console.log(`[BlendTankMesService] DRY RUN — line ${line} flow saved, skipping NS issue`)
      await inflowRecord.update({ status: 'dry_run' })
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_line_issue', sourceId: targetBatch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue', payload: JSON.stringify(data),
        result: JSON.stringify({ dryRun: true, resolvedFrom, componentItem }), success: true,
      })
      return { success: true, inflowId: inflowRecord.id, status: 'dry_run' }
    }

    if (!targetBatch.nsWorkOrderId || !componentItem.id) {
      console.log(`[BlendTankMesService] Missing NS WO ID or component item — saving for later`)
      await inflowRecord.update({ status: 'pending_ns' })
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_line_issue', sourceId: targetBatch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue', payload: JSON.stringify(data),
        result: JSON.stringify({ skipped: 'no NS WO or item ID', resolvedFrom }), success: true,
      })
      return { success: true, inflowId: inflowRecord.id, status: 'pending_ns' }
    }

    const body = {
      component: {
        items: [{ item: { id: String(componentItem.id) }, quantity: totalLbs }],
      },
    }

    console.log(`[BlendTankMesService] Issuing ${totalLbs.toFixed(1)} LBS "${lineProductName || ingredientType}" (${line}, resolved=${resolvedFrom}) to NS WO ${targetBatch.nsWorkOrderId}`)
    const nsResult = await core.netsuitePost(
      `/record/v1/workOrder/${targetBatch.nsWorkOrderId}/!transform/workOrderIssue`,
      body
    )

    let nsIssueId = nsResult?.id || null
    if (!nsIssueId && nsResult?.headers?.location) {
      const match = nsResult.headers.location.match(/\/(\d+)$/)
      if (match) nsIssueId = match[1]
    }

    await inflowRecord.update({ nsIssueId, status: 'completed' })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_line_issue', sourceId: targetBatch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue', nsTransactionId: nsIssueId,
      payload: JSON.stringify(data), result: JSON.stringify({ nsIssueId, resolvedFrom, componentItem: componentItem.name }), success: true,
    })

    console.log(`[BlendTankMesService] Issued ${totalLbs.toFixed(1)} LBS "${lineProductName || ingredientType}" (${line}) → NS WO ${targetBatch.nsWorkOrderNumber || targetBatch.nsWorkOrderId} (issue ${nsIssueId})`)
    return { success: true, inflowId: inflowRecord.id, nsIssueId, status: 'completed' }

  } catch (err) {
    console.error(`[BlendTankMesService] Failed to issue ${line} flow:`, err.message)
    await inflowRecord.update({ status: 'error', errorMessage: err.message })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_line_issue', sourceId: targetBatch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue', payload: JSON.stringify(data), success: false, errorMessage: err.message,
    })
    // Return success so MES_Service doesn't retry — inflow is saved, dedup will catch retries
    return { success: true, inflowId: inflowRecord.id, status: 'error', error: err.message }
  }
}

async function getActiveBatches() {
  const batches = await db.MesBlendTankBatch.findAll({
    where: { status: 'active' },
    order: [['createdAt', 'DESC']],
  })
  return { success: true, batches }
}

async function getBatchComponents(batchId) {
  const batch = await db.MesBlendTankBatch.findByPk(batchId)
  if (!batch) throw new Error(`Batch ${batchId} not found`)

  const inflows = await db.MesBlendTankInflow.findAll({
    where: { blendTankBatchId: batchId },
    order: [['createdAt', 'ASC']],
  })

  let bomComponents = []
  if (batch.nsWorkOrderId && !config.MES_DRY_RUN) {
    try {
      const nsResult = await core.netsuiteGet(`/record/v1/workOrder/${batch.nsWorkOrderId}?expandSubResources=true`)
      bomComponents = nsResult?.component?.items || []
    } catch (err) {
      console.error('[BlendTankMesService] Failed to fetch NS WO components:', err.message)
    }
  }

  return { success: true, batch, bomComponents, inflows }
}

async function issueIngredient(batchId, data) {
  const { nsItemId, quantity, lot } = data

  if (!nsItemId) throw new Error('nsItemId is required')
  if (!quantity || quantity <= 0) throw new Error('quantity must be greater than 0')

  const batch = await db.MesBlendTankBatch.findByPk(batchId)
  if (!batch) throw new Error(`Batch ${batchId} not found`)
  if (!batch.nsWorkOrderId) throw new Error(`Batch ${batchId} has no NS work order — cannot issue`)

  const componentItem = { item: { id: String(nsItemId) }, quantity }
  if (lot) {
    componentItem.inventoryDetail = {
      inventoryAssignment: { items: [{ issueInventoryNumber: { id: lot }, quantity }] },
    }
  }

  const nsResult = await core.netsuitePost(
    `/record/v1/workOrder/${batch.nsWorkOrderId}/!transform/workOrderIssue`,
    { component: { items: [componentItem] } }
  )

  const nsIssueId = nsResult?.id || null

  await db.MesProcessingLog.create({
    eventType: 'blend_tank_manual_issue', sourceId: batch.nsWorkOrderId,
    nsTransactionType: 'workOrderIssue', nsTransactionId: nsIssueId,
    payload: JSON.stringify({ batchId, ...data }), result: JSON.stringify(nsResult), success: true,
  })

  console.log(`[BlendTankMesService] Manual issue to WO ${batch.nsWorkOrderId}: item ${nsItemId}, qty ${quantity}`)
  return { success: true, nsIssueId }
}

async function clearStaleBatches() {
  const stale = await db.MesBlendTankBatch.findAll({
    where: { status: ['active', 'dry_run'], nsWorkOrderId: null },
  })

  for (const batch of stale) {
    console.log(`[BlendTankMesService] Cancelling stale batch: ${batch.tankId} / "${batch.productName}" (id=${batch.id})`)
    await batch.update({ status: 'cancelled', completedAt: new Date() })
  }

  console.log(`[BlendTankMesService] Cleared ${stale.length} stale batch(es)`)
  return { success: true, cleared: stale.length }
}

module.exports = {
  processWOStart,
  processWOEnd,
  processLineFlow,
  getActiveBatches,
  getBatchComponents,
  issueIngredient,
  clearStaleBatches,
}
