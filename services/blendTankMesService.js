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

/**
 * End-of-batch handler — fired when the blend tank empties or product clears.
 *
 * The tick has been firing incremental issues + completions throughout the
 * batch's life, so by the time we get here cumulativeIssued and
 * cumulativeCompleted are already populated. We just need to flush any final
 * delta (one last completion) and close the batch.
 */
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

  // Rollover safety: batches that were started under the legacy code path
  // (before the tick existed) have cumulativeIssuedLbs=0 because nothing has
  // been incrementing it. Their issue history lives in MesBlendTankInflow
  // rows with status='completed'. If we don't backfill, tickCompletionForBatch
  // will compute target=0 and the batch will close with no FG completion.
  if ((parseFloat(record.cumulativeIssuedLbs) || 0) === 0) {
    const legacyIssued = await db.MesBlendTankInflow.sum('totalLbs', {
      where: { blendTankBatchId: record.id, status: 'completed' },
    }) || 0
    if (legacyIssued > 0) {
      console.log(`[BlendTankMesService] Backfilling cumulativeIssuedLbs from legacy inflows for batch ${record.id}: ${legacyIssued.toFixed(1)} lb`)
      await record.update({ cumulativeIssuedLbs: legacyIssued })
      await record.reload()
    }
  }

  const flushed = await tickCompletionForBatch(record).catch(err => {
    console.error(`[BlendTankMesService] Final completion flush failed for ${tankId}:`, err.message)
    return false
  })
  await record.reload()

  await record.update({ status: 'completed', completedAt: detectedAt || new Date() })
  await db.MesProcessingLog.create({
    eventType: 'blend_tank_wo_complete',
    sourceId: `${tankId}:${record.productName}`,
    nsTransactionType: 'workOrderCompletion',
    nsTransactionId: record.nsWorkOrderId,
    payload: JSON.stringify(data),
    result: JSON.stringify({
      completed: true,
      cumulativeIssuedLbs: parseFloat(record.cumulativeIssuedLbs) || 0,
      cumulativeCompletedLbs: parseFloat(record.cumulativeCompletedLbs) || 0,
      finalCompletionFired: flushed,
    }),
    success: true,
  })

  console.log(`[BlendTankMesService] Batch "${record.productName}" on ${tankId} closed — issued ${parseFloat(record.cumulativeIssuedLbs).toFixed(0)} lb, completed ${parseFloat(record.cumulativeCompletedLbs).toFixed(0)} lb`)
  return {
    success: true,
    tankId,
    productName: record.productName,
    status: 'completed',
    cumulativeIssuedLbs: parseFloat(record.cumulativeIssuedLbs) || 0,
    cumulativeCompletedLbs: parseFloat(record.cumulativeCompletedLbs) || 0,
  }
}

/**
 * Legacy event-based handler — fired by blendTankJob on totalizer reset.
 *
 * Previously this path POSTed a workOrderIssue for the entire reset value.
 * That's now done by the tick (issueCompletionJob), which fires one issue per
 * totalizer delta on a steady cadence. This handler now ONLY records the
 * reset event in MesBlendTankInflow for traceability — it does not call NS.
 *
 * Net effect: ongoing inflow accounting lives in the tick. The legacy event
 * is a breadcrumb so debugging "why did this batch end" is easier — it shows
 * the totalizer-reset event that the tick alone wouldn't surface.
 */
