const core = require('../clients/coreClient')
const itemConfig = require('./mesItemConfig')
const inventoryAdjustment = require('./inventoryAdjustmentService')
const config = require('../config')
const db = require('../models')
const clock = require('../sim/clock')
const statusStore = require('./statusStore')
const notifyService = require('./notifyService')

// NS bin id for "SEPARATOR-ADJUSTMENTS" — the scratch bin we stage phantom
// source-item inventory into to defeat the assemblyUnbuild "largest-other-bin"
// cap (constraint #2 in [[assemblyunbuild_must_be_n]]). Raised to unbuildQty+1
// just before the unbuild and zeroed right back out after, so it never carries
// lasting inventory.
// NOTE: this id is env-specific. In production SEPARATOR-ADJUSTMENTS is bin 5020
// (id 5016 there is a real bin, "FL-1A" — do NOT point at it). The sandbox
// scratch bin was 5016.
const SEPARATOR_ADJ_BIN_ID = 5020

async function processSeparationBatch(data) {
  const {
    batchId, sourceSilo: sourceRaw, destinations: destsRaw = [], siloProductConfig = {},
    inputVolume, creamVolume, skimVolume,
    batchStart, batchEnd, itemId, transferName, unit, targetVolume, endReason,
  } = data

  if (!batchId) throw new Error('batchId is required')
  if (!sourceRaw) throw new Error('sourceSilo is required')
  if (!inputVolume || inputVolume <= 0) throw new Error('inputVolume must be greater than 0')

  const sourceSilo = itemConfig.normalizeSiloName(sourceRaw) || sourceRaw

  // State-machine flow: a row already exists (created at start, closed in
  // separatorStateMachine.closeBatch). We update it through to NS rather than
  // creating a fresh row. Status 'running' = just closed by SM, ready to emit.
  // Anything else terminal = already processed, skip.
  const stateMachineRow = await db.MesSeparationBatch.findOne({
    where: { batchId, sourceSilo },
  })
  if (stateMachineRow && stateMachineRow.status !== 'running') {
    console.log(`[MilkMesService] Batch ${batchId} / ${sourceSilo} already processed (status: ${stateMachineRow.status}) — skipping`)
    return { success: true, duplicate: true, batchId, status: stateMachineRow.status, summary: null }
  }
  // Legacy admin-route compat: if no row exists, fall back to the dedup-by-(batchId,sourceSilo,batchEnd)
  // check the original logic used.
  if (!stateMachineRow) {
    const existing = await db.MesSeparationBatch.findOne({
      where: { batchId, sourceSilo, batchEnd: batchEnd || null },
    })
    if (existing) {
      console.log(`[MilkMesService] Batch ${batchId} / ${sourceSilo} already processed (status: ${existing.status}) — skipping`)
      return { success: true, duplicate: true, batchId, status: existing.status, summary: null }
    }
  }

  // Source product: prefer the silo's currently-selected product index (from
  // the Standardization HMI). Falls back to the legacy XFR.ItemID mapping so
  // older batches without siloProductConfig still resolve something.
  const lookupCfg = (name) => (name && (siloProductConfig[name] || siloProductConfig[itemConfig.normalizeSiloName(name) || ''])) || {}
  const sourceCfg = lookupCfg(sourceRaw)
  const sourceIndex = sourceCfg.productIndex || 0
  const sourceName = sourceCfg.productName || ''
  const sourceItem = sourceIndex
    ? itemConfig.getItemByProductIndex(sourceIndex)
    : itemConfig.getItem(itemId, sourceSilo)
  const sourceBinId = itemConfig.getBinId(sourceSilo)

  // Classify each raw destination and look up its current product. C-silo ⇒
  // cream; M-silo (not the source) ⇒ skim/normalized milk.
  const resolvedDests = (destsRaw || []).map(raw => {
    const silo = itemConfig.normalizeSiloName(raw)
    const cls = itemConfig.classifySiloDestination(raw)
    const cfg = lookupCfg(raw)
    const idx = cfg.productIndex || 0
    // Cream item is determined by source, not by the cream silo's productIndex
    // (which is operator-set on the HMI and often stale).
    const item = cls === 'cream'
      ? itemConfig.getCreamItemForSource(sourceItem.id)
      : (idx ? itemConfig.getItemByProductIndex(idx) : { id: null, name: '' })
    return {
      raw,
      silo,
      kind: cls,
      binId: silo ? itemConfig.getBinId(silo) : null,
      productIndex: idx,
      productName: cfg.productName || '',
      item,
    }
  })

  const creamDest = resolvedDests.find(d => d.kind === 'cream') || null
  const skimDest = resolvedDests.find(d => d.kind === 'skim' && d.silo && d.silo !== sourceSilo) || null

  const wasteVolume = inputVolume - (creamVolume || 0) - (skimVolume || 0)
  // wastePercent is meaningless when inputVolume is essentially zero — a
  // tiny denominator produces millions-of-percent garbage that overflows
  // the DB column. Observed in production on a cip_started close where
  // input=0.07 lb but cream+skim=18,268 lb of residual totalizer carried
  // over from the previous batch. Require real flow before computing the
  // ratio; clamp the result as a safety net for any other edge case.
  const MIN_INPUT_FOR_PERCENT_LBS = 10
  const WASTE_PCT_CLAMP = 999999.99
  const wastePercent = inputVolume >= MIN_INPUT_FOR_PERCENT_LBS
    ? Math.max(-WASTE_PCT_CLAMP, Math.min(WASTE_PCT_CLAMP, (wasteVolume / inputVolume) * 100))
    : null

  // Compact dashboard-facing view of this batch. Returned alongside every exit
  // path so the job can push it into statusStore.recentBatches regardless of
  // which branch (completed / pending_ns / dry_run / error) we land on.
  const summary = {
    batchId,
    batchStart,
    batchEnd,
    transferName: transferName || null,
    source: {
      silo: sourceSilo,
      productIndex: sourceIndex,
      productName: sourceName,
      nsItemId: sourceItem.id,
      nsItemName: sourceItem.name,
      binId: sourceBinId,
    },
    cream: creamDest && {
      silo: creamDest.silo || creamDest.raw,
      productIndex: creamDest.productIndex,
      productName: creamDest.productName,
      nsItemId: creamDest.item.id,
      nsItemName: creamDest.item.name,
      binId: creamDest.binId,
    },
    skim: skimDest && {
      silo: skimDest.silo || skimDest.raw,
      productIndex: skimDest.productIndex,
      productName: skimDest.productName,
      nsItemId: skimDest.item.id,
      nsItemName: skimDest.item.name,
      binId: skimDest.binId,
    },
    inputVolume,
    creamVolume: creamVolume || 0,
    skimVolume: skimVolume || 0,
    wasteVolume: parseFloat(wasteVolume.toFixed(2)),
    wastePercent: wastePercent != null ? parseFloat(wastePercent.toFixed(2)) : null,
  }

  const fmtItem = (label, item, silo, idx, name, bin) =>
    `  ${label}: ${silo || '-'} idx=${idx || '-'} "${name || '-'}" → NS ${item?.id || 'MISSING'} (${item?.name || '-'}) bin=${bin ?? 'MISSING'}`

  const wastePctText = wastePercent != null ? `${wastePercent.toFixed(1)}%` : 'n/a (input below threshold)'
  console.log(`[MilkMesService] Processing batch ${batchId} (${sourceSilo} → ${resolvedDests.map(d => d.silo || d.raw).join(', ') || '?'})`)
  console.log(fmtItem('Source', sourceItem, sourceSilo, sourceIndex, sourceName, sourceBinId))
  console.log(fmtItem('Cream ', creamDest?.item, creamDest?.silo || creamDest?.raw, creamDest?.productIndex, creamDest?.productName, creamDest?.binId))
  console.log(fmtItem('Skim  ', skimDest?.item, skimDest?.silo || skimDest?.raw, skimDest?.productIndex, skimDest?.productName, skimDest?.binId))
  console.log(`  Volumes: input=${Number(inputVolume).toFixed(1)} LBS, cream=${Number(creamVolume || 0).toFixed(1)}, skim=${Number(skimVolume || 0).toFixed(1)}, waste=${wasteVolume.toFixed(1)} (${wastePctText})`)

  if (wastePercent != null && wastePercent > itemConfig.WASTE_ALERT_THRESHOLD) {
    console.warn(`[MilkMesService] High waste alert: ${wastePercent.toFixed(1)}% (threshold: ${itemConfig.WASTE_ALERT_THRESHOLD}%)`)
    await notifyService.sendAlert(
      'MES Separation: High Waste Alert',
      `Batch ${batchId} from ${sourceSilo}\nWaste: ${wasteVolume.toFixed(1)} LBS (${wastePercent.toFixed(1)}%)\nThreshold: ${itemConfig.WASTE_ALERT_THRESHOLD}%\nInput: ${inputVolume} | Cream: ${creamVolume} | Skim: ${skimVolume}`
    )
  }

  // Everything we resolved goes into destinations JSON so we can debug "why did
  // this batch go pending_ns" from the DB row alone (no migration needed).
  const destinationsJson = JSON.stringify({
    raw: destsRaw,
    resolved: resolvedDests,
    source: { silo: sourceSilo, productIndex: sourceIndex, productName: sourceName, nsItemId: sourceItem.id, binId: sourceBinId },
  })

  const numericPayload = {
    inputVolume,
    creamVolume: creamVolume || 0,
    skimVolume: skimVolume || 0,
    wasteVolume: parseFloat(wasteVolume.toFixed(2)),
    wastePercent: wastePercent != null ? parseFloat(wastePercent.toFixed(2)) : null,
    targetVolume: targetVolume ?? null,
  }

  let record
  try {
    if (stateMachineRow) {
      // State machine flow: update the existing row with resolution data.
      // batchStart was set at open; preserve it. batchEnd was set at close.
      await stateMachineRow.update({
        ...numericPayload,
        transferName: transferName || stateMachineRow.transferName,
        destinations: destinationsJson,
        itemId: itemId || stateMachineRow.itemId,
        unit: unit || stateMachineRow.unit,
        targetVolume: numericPayload.targetVolume ?? stateMachineRow.targetVolume,
        endReason: endReason || stateMachineRow.endReason,
        status: 'pending',
      })
      record = stateMachineRow
    } else {
      record = await db.MesSeparationBatch.create({
        batchId,
        sourceSilo,
        ...numericPayload,
        batchStart,
        batchEnd,
        transferName: transferName || null,
        destinations: destinationsJson,
        itemId: itemId || null,
        unit: unit || null,
        status: 'pending',
      })
    }
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      console.log(`[MilkMesService] Batch ${batchId} / ${sourceSilo} lost insert race — skipping`)
      return { success: true, duplicate: true, batchId, status: 'race_dedup' }
    }
    // DECIMAL overflow / numeric coercion failures don't tell us which column.
    // Log the full numeric payload so we can spot the bad value, AND attach
    // it to the error so it surfaces in the dashboard event-stream data
    // (separatorStateMachine forwards err.message + .data into pushEvent).
    console.error(`[MilkMesService] Batch ${batchId} / ${sourceSilo} persist failed: ${err.message}`)
    console.error(`[MilkMesService] Numeric payload: ${JSON.stringify(numericPayload)}`)
    err.numericPayload = numericPayload
    err.message = `${err.message} | payload=${JSON.stringify(numericPayload)}`
    throw err
  }

  // Function-scoped so the catch can log the exact body NS rejected.
  let capturedBody = null

  try {
    const needCream = !!(creamDest && (creamVolume || 0) > 0)
    const needSkim = !!(skimDest && (skimVolume || 0) > 0)

    // Every piece the unbuild needs. Any gap → pending_ns so ops has a backlog
    // of what still needs to be created/configured in NetSuite.
    const gaps = []
    if (!sourceItem.id) gaps.push(`source item (idx=${sourceIndex || '-'}, silo=${sourceSilo})`)
    if (!sourceBinId) gaps.push(`source bin (${sourceSilo})`)
    if (needCream && !creamDest.item.id) gaps.push(`cream item (idx=${creamDest.productIndex || '-'}, silo=${creamDest.silo})`)
    if (needCream && !creamDest.binId) gaps.push(`cream bin (${creamDest.silo || creamDest.raw})`)
    if (needSkim && !skimDest.item.id) gaps.push(`skim item (idx=${skimDest.productIndex || '-'}, silo=${skimDest.silo})`)
    if (needSkim && !skimDest.binId) gaps.push(`skim bin (${skimDest.silo || skimDest.raw})`)

    if (gaps.length > 0 && !config.MES_DRY_RUN) {
      console.warn(`[MilkMesService] Batch ${batchId} missing: ${gaps.join('; ')} — saving pending_ns`)
      await record.update({ status: 'pending_ns', processedAt: new Date(clock.now()) })
      await db.MesProcessingLog.create({
        eventType: 'separation_unbuild', sourceId: batchId,
        nsTransactionType: 'assemblyUnbuild', nsTransactionId: null,
        payload: JSON.stringify(data),
        result: JSON.stringify({ skipped: 'missing resolution', gaps, sourceItem, creamDest, skimDest }),
        success: true,
      })
      return { success: true, duplicate: false, batchId, nsTransactionId: null, status: 'pending_ns', gaps, summary: { ...summary, status: 'pending_ns', gaps } }
    }

    // Pick the BOM for this source + skim fat level. The BOM's component items
    // are the processed product items (e.g. Organic 2% = 5410, Organic Cream = 5483),
    // NOT the source silo's raw-milk item. We send the BOM AND component items
    // using those BOM-matching item IDs so NS updates the BOM lines with exact
    // quantities instead of trying to add new lines to a static sublist.
    const rawSkimProductIndex = skimDest?.productIndex
    const skimProductIndex = itemConfig.normalizeSkimIndex(sourceItem.id, rawSkimProductIndex)
    if (skimProductIndex !== rawSkimProductIndex) {
      console.log(`[MilkMesService] Normalized skim index ${rawSkimProductIndex} → ${skimProductIndex} (organic source ${sourceItem.id} with conventional skim index)`)
    }
    const bomId = itemConfig.getSeparationBomId(sourceItem.id, skimProductIndex)
    if (!bomId) {
      // No separation BOM for this (source, skim-index) pair. The common cause is
      // the skim-destination silo left on a RAW index (15 Raw Conventional / 16
      // Raw Organic / 21 Raw A2) instead of a fat level — a real separation ran
      // (cream came out) but we can't tell which fat-level BOM to unbuild against.
      // Land it in the ops backlog as pending_ns rather than throwing a hard
      // error every run. See Bug D / [[silo-flexibility]].
      const reason = `no separation BOM for source=${sourceItem.id} skim index=${skimProductIndex} (skim silo likely left on a raw/unset fat level)`
      if (!config.MES_DRY_RUN) {
        console.warn(`[MilkMesService] Batch ${batchId} ${reason} — saving pending_ns`)
        await record.update({ status: 'pending_ns', processedAt: new Date(clock.now()) })
        await db.MesProcessingLog.create({
          eventType: 'separation_unbuild', sourceId: batchId,
          nsTransactionType: 'assemblyUnbuild', nsTransactionId: null,
          payload: JSON.stringify(data),
          result: JSON.stringify({ skipped: 'no BOM mapped', reason, sourceItem, skimProductIndex, skimDest }),
          success: true,
        })
        return { success: true, duplicate: false, batchId, nsTransactionId: null, status: 'pending_ns', gaps: [reason], summary: { ...summary, status: 'pending_ns', gaps: [reason] } }
      }
      throw new Error(`No BOM mapped for source=${sourceItem.id} skim productIndex=${skimProductIndex}`)
    }

    const creamItemId = itemConfig.getCreamItemForSource(sourceItem.id).id
    const skimItem = itemConfig.getItemByProductIndex(skimProductIndex)
    if (needSkim && !skimItem.id) throw new Error(`No NS item for skim productIndex=${skimProductIndex}`)

    // Round to 2-dp lbs and reuse the SAME value for both the unbuild header
    // quantity and the source inventory-detail line. Sending the raw float to
    // both can serialize them to microscopically different values, and NS then
    // rejects with "The total inventory detail quantity must be N" (header ≠
    // detail total). One rounded value guarantees they match. See Bug G.
    const unbuildQty = Math.round(inputVolume * 100) / 100
    const body = {
      item: sourceItem.id ? { id: sourceItem.id } : undefined,
      quantity: unbuildQty,
      location: { id: 30 },
      subsidiary: { id: 3 },
      billOfMaterials: { id: bomId },
      custbody_milk_source_silo: sourceSilo,
      custbody_milk_batch_start: batchStart,
      custbody_milk_batch_end: batchEnd,
      custbody_milk_transfer_name: transferName || batchId,
      custbody_milk_destinations: destsRaw.join(', '),
    }

    // Source assembly item is bin-tracked — tell NS which bin to pull from.
    if (sourceBinId) {
      body.inventoryDetail = {
        inventoryAssignment: {
          // inventoryStatus: { id: 1 } ("Good") mirrors the surge bin-only shape.
          // NOTE: it is NOT what gates the "must be N" error — sandbox A/B testing
          // showed NS accepts the assignment with or without it. The real gate is
          // available >= request (see the source-bin buffer pre-check below).
          items: [{ quantity: unbuildQty, binnumber: { id: sourceBinId }, inventoryStatus: { id: 1 } }],
        },
      }
    }

    // Output items are bin-tracked (not lot-tracked), so each component line
    // needs componentInventoryDetail with just binnumber — no lot/receiptInventoryNumber.
    const componentItems = []
    if (needCream) {
      componentItems.push({
        item: creamItemId,
        quantity: creamVolume,
        componentInventoryDetail: creamDest.binId ? {
          inventoryAssignment: { items: [{ quantity: creamVolume, binnumber: { id: creamDest.binId }, inventoryStatus: { id: 1 } }] },
        } : undefined,
      })
    }
    if (needSkim) {
      componentItems.push({
        item: skimItem.id,
        quantity: skimVolume,
        componentInventoryDetail: skimDest.binId ? {
          inventoryAssignment: { items: [{ quantity: skimVolume, binnumber: { id: skimDest.binId }, inventoryStatus: { id: 1 } }] },
        } : undefined,
      })
    }
    if (componentItems.length > 0) body.component = { items: componentItems }
    capturedBody = body

    if (config.MES_DRY_RUN) {
      console.log(`[MilkMesService] DRY RUN — batch ${batchId} saved, skipping NS unbuild. Payload:\n${JSON.stringify(body, null, 2)}`)
      await record.update({ status: 'dry_run', processedAt: new Date(clock.now()) })
      await db.MesProcessingLog.create({
        eventType: 'separation_unbuild', sourceId: batchId,
        nsTransactionType: 'assemblyUnbuild', nsTransactionId: null,
        payload: JSON.stringify(data), result: JSON.stringify({ dryRun: true, body }), success: true,
      })
      return { success: true, duplicate: false, batchId, nsTransactionId: null, status: 'dry_run', wastePercent: wastePercent != null ? parseFloat(wastePercent.toFixed(2)) : null, summary: { ...summary, status: 'dry_run' } }
    }

    // Pre-check source bin on-hand. The unbuild requires the source bin to hold
    // STRICTLY MORE than the unbuild quantity: requesting exactly the available
    // amount is rejected with "The total inventory detail quantity must be N"
    // (verified in sandbox) — NS stores available at higher precision than our
    // 2dp request, so an exact request drifts microscopically over. So top the
    // bin up to inputVolume + a small buffer, not exactly inputVolume. The buffer
    // (a few lb on a ~500k lb transfer) is reconciled away when the silo settles
    // at rest. Source items are bin-tracked raw milk, so a bin-only adjust lands
    // cleanly. (inventoryStatus on the assignment is NOT what gates this — both
    // shapes are accepted; the gate is purely available >= request.)
    const UNBUILD_SOURCE_BUFFER_LBS = 5
    if (sourceItem?.id && sourceBinId && inputVolume > 0) {
      const target = inputVolume + UNBUILD_SOURCE_BUFFER_LBS
      let onHand = await inventoryAdjustment.getBinQtyOnHand(sourceItem.id, sourceBinId)
      if (onHand + 1e-6 < target) {
        const shortfall = target - onHand
        console.log(`[MilkMesService] Source bin short for unbuild on batch ${batchId}: item ${sourceItem.id} bin ${sourceBinId} has ${onHand.toFixed(1)}, need ${inputVolume.toFixed(1)}+${UNBUILD_SOURCE_BUFFER_LBS} buffer (Δ ${shortfall.toFixed(1)}) — auto-adjusting`)
        const adj = await inventoryAdjustment.applyShortfallAdjustment({
          sourceBinId,
          itemId: sourceItem.id,
          shortfallQty: shortfall,
          tankName: sourceSilo,
          triggerKind: 'sepBatch', batchKind: 'separation', mesBatchId: batchId,
          memo: `Auto-adjust: separation unbuild batch ${batchId} shortfall (+${shortfall.toFixed(2)} lb)`,
        })
        if (!adj?.ok) {
          console.warn(`[MilkMesService] Source bin auto-adjust for batch ${batchId} did not succeed: ${adj?.error || adj?.skipped || 'unknown'}`)
        }
        // NS inventorybalance lags the adjustment POST by a few seconds. Poll
        // (backoff) until the bin reflects the new on-hand before submitting.
        for (const delay of [1000, 2000, 3000]) {
          if (onHand + 1e-6 >= target) break
          await new Promise(r => setTimeout(r, delay))
          onHand = await inventoryAdjustment.getBinQtyOnHand(sourceItem.id, sourceBinId)
        }
        if (onHand + 1e-6 < target) {
          console.warn(`[MilkMesService] Source bin still short after adjust+poll for batch ${batchId}: on-hand ${onHand.toFixed(1)} < ${target.toFixed(1)} — submitting anyway`)
        }
      }
    }

    // Defeat the assemblyUnbuild "largest-other-bin" cap (constraint #2 in
    // [[assemblyunbuild_must_be_n]]): NS caps the unbuild qty at the on-hand of
    // the single largest-content bin OTHER than the assigned source bin. Stage
    // unbuildQty+1 of the source item into the SEPARATOR-ADJUSTMENTS bin (5016)
    // so it becomes the largest-other bin and lifts the cap above our request.
    // Zeroed back out in the finally below, success or fail, so it carries no
    // lasting phantom inventory.
    let capBinStaged = false
    if (sourceItem?.id && unbuildQty > 0) {
      const capTarget = unbuildQty + 1
      let capOnHand = await inventoryAdjustment.getBinQtyOnHand(sourceItem.id, SEPARATOR_ADJ_BIN_ID)
      if (capOnHand + 1e-6 < capTarget) {
        const upBy = capTarget - capOnHand
        console.log(`[MilkMesService] Raising unbuild cap for batch ${batchId}: staging item ${sourceItem.id} into bin ${SEPARATOR_ADJ_BIN_ID} (+${upBy.toFixed(2)} lb → ${capTarget.toFixed(2)})`)
        const adj = await inventoryAdjustment.submitInventoryAdjustment({
          binId: SEPARATOR_ADJ_BIN_ID,
          itemId: sourceItem.id,
          qtyDelta: upBy,
          source: 'unbuild_cap',
          tankName: 'SEPARATOR-ADJUSTMENTS',
          triggerKind: 'sepBatch', batchKind: 'separation', mesBatchId: batchId,
          memo: `Auto-adjust: raise unbuild cap for batch ${batchId} (+${upBy.toFixed(2)} lb to bin ${SEPARATOR_ADJ_BIN_ID})`,
        })
        if (!adj?.ok) {
          console.warn(`[MilkMesService] Unbuild-cap stage for batch ${batchId} did not succeed: ${adj?.error || adj?.skipped || 'unknown'}`)
        }
        // NS inventorybalance lags the adjustment POST — poll (backoff) until the
        // cap bin reflects the staged on-hand before submitting the unbuild.
        for (const delay of [1000, 2000, 3000]) {
          if (capOnHand + 1e-6 >= capTarget) break
          await new Promise(r => setTimeout(r, delay))
          capOnHand = await inventoryAdjustment.getBinQtyOnHand(sourceItem.id, SEPARATOR_ADJ_BIN_ID)
        }
        if (capOnHand + 1e-6 < capTarget) {
          console.warn(`[MilkMesService] Cap bin still short after stage+poll for batch ${batchId}: on-hand ${capOnHand.toFixed(1)} < ${capTarget.toFixed(1)} — submitting anyway`)
        }
      }
      capBinStaged = true
    }

    let nsResult
    try {
      nsResult = await core.netsuitePost('/record/v1/assemblyUnbuild', body)
    } finally {
      // Always remove the staged cap inventory, whether the unbuild succeeded or
      // threw — leaving it would carry lasting phantom source-item inventory.
      if (capBinStaged && sourceItem?.id) {
        try {
          const leftover = await inventoryAdjustment.getBinQtyOnHand(sourceItem.id, SEPARATOR_ADJ_BIN_ID)
          if (leftover > 1e-6) {
            console.log(`[MilkMesService] Clearing unbuild cap bin for batch ${batchId}: item ${sourceItem.id} bin ${SEPARATOR_ADJ_BIN_ID} (-${leftover.toFixed(2)} lb → 0)`)
            await inventoryAdjustment.submitInventoryAdjustment({
              binId: SEPARATOR_ADJ_BIN_ID,
              itemId: sourceItem.id,
              qtyDelta: -leftover,
              source: 'unbuild_cap',
              tankName: 'SEPARATOR-ADJUSTMENTS',
              triggerKind: 'sepBatch', batchKind: 'separation', mesBatchId: batchId,
              memo: `Auto-adjust: clear unbuild cap bin for batch ${batchId} (-${leftover.toFixed(2)} lb)`,
            })
          }
        } catch (clearErr) {
          console.warn(`[MilkMesService] Failed to clear unbuild cap bin for batch ${batchId}: ${clearErr.message.slice(0, 200)}`)
        }
      }
    }

    const locHeader = nsResult?.headers?.location || nsResult?.headers?.Location || ''
    const locId = locHeader.match(/\/(\d+)(?:\?.*)?$/)?.[1] || null
    const nsTransactionId = nsResult?.body?.id || nsResult?.body?.unbuildId || nsResult?.id || locId || null

    await record.update({ status: 'completed', nsTransactionId, processedAt: new Date(clock.now()) })
    await db.MesProcessingLog.create({
      eventType: 'separation_unbuild', sourceId: batchId,
      nsTransactionType: 'assemblyUnbuild', nsTransactionId,
      payload: JSON.stringify(data), result: JSON.stringify(nsResult), success: true,
    })

    console.log(`[MilkMesService] Batch ${batchId} completed — NS transaction: ${nsTransactionId}`)
    return { success: true, duplicate: false, batchId, nsTransactionId, summary: { ...summary, status: 'completed', nsTransactionId } }

  } catch (err) {
    console.error(`[MilkMesService] Failed to create unbuild for batch ${batchId}:`, err.message)
    // Log the exact rejected body so a "total inventory detail quantity must be
    // N" (assignment clamped / wrapper ignored) can be diagnosed without guessing
    // at the shape — mirrors the blend/surge issue diagnostics. body may be
    // undefined if we threw before building it.
    const rejectedBody = capturedBody
    if (rejectedBody) console.error(`[MilkMesService] rejected assemblyUnbuild body for batch ${batchId}: ${JSON.stringify(rejectedBody)}`)
    await record.update({ status: 'error', errorMessage: err.message, processedAt: new Date(clock.now()) })
    await db.MesProcessingLog.create({
      eventType: 'separation_unbuild', sourceId: batchId,
      nsTransactionType: 'assemblyUnbuild', nsTransactionId: null,
      payload: JSON.stringify(data),
      result: rejectedBody ? JSON.stringify({ rejectedBody }) : null,
      success: false, errorMessage: err.message,
    })
    err.summary = { ...summary, status: 'error', errorMessage: err.message }
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
        { custbody_liquid_milk_wo: true, component: { items: componentItems } }
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

  await run.update({ status: 'completed', completedAt: new Date(clock.now()) })

  console.log(`[MilkMesService] Completed bulk milk run: WO ${workOrderId} — Cream: ${run.cumulativeCream}, Skim: ${run.cumulativeSkim}`)
  return { success: true, workOrderId, cumulativeCream: parseFloat(run.cumulativeCream), cumulativeSkim: parseFloat(run.cumulativeSkim) }
}

