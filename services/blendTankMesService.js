const core = require('../clients/coreClient')
const itemConfig = require('./mesItemConfig')
const productParser = require('./blendTankProductParser')
const lineMapper = require('./lineIngredientMapper')
const nsInventory = require('./nsInventoryLookup')
const inventoryAdjustment = require('./inventoryAdjustmentService')
const config = require('../config')
const db = require('../models')
const clock = require('../sim/clock')

// Per-process BOM cache keyed by nsWorkOrderId. Fetched once per WO and reused
// across ticks. Cleared when the batch closes.
const _bomCache = new Map()

async function fetchWoBomLines(nsWorkOrderId) {
  if (_bomCache.has(nsWorkOrderId)) return _bomCache.get(nsWorkOrderId)
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const lines = (wo?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id) }))
  console.log(`[BlendTankMesService] BOM for WO ${nsWorkOrderId}: ${lines.map(l => `line${l.line}=item${l.itemId}`).join(', ') || '(empty)'}`)
  _bomCache.set(nsWorkOrderId, lines)
  return lines
}

function clearBomCache(nsWorkOrderId) {
  _bomCache.delete(nsWorkOrderId)
}

// If targetItemId isn't already on the WO BOM, PATCH the WO to append it at
// qty=0, then refetch to pick up the line number NS assigned. Mutates the
// passed-in bomLines array (and the cache) in place so subsequent issues in
// the same tick see the new line.
// Lifted from scripts/recoverBlendTank2AFill.js — same recipe that produced
// the dynamic raw-FG line operators have been seeing on existing WOs.
async function ensureItemOnWoBom(nsWorkOrderId, targetItemId, bomLines) {
  const targetIdStr = String(targetItemId)
  const existing = bomLines.find(c => String(c.itemId) === targetIdStr)
  if (existing) return existing

  console.log(`[BlendTankMesService] Item ${targetIdStr} not on WO ${nsWorkOrderId} BOM (lines: ${bomLines.map(b => b.itemId).join(', ') || '(empty)'}) — PATCHing to append`)
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const merged = (wo?.item?.items || []).map(c => ({
    item: { id: String(c.item?.id) },
    quantity: c.quantity,
    ...(c.units?.id ? { units: { id: String(c.units.id) } } : {}),
  }))
  merged.push({ item: { id: targetIdStr }, quantity: 0 })
  await core.netsuitePatch(`/record/v1/workOrder/${nsWorkOrderId}`, { item: { items: merged } })

  const refetched = (await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?expandSubResources=true`))?.body
  const newLines = (refetched?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id) }))
  const newRow = newLines.find(c => c.itemId === targetIdStr)
  if (!newRow) throw new Error(`PATCH appended item ${targetIdStr} to WO ${nsWorkOrderId} but it didn't appear on refetch`)
  console.log(`[BlendTankMesService] Item ${targetIdStr} added to WO ${nsWorkOrderId} at line ${newRow.line}`)

  _bomCache.set(nsWorkOrderId, newLines)
  bomLines.length = 0
  bomLines.push(...newLines)
  return newRow
}

// Build the transform body for a workOrderIssue that issues quantity lbs of
// one component (the "target" item) against the named WO BOM line. Returns
// { body, allocations } — body goes to NS, allocations carries per-(lot,bin)
// breakdown for logging / audit.
//
// All non-target BOM lines are OMITTED from the items array entirely. NS's
// transform endpoint auto-populates default qty for unspecified lines but
// only validates lines we touch; sending them at qty=0 (with or without
// empty inventoryassignment) makes NS demand inventory detail for any
// lot/bin tracked aux lines (vitamins, citrate, etc.) and reject the issue
// before getting to inventory-quantity validation.
//
// Field names + ID shape follow what NS actually accepts on this endpoint
// (verified by scripts/probeLotShape.js on 2026-05-19):
//   - lowercase componentinventorydetail / inventoryassignment
//   - raw string IDs for issueinventorynumber / binnumber (no { id } wrapping)
//   - status: 1 ("Good") — silently ignored, kept for parity with manufacturing
//
// See [[ns-wo-issue-shape]] and [[lot-tracked-bom-components]] memories.
async function buildWoIssueBody(nsWorkOrderId, targetItemId, quantity, preferredBinId, bomLines) {
  const tracking = await nsInventory.getItemTracking(targetItemId)
  const targetLine = await ensureItemOnWoBom(nsWorkOrderId, targetItemId, bomLines)

  let allocations = null
  let resolvedBinId = preferredBinId
  if (tracking.isLot) {
    allocations = await nsInventory.findInventoryAllocations(targetItemId, quantity, preferredBinId)
    let allocatedQty = allocations.reduce((s, a) => s + a.qty, 0)
    if (allocatedQty + 1e-6 < quantity) {
      const shortfall = quantity - allocatedQty
      const adjusted = await tryShortfallAutoAdjust({ nsWorkOrderId, targetItemId, preferredBinId, shortfall })
      if (adjusted) {
        allocations = await nsInventory.findInventoryAllocations(targetItemId, quantity, preferredBinId)
        allocatedQty = allocations.reduce((s, a) => s + a.qty, 0)
      }
      if (allocatedQty + 1e-6 < quantity) {
        const err = new Error(`Insufficient inventory for item ${targetItemId}: need ${quantity}, found ${allocatedQty} across ${allocations.length} lot(s)`)
        err.code = 'INSUFFICIENT_INVENTORY'
        err.itemId = targetItemId
        err.needed = quantity
        err.available = allocatedQty
        err.allocations = allocations
        throw err
      }
    }
  } else if (tracking.useBins) {
    resolvedBinId = await nsInventory.findBinForItem(targetItemId, preferredBinId)
    if (!resolvedBinId) {
      // No bin has on-hand stock anywhere. If the caller named a preferred bin
      // (typical: source silo/tank), bump it up by exactly the shortfall so
      // the next NS issue posts. With no preferred bin we don't know which
      // bin to credit, so just throw — the caller decides whether to retry.
      const adjusted = preferredBinId
        ? await tryShortfallAutoAdjust({ nsWorkOrderId, targetItemId, preferredBinId, shortfall: quantity })
        : false
      if (adjusted) {
        resolvedBinId = await nsInventory.findBinForItem(targetItemId, preferredBinId)
      }
      if (!resolvedBinId) {
        const err = new Error(`Insufficient inventory for item ${targetItemId}: no on-hand stock found in any bin at this location`)
        err.code = 'INSUFFICIENT_INVENTORY'
        err.itemId = targetItemId
        err.needed = quantity
        err.available = 0
        throw err
      }
    }
  }

  const assignmentItems = nsInventory.buildAssignmentItems(tracking, quantity, allocations, resolvedBinId)

  const componentEntry = { lineNumber: targetLine.line, quantity }
  if (assignmentItems && assignmentItems.length > 0) {
    componentEntry.componentinventorydetail = {
      inventoryassignment: { items: assignmentItems },
    }
  }

  return {
    body: { component: { items: [componentEntry] } },
    allocations,
    tracking,
  }
}

// Source-bin auto-adjust hook for the WO-issue path. When NS has less on-hand
// in the source bin than the line totalizer says we just consumed, bump the
// source up by exactly the shortfall and signal the caller to retry the
// allocation lookup. Returns true on a successful adjust, false otherwise —
// the caller decides whether to retry the issue or surface INSUFFICIENT_INVENTORY.
async function tryShortfallAutoAdjust({ nsWorkOrderId, targetItemId, preferredBinId, shortfall }) {
  if (!preferredBinId || !(shortfall > 0)) return false
  let lastWoNumber = null
  let tankName = null
  try {
    const batch = await db.MesBlendTankBatch.findOne({
      where: { nsWorkOrderId: String(nsWorkOrderId) },
      attributes: ['tankId', 'nsWorkOrderNumber'],
    })
    lastWoNumber = batch?.nsWorkOrderNumber || null
    tankName = batch?.tankId || null
  } catch (err) {
    console.warn(`[BlendTankMesService] tryShortfallAutoAdjust DB lookup failed: ${err.message}`)
  }
  const result = await inventoryAdjustment.applyShortfallAdjustment({
    sourceBinId: preferredBinId,
    itemId: targetItemId,
    shortfallQty: shortfall,
    lastWoNumber,
    tankName,
    memo: `Auto-adjust: blend WO ${nsWorkOrderId} issue shortfall (+${shortfall.toFixed(2)} lb)`,
  })
  return !!result?.ok
}

function extractNsIssueId(nsResult) {
  if (nsResult?.body?.id) return String(nsResult.body.id)
  if (nsResult?.id) return String(nsResult.id)
  const loc = nsResult?.headers?.location
  if (loc) {
    const m = String(loc).match(/\/(\d+)$/)
    if (m) return m[1]
  }
  return null
}

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
      detectedAt: { [db.Sequelize.Op.gte]: new Date(clock.now() - COOLDOWN_MINUTES * 60 * 1000) },
    },
    order: [['detectedAt', 'DESC']],
  })
  if (recentBatch) {
    const ageSec = Math.round((clock.now() - new Date(recentBatch.detectedAt).getTime()) / 1000)
    console.warn(`[BlendTankMesService] COOLDOWN: "${productName}" on ${tankId} rejected — last batch "${recentBatch.productName}" was ${ageSec}s ago (min ${COOLDOWN_MINUTES * 60}s)`)
    return { success: true, cooldown: true, tankId, productName, lastBatchAge: ageSec }
  }

  // Test-input override: if BLEND_TANK_OVERRIDES has an entry for this tank,
  // use it directly and skip the parser. This is the temporary stand-in for
  // the not-yet-available AVEVA product tag.
  const overrideItemId = config.BLEND_TANK_OVERRIDES?.[tankId]
  let parsed, assemblyItem
  if (overrideItemId) {
    const overrideCatalog = productParser.getProductByNsId(overrideItemId)
    const overrideName = overrideCatalog?.name || `NS item ${overrideItemId}`
    console.log(`[BlendTankMesService] OVERRIDE: ${tankId} → NS item ${overrideItemId} (${overrideName}) — skipping parser`)
    parsed = { nsId: overrideItemId, name: overrideName, confidence: 'override', score: 0, parsed: { override: true, productName } }
    assemblyItem = { id: overrideItemId, name: overrideName, confidence: 'override' }
  } else {
    parsed = productParser.parseProductName(productName)
    assemblyItem = parsed
      ? { id: parsed.nsId, name: parsed.name, confidence: parsed.confidence }
      : { id: null, name: `Unrecognized: "${productName}"`, confidence: 'none' }
  }

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
    detectedAt: detectedAt || new Date(clock.now()),
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
      location: { id: 30 },
      subsidiary: { id: 3 },
      // isWip MUST be true — controls whether NS lets us create
      // workOrderIssue transactions against the WO. Without it, NS rejects
      // every issue with "the work order does not use WIP, or the work
      // order is already closed". Discovered 2026-05-19 via WO1364 (isWip
      // false, every issue 400'd) vs WO1365 (isWip true, issues working).
      isWip: true,
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
          const woBody = woDetail?.body || woDetail
          nsWorkOrderNumber = woBody?.tranId || woBody?.tranid || null
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

  await record.update({ status: 'completed', completedAt: detectedAt || new Date(clock.now()) })
  if (record.nsWorkOrderId) clearBomCache(record.nsWorkOrderId)
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
 * Tail-catcher: fired by blendTankJob the moment the line totalizer resets
 * (or the line's product clears). The reset value is the totalizer's peak
 * for this batch on this line. The 5-min tick may have already issued part
 * of it; we only fire NS for the remaining delta vs MesPipeIssueState.
 *
 * Without this safety net, a fill that completes inside one 5-min tick
 * window is invisible to the tick — the totalizer goes 0 → peak → 0
 * between two consecutive ticks and we never see the peak. This handler
 * captures it the moment blendTankJob detects the reset.
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

  // Match the tank using the canonical normalizer (BT2A ↔ BlendTank2A)
  const activeBatches = await db.MesBlendTankBatch.findAll({ where: { status: 'active' } })
  let targetBatch = null
  if (activeBatches.length > 0 && destination) {
    const destCanonical = normalizeTankRef(destination)
    if (destCanonical) {
      targetBatch = activeBatches.find(b => normalizeTankRef(b.tankId) === destCanonical)
    }
    if (!targetBatch) {
      const destNorm = destination.toLowerCase().replace(/[^a-z0-9]/g, '')
      targetBatch = activeBatches.find(b => {
        const tankNorm = b.tankId.toLowerCase().replace(/[^a-z0-9]/g, '')
        return tankNorm === destNorm || tankNorm.includes(destNorm) || destNorm.includes(tankNorm)
      })
    }
  }

  // Silo fallback: when REQUESTEDBY was empty (destination=''), match by the
  // line's source silo vs the batch's stored fromEntName. Restricted to an
  // unambiguous 1-to-1 mapping to avoid double-issuing.
  if (!targetBatch && siloName && activeBatches.length > 0) {
    const siloCanon = itemConfig.normalizeSiloName(siloName)
    if (siloCanon) {
      const matched = activeBatches.filter(b => {
        const batchSilo = itemConfig.normalizeSiloName(b.fromEntName)
        return batchSilo !== null && batchSilo === siloCanon
      })
      if (matched.length === 1) {
        targetBatch = matched[0]
        console.log(`[BlendTankMesService] processLineFlow ${line}: matched ${targetBatch.tankId} via siloName="${siloName}" (REQUESTEDBY was empty)`)
      } else if (matched.length > 1) {
        console.warn(`[BlendTankMesService] processLineFlow ${line}: silo "${siloName}" matches ${matched.length} active batches — cannot route`)
      }
    }
  }

  if (!targetBatch) {
    const record = await db.MesBlendTankInflow.create({
      blendTankBatchId: null, line,
      ingredientType: lineProductName || ingredientType || 'unknown',
      totalLbs, nsItemId: null, status: 'unmatched', resetTime,
      destination: destination || null, siloName: siloName || null,
    })
    console.log(`[BlendTankMesService] processLineFlow ${line} reset (${totalLbs.toFixed(1)} lb) — no active batch matched destination "${destination}"`)
    return { success: true, inflowId: record.id, status: 'unmatched' }
  }

  // Compute the tail delta — totalizer's peak minus what the tick already issued
  const pipeState = await db.MesPipeIssueState.findOne({
    where: { blendTankBatchId: targetBatch.id, line },
  })
  const lastIssued = pipeState ? (parseFloat(pipeState.lastIssuedTotalizerLbs) || 0) : 0
  const delta = totalLbs - lastIssued

  if (delta < config.MES_MIN_ISSUE_LBS) {
    const record = await db.MesBlendTankInflow.create({
      blendTankBatchId: targetBatch.id, line,
      ingredientType: lineProductName || ingredientType || 'unknown',
      totalLbs, nsItemId: null, status: 'tick_already_issued', resetTime,
      destination: destination || null, siloName: siloName || null,
    })
    console.log(`[BlendTankMesService] processLineFlow ${line} reset (${totalLbs.toFixed(1)} lb): tick already issued ${lastIssued.toFixed(1)} — no tail to catch`)
    return { success: true, inflowId: record.id, status: 'tick_already_issued' }
  }

  const component = resolveLineComponent({ line, productName: lineProductName })
  const binId = itemConfig.getBinId(siloName)

  const inflowRecord = await db.MesBlendTankInflow.create({
    blendTankBatchId: targetBatch.id,
    line,
    ingredientType: lineProductName || ingredientType || (line.startsWith('CL') ? 'cream' : 'skim'),
    totalLbs: delta,
    nsItemId: component?.id ? String(component.id) : null,
    status: 'pending',
    resetTime,
    destination: destination || null,
    siloName: siloName || null,
  })

  if (config.MES_DRY_RUN) {
    await inflowRecord.update({ status: 'dry_run' })
    console.log(`[BlendTankMesService] DRY RUN tail-catcher ${line} → ${targetBatch.tankId}: ${delta.toFixed(1)} lb`)
    return { success: true, inflowId: inflowRecord.id, status: 'dry_run' }
  }
  if (!targetBatch.nsWorkOrderId || !component?.id || !binId) {
    await inflowRecord.update({ status: 'pending_ns' })
    console.warn(`[BlendTankMesService] tail-catcher ${line} → ${targetBatch.tankId}: missing ${!targetBatch.nsWorkOrderId ? 'NS WO' : !component?.id ? 'NS item' : 'bin'} — saved as pending_ns (delta ${delta.toFixed(1)})`)
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_tail_issue', sourceId: targetBatch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue', payload: JSON.stringify(data),
      result: JSON.stringify({ skipped: 'gap', siloName, component, binId }),
      success: true,
    })
    return { success: true, inflowId: inflowRecord.id, status: 'pending_ns' }
  }

  const bomLines = await fetchWoBomLines(targetBatch.nsWorkOrderId)
  let body, allocations
  try {
    const built = await buildWoIssueBody(targetBatch.nsWorkOrderId, component.id, delta, binId, bomLines)
    body = built.body
    allocations = built.allocations
  } catch (err) {
    console.error(`[BlendTankMesService] tail-catcher ${line}: buildWoIssueBody failed — ${err.message}`)
    await inflowRecord.update({ status: 'pending_ns' })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_tail_issue', sourceId: targetBatch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue', payload: JSON.stringify(data),
      result: null, success: false, errorMessage: err.message,
    })
    return { success: true, inflowId: inflowRecord.id, status: 'pending_ns', error: err.message }
  }

  try {
    const allocSummary = allocations
      ? ` via ${allocations.map(a => `lot ${a.lotName}@${a.binName} ${a.qty.toFixed(1)}`).join(' + ')}`
      : ''
    console.log(`[BlendTankMesService] tail-catcher ${line} → WO ${targetBatch.nsWorkOrderId} (${targetBatch.tankId}): ${delta.toFixed(1)} lb (peak ${totalLbs.toFixed(1)}, tick had issued ${lastIssued.toFixed(1)})${allocSummary}`)
    const nsResult = await core.netsuitePost(`/record/v1/workOrder/${targetBatch.nsWorkOrderId}/!transform/workOrderIssue`, body)
    const nsIssueId = extractNsIssueId(nsResult)

    await inflowRecord.update({ nsIssueId: nsIssueId ? String(nsIssueId) : null, status: 'completed' })
    // Bring the pipe state up to the peak so the next tick doesn't re-issue
    if (pipeState) {
      await pipeState.update({ lastIssuedTotalizerLbs: totalLbs, lastIssueAt: new Date(clock.now()) })
    } else {
      await db.MesPipeIssueState.create({
        blendTankBatchId: targetBatch.id, line,
        lastIssuedTotalizerLbs: totalLbs, lastIssueAt: new Date(clock.now()),
        lastTotalizerLbs: totalLbs, lastObservedAt: new Date(clock.now()),
      })
    }
    await targetBatch.increment({ cumulativeIssuedLbs: delta })
    await targetBatch.update({ lastIssueAt: new Date(clock.now()) })

    await db.MesProcessingLog.create({
      eventType: 'blend_tank_tail_issue', sourceId: targetBatch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue', nsTransactionId: nsIssueId,
      payload: JSON.stringify({ ...data, delta, lastIssued }),
      result: JSON.stringify({ nsIssueId }),
      success: true,
    })

    return { success: true, inflowId: inflowRecord.id, nsIssueId, status: 'completed' }
  } catch (err) {
    console.error(`[BlendTankMesService] tail-catcher ${line} → WO ${targetBatch.nsWorkOrderId} failed:`, err.message)
    await inflowRecord.update({ status: 'error', errorMessage: err.message })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_tail_issue', sourceId: targetBatch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue', payload: JSON.stringify(data),
      success: false, errorMessage: err.message,
    })
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
 * product name (most accurate), fall back to line prefix (CL = cream, ML = skim)
 * only when no productName is available at all.
 */