async function processLineFlow(data) {
  const { line, totalLbs, lineProductName, ingredientType, siloName, destination, resetTime } = data

  if (!line) throw new Error('line is required')
  if (!totalLbs || totalLbs <= 0) return { success: true, skipped: 'no flow' }

  if (resetTime) {
    const existing = await db.MesBlendTankInflow.findOne({ where: { line, resetTime } })
    if (existing) {
      return { success: true, duplicate: true, inflowId: existing.id, status: existing.status }
    }
  }

  const activeBatches = await db.MesBlendTankBatch.findAll({ where: { status: 'active' } })
  let targetBatch = null
  if (activeBatches.length > 0) {
    if (destination) {
      const destNorm = destination.toLowerCase().replace(/[^a-z0-9]/g, '')
      targetBatch = activeBatches.find(b => {
        const tankNorm = b.tankId.toLowerCase().replace(/[^a-z0-9]/g, '')
        return tankNorm === destNorm || tankNorm.includes(destNorm) || destNorm.includes(tankNorm)
      })
    }
    if (!targetBatch) targetBatch = activeBatches[0]
  }

  const record = await db.MesBlendTankInflow.create({
    blendTankBatchId: targetBatch?.id ?? null,
    line,
    ingredientType: lineProductName || ingredientType || (line.startsWith('CL') ? 'cream' : 'skim'),
    totalLbs,
    nsItemId: null,
    status: targetBatch ? 'reset_event' : 'unmatched',
    resetTime,
  })

  console.log(`[BlendTankMesService] Recorded line reset for ${line} (${totalLbs.toFixed(1)} lb, batch=${targetBatch?.tankId || 'unmatched'}) — NS issue handled by tick`)
  return { success: true, inflowId: record.id, status: record.status }
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
  const { nsItemId, quantity, lot, siloName, binId: explicitBinId } = data

  if (!nsItemId) throw new Error('nsItemId is required')
  if (!quantity || quantity <= 0) throw new Error('quantity must be greater than 0')

  const batch = await db.MesBlendTankBatch.findByPk(batchId)
  if (!batch) throw new Error(`Batch ${batchId} not found`)
  if (!batch.nsWorkOrderId) throw new Error(`Batch ${batchId} has no NS work order — cannot issue`)

  const resolvedBinId = explicitBinId || (siloName ? itemConfig.getBinId(siloName) : null)

  const inventoryDetailItems = [{ quantity }]
  if (lot) inventoryDetailItems[0].issueinventorynumber = { id: lot }
  if (resolvedBinId) inventoryDetailItems[0].binnumber = { id: resolvedBinId }

  const itemEntry = { item: { id: nsItemId }, quantity }
  if (lot || resolvedBinId) {
    itemEntry.inventorydetail = { inventoryassignment: { items: inventoryDetailItems } }
  }

  const body = {
    transaction: { id: batch.nsWorkOrderId },
    item: { items: [itemEntry] },
  }

  const nsResult = await core.netsuitePost('/record/v1/workOrderIssue', body)

  let nsIssueId = nsResult?.id || null
  if (!nsIssueId && nsResult?.headers?.location) {
    const match = nsResult.headers.location.match(/\/(\d+)$/)
    if (match) nsIssueId = match[1]
  }

  await db.MesProcessingLog.create({
    eventType: 'blend_tank_manual_issue', sourceId: batch.nsWorkOrderId,
    nsTransactionType: 'workOrderIssue', nsTransactionId: nsIssueId,
    payload: JSON.stringify({ batchId, ...data }), result: JSON.stringify(nsResult), success: true,
  })

  console.log(`[BlendTankMesService] Manual issue to WO ${batch.nsWorkOrderId}: item ${nsItemId}, qty ${quantity}`)
  return { success: true, nsIssueId }
}

/**
 * Resolve the NS component item for a line reading. Prefer the historian-reported
 * product name (most accurate), fall back to line prefix (CL = cream, ML = skim).
 */
function resolveLineComponent(reading) {
  if (reading.productName) {
    const m = lineMapper.resolveLineProduct(reading.productName)
    if (m) return { ...m, resolvedFrom: 'scada' }
  }
  const fallback = reading.line.startsWith('CL') ? itemConfig.CREAM_ITEM_CONV : itemConfig.SKIM_ITEM_CONV
  return { ...fallback, resolvedFrom: 'line-prefix' }
}