async function getActiveBulkMilkRuns() {
  const runs = await db.MesBulkMilkRun.findAll({ where: { status: 'active' } })
  return { success: true, runs }
}

// Statuses an operator can act on from the Separation Review screen. pending_ns
// = couldn't resolve a BOM/item (e.g. skim silo on a raw index — Bug D); error
// = NS emit threw. 'skipped' (phantom 0-vol reopen) and terminal 'completed'
// are intentionally NOT retryable.
const RETRYABLE_SEPARATION_STATUSES = ['pending_ns', 'error']

/**
 * Re-run a failed/pending separation unbuild after an operator corrects the
 * product index(es) the resolution depends on. Patches the stored
 * siloProductConfig with the override(s), flips the row back to 'running' (so
 * processSeparationBatch will pick it up — it skips any non-running row), and
 * re-emits to NetSuite. Overrides are HMI product indices (1-40), the same
 * values the separator writes; the skim index is the usual fix (Bug D).
 */
async function retrySeparationBatch(id, overrides = {}) {
  const row = await db.MesSeparationBatch.findByPk(id)
  if (!row) throw new Error(`Separation batch ${id} not found`)
  if (!RETRYABLE_SEPARATION_STATUSES.includes(row.status)) {
    throw new Error(`Batch ${id} is '${row.status}' — only ${RETRYABLE_SEPARATION_STATUSES.join('/')} batches can be retried`)
  }

  const destsRaw = row.prevDestinationsJson ? JSON.parse(row.prevDestinationsJson).filter(Boolean) : []
  const siloProductConfig = row.prevIndexCodesJson ? JSON.parse(row.prevIndexCodesJson) : {}

  // Stamp a corrected product index onto a silo's config entry (keyed by the
  // raw SCADA string processSeparationBatch will look up). Pulls the canonical
  // name from PRODUCT_INDEX_ITEM_MAP for display.
  const setIdx = (siloKey, idx) => {
    if (siloKey == null || idx == null) return
    const n = Number(idx)
    siloProductConfig[siloKey] = {
      ...(siloProductConfig[siloKey] || {}),
      productIndex: n,
      productName: itemConfig.PRODUCT_INDEX_ITEM_MAP[n]?.name || siloProductConfig[siloKey]?.productName || '',
    }
  }

  if (overrides.sourceProductIndex != null) setIdx(row.sourceSilo, overrides.sourceProductIndex)
  if (overrides.skimProductIndex != null) {
    const skimRaw = destsRaw.find(r => itemConfig.classifySiloDestination(r) === 'skim')
    if (!skimRaw) throw new Error(`Batch ${id} has no skim (M-silo) destination to apply skimProductIndex to`)
    setIdx(skimRaw, overrides.skimProductIndex)
  }
  if (overrides.creamProductIndex != null) {
    const creamRaw = destsRaw.find(r => itemConfig.classifySiloDestination(r) === 'cream')
    if (creamRaw) setIdx(creamRaw, overrides.creamProductIndex)
  }

  // Flip to 'running' + persist the corrected config so processSeparationBatch
  // (which skips non-running rows) re-processes this one.
  await row.update({ status: 'running', errorMessage: null, prevIndexCodesJson: JSON.stringify(siloProductConfig) })

  const payload = {
    batchId: row.batchId,
    sourceSilo: row.sourceSilo,
    destinations: destsRaw,
    siloProductConfig,
    inputVolume: Number(row.inputVolume) || 0,
    creamVolume: Number(row.creamVolume) || 0,
    skimVolume: Number(row.skimVolume) || 0,
    batchStart: row.batchStart,
    batchEnd: row.batchEnd,
    itemId: row.itemId,
    transferName: row.transferName,
    unit: row.unit,
    targetVolume: row.targetVolume != null ? Number(row.targetVolume) : undefined,
    endReason: row.endReason,
  }

  const result = await processSeparationBatch(payload)
  const batch = await db.MesSeparationBatch.findByPk(id)
  // Retry runs OUTSIDE the separator state machine (which is what normally
  // pushes batch summaries into statusStore's recentBatches ring). Without this
  // the live status panel keeps rendering the stale pre-retry 'error' entry even
  // though the DB row is now 'completed'. Refresh the ring from the updated row.
  if (batch) statusStore.pushSeparationBatchFromDbRow(batch)
  return { result, batch }
}

/**
 * Dismiss a failed/pending separation batch the operator has decided not to
 * post (e.g. a sensor-glitch phantom, or a transfer already reconciled by
 * hand). Marks it 'rejected' so it leaves the review backlog.
 */
async function rejectSeparationBatch(id, { decidedBy, reason } = {}) {
  const row = await db.MesSeparationBatch.findByPk(id)
  if (!row) throw new Error(`Separation batch ${id} not found`)
  const who = decidedBy || 'unknown'
  await row.update({
    status: 'rejected',
    processedAt: new Date(clock.now()),
    errorMessage: reason ? `Rejected by ${who}: ${reason}` : `Rejected by ${who}`,
  })
  console.log(`[MilkMesService] Separation batch ${id} (${row.batchId}) rejected by ${who}`)
  // Same as retry: refresh the live ring so the rejected batch stops rendering
  // as an 'error' on the live status panel.
  statusStore.pushSeparationBatchFromDbRow(row)
  return row
}

module.exports = {
  processSeparationBatch,
  processBulkMilkFlow,
  registerBulkMilkRun,
  completeBulkMilkRun,
  getActiveBulkMilkRuns,
  retrySeparationBatch,
  rejectSeparationBatch,
  RETRYABLE_SEPARATION_STATUSES,
}