function resolveLineComponent(reading) {
  if (reading.productName) {
    const m = lineMapper.resolveLineProduct(reading.productName)
    if (m) return { ...m, resolvedFrom: 'scada' }
    // productName known but no mapper match — return null so callers skip gracefully
    // rather than issuing against the wrong BOM item.
    return { id: null, name: reading.productName, resolvedFrom: 'unknown' }
  }
  // No productName at all — last-resort line-prefix guess
  const fallback = reading.line.startsWith('CL') ? itemConfig.CREAM_ITEM_CONV : itemConfig.SKIM_ITEM_CONV
  return { ...fallback, resolvedFrom: 'line-prefix' }
}

/**
 * Map any tank reference SCADA might write — "BlendTank2A", "BT2A", "Tank2A",
 * "Blend2A", "2A" — to a canonical short form ("2a"). The line tags use the
 * abbreviated "BT2A" form in `requestedBy` while our MesBlendTankBatch.tankId
 * stores the full "BlendTank2A" form, so we normalize both before comparing.
 *
 * Returns null for inputs that don't look like a blend-tank reference.
 */
function normalizeTankRef(raw) {
  if (!raw || typeof raw !== 'string') return null
  let s = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!s) return null
  s = s.replace(/^blendtank/, '').replace(/^bt/, '').replace(/^blend/, '').replace(/^tank/, '')
  return /^[12][ab]$/.test(s) ? s : null
}