/**
 * Match a line reading to one active batch. For real blend tanks (BlendTank1A
 * etc.) we match on `requestedBy`. For UHT-direct virtual batches the tankId is
 * encoded as "{line}→{destination}", so we match on the line itself.
 */
function findBatchForLine(reading, activeBatches) {
  for (const batch of activeBatches) {
    if (batch.tankId.startsWith(`${reading.line}→`)) return batch
  }
  if (!reading.requestedBy) return null
  const destNorm = reading.requestedBy.toLowerCase().replace(/[^a-z0-9]/g, '')
  for (const batch of activeBatches) {
    const tankNorm = batch.tankId.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (tankNorm === destNorm || tankNorm.includes(destNorm) || destNorm.includes(tankNorm)) return batch
  }
  return null
}

/**
 * One tick. For every active blend tank batch:
 *   1. Read current line totalizers from historian.
 *   2. For each line feeding this batch, fire a workOrderIssue for the delta
 *      since the last tick (or batch start). Update MesPipeIssueState.
 *   3. After issues, fire a workOrderCompletion for any unaccounted-for
 *      cumulative inflow (mass-balance accounting). Many small completions
 *      sum to the batch total — this is intentional, matches SunTado practice.
 *
 * Returns { batchesProcessed, issuesFired, completionsFired, errors }.
 */
async function tickAllActiveBatches(historian) {
  const activeBatches = await db.MesBlendTankBatch.findAll({ where: { status: 'active' } })
  const summary = { batchesProcessed: 0, issuesFired: 0, completionsFired: 0, errors: [] }
  if (activeBatches.length === 0) return summary

  let lineReadings
  try {
    lineReadings = await historian.getMilkLineStatus()
  } catch (err) {
    console.error('[BlendTankMesService] tick: getMilkLineStatus failed:', err.message)
    summary.errors.push({ phase: 'historian', error: err.message })
    return summary
  }

  for (const batch of activeBatches) {
    summary.batchesProcessed++
    try {
      const issued = await tickIssuesForBatch(batch, lineReadings)
      summary.issuesFired += issued
    } catch (err) {
      console.error(`[BlendTankMesService] tick issues failed for batch ${batch.id} (${batch.tankId}):`, err.message)
      summary.errors.push({ phase: 'issues', batchId: batch.id, error: err.message })
    }
    try {
      // Reload to pick up cumulativeIssuedLbs increments from the issue phase
      await batch.reload()
      const completed = await tickCompletionForBatch(batch)
      if (completed) summary.completionsFired++
    } catch (err) {
      console.error(`[BlendTankMesService] tick completion failed for batch ${batch.id} (${batch.tankId}):`, err.message)
      summary.errors.push({ phase: 'completion', batchId: batch.id, error: err.message })
    }
  }

  return summary
}