/**
 * Match a line reading to one active batch. Four paths in order:
 *   1. UHT-direct virtual batches (tankId encoded as "{line}→{destination}")
 *   2. Canonical-form match between reading.requestedBy and batch.tankId
 *      (handles the BT2A ↔ BlendTank2A abbreviation)
 *   3. Loose substring match on raw normalized strings (legacy path)
 *   4. Source-silo fallback: when REQUESTEDBY is empty, match the line's
 *      siloName against batch.fromEntName. Covers AVEVA configs that write
 *      FromEntName on the blend tank but don't write REQUESTEDBY on the line.
 *      Restricted to an unambiguous 1-to-1 silo-to-batch mapping to avoid
 *      double-issuing when multiple batches share the same source silo.
 */
function findBatchForLine(reading, activeBatches) {
  for (const batch of activeBatches) {
    if (batch.tankId.startsWith(`${reading.line}→`)) return batch
  }
  if (!reading.requestedBy) {
    // Silo fallback: match by line.siloName ↔ batch.fromEntName
    if (reading.siloName) {
      const siloCanon = itemConfig.normalizeSiloName(reading.siloName)
      if (siloCanon) {
        const matched = activeBatches.filter(b => {
          const batchSilo = itemConfig.normalizeSiloName(b.fromEntName)
          return batchSilo !== null && batchSilo === siloCanon
        })
        if (matched.length === 1) return matched[0]
        if (matched.length > 1) {
          console.warn(`[BlendTankMesService] findBatchForLine ${reading.line}: silo "${reading.siloName}" matches ${matched.length} active batches — skipping to avoid double-issue`)
        }
      }
    }
    return null
  }

  const destCanonical = normalizeTankRef(reading.requestedBy)
  if (destCanonical) {
    for (const batch of activeBatches) {
      if (normalizeTankRef(batch.tankId) === destCanonical) return batch
    }
  }

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

  // Diagnostic: log REQUESTEDBY state for each line so we can tell whether
  // AVEVA is populating it (helps diagnose the silo-fallback path being taken).
  if (batch.nsWorkOrderId) {
    const hasAnyFlow = lineReadings.some(r => r.totalizerLbs > 0)
    if (hasAnyFlow && matchingLines.length === 0) {
      const lineSnapshot = lineReadings
        .filter(r => r.totalizerLbs > 0 || r.active)
        .map(r => `${r.line}(tot=${Math.round(r.totalizerLbs)}lb requestedBy="${r.requestedBy}" silo="${r.siloName}")`)
        .join(', ')
      console.warn(`[BlendTankMesService] tick ${batch.tankId} (WO ${batch.nsWorkOrderId}): no matching lines despite flow — ${lineSnapshot || 'all zero'}`)
    } else if (matchingLines.length > 0) {
      const viaSilo = matchingLines.filter(r => !r.requestedBy).map(r => r.line)
      if (viaSilo.length > 0) {
        console.log(`[BlendTankMesService] tick ${batch.tankId}: lines matched via silo fallback: ${viaSilo.join(', ')}`)
      }
    }
  }

  const observedAt = new Date(clock.now())
  const candidates = []
  const activeLines = new Set()

  // ── Phase 1: build candidates for current-tick matching lines ─────────
  for (const reading of matchingLines) {
    activeLines.add(reading.line)

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
    // the frontend has a fresh "current totalizer" snapshot. Also persist the
    // product/silo context so a restart can recover a missed reset.
    const contextUpdate = { lastTotalizerLbs: reading.totalizerLbs, lastObservedAt: observedAt }
    if (reading.productName) contextUpdate.lastProductName = reading.productName
    if (reading.siloName) contextUpdate.lastSiloName = reading.siloName
    await pipeState.update(contextUpdate)

    if (delta < config.MES_MIN_ISSUE_LBS) continue

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

    candidates.push({
      kind: 'current',
      line: reading.line,
      delta,
      pipeState,
      component,
      binId,
      productName: reading.productName,
      newBaseline: reading.totalizerLbs,
      destination: reading.requestedBy || null,
      siloName: reading.siloName || null,
    })
  }

  // ── Phase 2: catch-up candidates for lines that weren't in this tick ──
  // Same gating as before: only run when the batch has an NS WO.
  if (batch.nsWorkOrderId) {
    const allPipeStates = await db.MesPipeIssueState.findAll({ where: { blendTankBatchId: batch.id } })
    for (const ps of allPipeStates) {
      if (activeLines.has(ps.line)) continue
      const stored = parseFloat(ps.lastTotalizerLbs) || 0
      const issued = parseFloat(ps.lastIssuedTotalizerLbs) || 0
      const catchUpDelta = stored - issued
      if (catchUpDelta < config.MES_MIN_ISSUE_LBS) continue
      if (!ps.lastProductName || !ps.lastSiloName) {
        console.warn(`[BlendTankMesService] tick catch-up ${ps.line} → ${batch.tankId}: ${catchUpDelta.toFixed(1)} lb unissued but no stored product/silo — skipping`)
        continue
      }
      const syntheticReading = { line: ps.line, productName: ps.lastProductName, siloName: ps.lastSiloName, totalizerLbs: stored }
      const component = resolveLineComponent(syntheticReading)
      if (!component.id) {
        console.warn(`[BlendTankMesService] tick catch-up ${ps.line}: no NS item for "${ps.lastProductName}" — skipping`)
        continue
      }
      const binId = itemConfig.getBinId(ps.lastSiloName)
      if (!binId) {
        console.warn(`[BlendTankMesService] tick catch-up ${ps.line}: no bin for "${ps.lastSiloName}" — skipping`)
        continue
      }
      candidates.push({
        kind: 'catchup',
        line: ps.line,
        delta: catchUpDelta,
        pipeState: ps,
        component,
        binId,
        productName: ps.lastProductName,
        newBaseline: stored,
        destination: null,
        siloName: ps.lastSiloName || null,
      })
    }
  }

  let issuesFired = 0

  // Dry-run: keep per-line baseline advancement (lets developers see state
  // evolve as if NS calls succeeded). No grouping needed since there's no
  // outbound call to consolidate.
  if (config.MES_DRY_RUN) {
    for (const c of candidates) {
      await c.pipeState.update({ lastIssuedTotalizerLbs: c.newBaseline, lastIssueAt: observedAt })
      await batch.increment({ cumulativeIssuedLbs: c.delta })
      await batch.update({ lastIssueAt: observedAt })
      console.log(`[BlendTankMesService] DRY RUN tick issue ${c.line} → ${batch.tankId}: ${c.delta.toFixed(1)} lb${c.kind === 'catchup' ? ' (catch-up)' : ''}`)
    }
    return 0
  }

  if (!batch.nsWorkOrderId) {
    if (candidates.length > 0) {
      console.log(`[BlendTankMesService] tick: batch ${batch.id} has no NS WO — skipping ${candidates.length} candidate(s)`)
    }
    return 0
  }

  // ── Phase 3: group candidates by (source bin, item) ──────────────────
  // Per BATCH_LIFECYCLE_PLAN.md §3 + memory [[bt-wo-issue-grouping]]:
  // emit one workOrderIssue per (source bin, item) tuple. Two lines
  // pulling from the same silo with the same item collapse into one;
  // lines with distinct bins or items each get their own issue.
  const groups = new Map()
  for (const c of candidates) {
    const key = `${c.binId}:${c.component.id}`
    if (!groups.has(key)) {
      groups.set(key, { binId: c.binId, component: c.component, totalDelta: 0, members: [] })
    }
    const g = groups.get(key)
    g.totalDelta += c.delta
    g.members.push(c)
  }

  const bomLines = await fetchWoBomLines(batch.nsWorkOrderId)

  for (const g of groups.values()) {
    const memberLabel = g.members
      .map(m => m.kind === 'catchup' ? `${m.line}(catch-up)` : m.line)
      .join('+')

    let body, allocations
    try {
      const built = await buildWoIssueBody(batch.nsWorkOrderId, g.component.id, g.totalDelta, g.binId, bomLines)
      body = built.body
      allocations = built.allocations
    } catch (err) {
      console.error(`[BlendTankMesService] tick issue ${memberLabel} → WO ${batch.nsWorkOrderId}: buildWoIssueBody failed — ${err.message}`)
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_tick_issue',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue',
        payload: JSON.stringify({
          batchId: batch.id,
          members: g.members.map(m => ({ line: m.line, kind: m.kind, delta: m.delta })),
          totalDelta: g.totalDelta,
          targetItem: g.component.id,
          preferredBinId: g.binId,
        }),
        success: false,
        errorMessage: err.message,
      })
      continue
    }

    try {
      const allocSummary = allocations
        ? ` via ${allocations.map(a => `lot ${a.lotName}@${a.binName} ${a.qty.toFixed(1)}`).join(' + ')}`
        : ''
      console.log(`[BlendTankMesService] tick issue ${memberLabel} → WO ${batch.nsWorkOrderId} (${batch.tankId}): ${g.totalDelta.toFixed(1)} lb "${g.component.name}" (NS ${g.component.id})${allocSummary}`)
      const nsResult = await core.netsuitePost(`/record/v1/workOrder/${batch.nsWorkOrderId}/!transform/workOrderIssue`, body)
      const nsIssueId = extractNsIssueId(nsResult)

      for (const m of g.members) {
        await m.pipeState.update({ lastIssuedTotalizerLbs: m.newBaseline, lastIssueAt: observedAt })
        await batch.increment({ cumulativeIssuedLbs: m.delta })
        await db.MesBlendTankInflow.create({
          blendTankBatchId: batch.id,
          line: m.line,
          ingredientType: m.productName || (m.line.startsWith('CL') ? 'cream' : 'skim'),
          totalLbs: m.delta,
          nsItemId: String(g.component.id),
          nsIssueId: nsIssueId ? String(nsIssueId) : null,
          status: 'completed',
          resetTime: observedAt,
          destination: m.destination || null,
          siloName: m.siloName || null,
        })
      }
      await batch.update({ lastIssueAt: observedAt })

      await db.MesProcessingLog.create({
        eventType: 'blend_tank_tick_issue',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue',
        nsTransactionId: nsIssueId,
        payload: JSON.stringify({
          batchId: batch.id,
          members: g.members.map(m => ({ line: m.line, kind: m.kind, delta: m.delta, newBaseline: m.newBaseline })),
          totalDelta: g.totalDelta,
          component: g.component,
          binId: g.binId,
        }),
        result: JSON.stringify({ nsIssueId }),
        success: true,
      })

      issuesFired++
    } catch (err) {
      console.error(`[BlendTankMesService] tick issue failed for ${memberLabel} → WO ${batch.nsWorkOrderId}:`, err.message)
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_tick_issue',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue',
        payload: JSON.stringify({
          batchId: batch.id,
          members: g.members.map(m => ({ line: m.line, kind: m.kind, delta: m.delta })),
          totalDelta: g.totalDelta,
          binId: g.binId,
        }),
        success: false,
        errorMessage: err.message,
      })
      // Don't advance any baselines — every member's delta retries on next tick
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
    await batch.update({ cumulativeCompletedLbs: cumulativeIssued, lastCompletionAt: new Date(clock.now()) })
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

  const now = new Date(clock.now())
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const yy = String(now.getFullYear()).slice(-2)
  const woNum = String(batch.nsWorkOrderNumber || '').replace(/\D/g, '')
  const lotNumber = `${mm}${dd}${yy}${woNum}`
  const roundedTarget = Math.round(target * 1000) / 1000
  const assignmentEntry = { quantity: roundedTarget, receiptInventoryNumber: lotNumber }
  if (completionBinId) assignmentEntry.binnumber = String(completionBinId)

  const body = {
    quantity: roundedTarget,
    inventorydetail: {
      inventoryassignment: {
        items: [assignmentEntry],
      },
    },
  }

  console.log(`[BlendTankMesService] tick completion inventory: 1 lot (${target.toFixed(1)} lb) → bin ${completionBinId || 'none'}`)

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
      lastCompletionAt: new Date(clock.now()),
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
    await batch.update({ status: 'cancelled', completedAt: new Date(clock.now()) })
  }

  console.log(`[BlendTankMesService] Cleared ${stale.length} stale batch(es)`)
  return { success: true, cleared: stale.length }
}

function clearCaches() {
  _bomCache.clear()
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
  normalizeTankRef,
  clearCaches,
}