async function tickIssuesForBatch(batch, lineReadings) {
  const matchingLines = lineReadings.filter(r => findBatchForLine(r, [batch]) !== null)
  if (matchingLines.length === 0) return 0

  let issuesFired = 0

  for (const reading of matchingLines) {
    const observedAt = new Date()

    let pipeState = await db.MesPipeIssueState.findOne({
      where: { blendTankBatchId: batch.id, line: reading.line },
    })
    if (!pipeState) {
      pipeState = await db.MesPipeIssueState.create({
        blendTankBatchId: batch.id,
        line: reading.line,
        lastIssuedTotalizerLbs: 0,
        lastTotalizerLbs: reading.totalizerLbs,
        lastObservedAt: observedAt,
      })
    }

    const lastIssued = parseFloat(pipeState.lastIssuedTotalizerLbs) || 0
    let delta
    if (reading.totalizerLbs >= lastIssued) {
      delta = reading.totalizerLbs - lastIssued
    } else {
      // Totalizer reset between ticks (totalizer wraps to 0 at batch end). The
      // pre-reset growth is lost to us — only issue the post-reset value.
      delta = reading.totalizerLbs
      console.warn(`[BlendTankMesService] tick: ${reading.line} totalizer reset between ticks (was ${lastIssued.toFixed(1)}, now ${reading.totalizerLbs.toFixed(1)}) — issuing post-reset value only`)
    }

    // Update the always-track-rate fields even when we don't fire an issue, so
    // the frontend has a fresh "current totalizer" snapshot.
    await pipeState.update({
      lastTotalizerLbs: reading.totalizerLbs,
      lastObservedAt: observedAt,
    })

    if (delta < config.MES_MIN_ISSUE_LBS) continue
    if (config.MES_DRY_RUN) {
      await pipeState.update({ lastIssuedTotalizerLbs: reading.totalizerLbs, lastIssueAt: observedAt })
      await batch.increment({ cumulativeIssuedLbs: delta })
      await batch.update({ lastIssueAt: observedAt })
      console.log(`[BlendTankMesService] DRY RUN tick issue ${reading.line} → ${batch.tankId}: ${delta.toFixed(1)} lb`)
      continue
    }
    if (!batch.nsWorkOrderId) {
      console.log(`[BlendTankMesService] tick: batch ${batch.id} has no NS WO — skipping ${reading.line} delta ${delta.toFixed(1)}`)
      continue
    }

    const component = resolveLineComponent(reading)
    if (!component.id) {
      console.warn(`[BlendTankMesService] tick: no NS item for "${reading.productName}" on ${reading.line} — skipping`)
      continue
    }
    const binId = itemConfig.getBinId(reading.siloName)
    if (!binId) {
      console.warn(`[BlendTankMesService] tick: no bin for silo "${reading.siloName}" on ${reading.line} — skipping (delta ${delta.toFixed(1)})`)
      continue
    }

    const body = {
      transaction: { id: batch.nsWorkOrderId },
      item: {
        items: [{
          item: { id: component.id },
          quantity: delta,
          inventorydetail: {
            inventoryassignment: {
              items: [{ quantity: delta, binnumber: { id: binId } }],
            },
          },
        }],
      },
    }

    try {
      console.log(`[BlendTankMesService] tick issue ${reading.line} → WO ${batch.nsWorkOrderId} (${batch.tankId}): ${delta.toFixed(1)} lb "${reading.productName || component.name}" (NS ${component.id}, ${component.resolvedFrom})`)
      const nsResult = await core.netsuitePost('/record/v1/workOrderIssue', body)

      let nsIssueId = nsResult?.id || null
      if (!nsIssueId && nsResult?.headers?.location) {
        const m = nsResult.headers.location.match(/\/(\d+)$/)
        if (m) nsIssueId = m[1]
      }

      // Persist baseline + cumulative totals only after NS confirms the issue
      await pipeState.update({ lastIssuedTotalizerLbs: reading.totalizerLbs, lastIssueAt: observedAt })
      await batch.increment({ cumulativeIssuedLbs: delta })
      await batch.update({ lastIssueAt: observedAt })

      // Record the issue against MesBlendTankInflow for traceability (mirrors
      // the legacy event-based path so historical queries still see all flows)
      await db.MesBlendTankInflow.create({
        blendTankBatchId: batch.id,
        line: reading.line,
        ingredientType: reading.productName || (reading.line.startsWith('CL') ? 'cream' : 'skim'),
        totalLbs: delta,
        nsItemId: String(component.id),
        nsIssueId: nsIssueId ? String(nsIssueId) : null,
        status: 'completed',
        resetTime: observedAt,
      })

      await db.MesProcessingLog.create({
        eventType: 'blend_tank_tick_issue',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue',
        nsTransactionId: nsIssueId,
        payload: JSON.stringify({ batchId: batch.id, line: reading.line, delta, totalizer: reading.totalizerLbs, component }),
        result: JSON.stringify({ nsIssueId }),
        success: true,
      })

      issuesFired++
    } catch (err) {
      console.error(`[BlendTankMesService] tick issue failed for ${reading.line} → WO ${batch.nsWorkOrderId}:`, err.message)
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_tick_issue',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue',
        payload: JSON.stringify({ batchId: batch.id, line: reading.line, delta, totalizer: reading.totalizerLbs }),
        success: false,
        errorMessage: err.message,
      })
      // Don't update the baseline — the same delta will retry on next tick
    }
  }

  return issuesFired
}

async function tickCompletionForBatch(batch) {
  const cumulativeIssued = parseFloat(batch.cumulativeIssuedLbs) || 0
  const cumulativeCompleted = parseFloat(batch.cumulativeCompletedLbs) || 0
  const target = cumulativeIssued - cumulativeCompleted

  if (target < config.MES_MIN_COMPLETION_LBS) return false
  if (config.MES_DRY_RUN) {
    await batch.update({ cumulativeCompletedLbs: cumulativeIssued, lastCompletionAt: new Date() })
    console.log(`[BlendTankMesService] DRY RUN tick completion ${batch.tankId}: ${target.toFixed(1)} lb`)
    return true
  }
  if (!batch.nsWorkOrderId) return false

  // Same destination-bin logic as processWOEnd: UHT-direct WOs land in a surge
  // tank (toEntName = ST81-84); blend tanks land in the tank itself.
  const completionDest = (batch.toEntName && /^ST\d+$/.test(batch.toEntName))
    ? batch.toEntName
    : batch.tankId
  const completionBinId = itemConfig.getBinId(completionDest)
  const lotNumber = `${batch.tankId.replace(/[→\s]/g, '_')}-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}`

  const completionItem = { quantity: target, receiptInventoryNumber: lotNumber }
  if (completionBinId) {
    completionItem.binnumber = { id: completionBinId }
  } else {
    console.warn(`[BlendTankMesService] tick completion: no NS bin for "${completionDest}" — completing without bin`)
  }

  const body = {
    quantity: target,
    inventorydetail: {
      inventoryassignment: {
        items: [completionItem],
      },
    },
  }

  try {
    console.log(`[BlendTankMesService] tick completion WO ${batch.nsWorkOrderId} (${batch.tankId}): ${target.toFixed(1)} lb (cumulative ${cumulativeCompleted.toFixed(1)} → ${cumulativeIssued.toFixed(1)})`)
    const nsResult = await core.netsuitePost(
      `/record/v1/workOrder/${batch.nsWorkOrderId}/!transform/workOrderCompletion`,
      body
    )

    let nsCompletionId = nsResult?.id || null
    if (!nsCompletionId && nsResult?.headers?.location) {
      const m = nsResult.headers.location.match(/\/(\d+)$/)
      if (m) nsCompletionId = m[1]
    }

    await batch.update({
      cumulativeCompletedLbs: cumulativeIssued,
      lastCompletionAt: new Date(),
    })

    await db.MesProcessingLog.create({
      eventType: 'blend_tank_tick_completion',
      sourceId: batch.nsWorkOrderId,
      nsTransactionType: 'workOrderCompletion',
      nsTransactionId: nsCompletionId,
      payload: JSON.stringify({ batchId: batch.id, target, cumulativeIssued, cumulativeCompleted }),
      result: JSON.stringify({ nsCompletionId }),
      success: true,
    })
    return true
  } catch (err) {
    console.error(`[BlendTankMesService] tick completion failed for WO ${batch.nsWorkOrderId}:`, err.message)
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_tick_completion',
      sourceId: batch.nsWorkOrderId,
      nsTransactionType: 'workOrderCompletion',
      payload: JSON.stringify({ batchId: batch.id, target, cumulativeIssued, cumulativeCompleted }),
      success: false,
      errorMessage: err.message,
    })
    return false
  }
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
  tickAllActiveBatches,
  clearStaleBatches,
}
