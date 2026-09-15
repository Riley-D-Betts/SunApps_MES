/**
 * Separator batch lifecycle state machine.
 *
 * Replaces the old TransferComplete edge-only trigger with a per-tick state
 * machine that detects start, live progress, and all seven end reasons
 * (transfer_complete, source_changed, destination_changed,
 * product_index_changed, cip_started, idle_rpm, idle_feedpermit).
 *
 * See BATCH_LIFECYCLE_PLAN.md §2 for the full spec.
 */
const { Op } = require('sequelize')
const db = require('../models')
const statusStore = require('./statusStore')
const itemConfig = require('./mesItemConfig')
const milkMesService = require('./milkMesService')
const batchStartFinder = require('./batchStartFinder')
const { newTotalizerState, advanceTotalizer, RESET_MIN_DROP } = require('./separatorTotalizer')
const clock = require('../sim/clock')

const STATE_IDLE = 'idle'
const STATE_RUNNING = 'running'

const IDLE_RPM_THRESHOLD = 100
const TICKS_TO_CLOSE_ON_IDLE = 30 // 5 min @ 10s/tick
// Below this baselined input (lbs) a closed batch is treated as a phantom
// reopen (no new flow over its window) and skipped rather than emitted to NS.
const SEPARATION_MIN_INPUT_LBS = 1
// Mass-balance guard: cream+skim can't exceed feed input (+ small tolerance for
// rounding / density / measurement). When it does, the totalizer windows didn't
// line up (e.g. cream/skim per-batch totals over a different span than the feed
// odometer delta) — hold the batch for review instead of posting a physically
// impossible unbuild that conjures inventory into NS. See SD-597.
const MASS_BALANCE_TOLERANCE = 0.02
// Recovery fallback: if SM is IDLE but the separator is clearly running
// (feedPermit + RPM up + startable) for this many ticks, open a batch even
// without a rising edge. Catches the post-restart case where feedPermit was
// already true when the service came back up and no hydratable DB row existed.
const RECOVERY_TICKS_TO_OPEN = 6 // 60s @ 10s/tick

// End reasons that represent an in-flight boundary change (source/dest swap
// mid-run). Only these warrant a same-tick re-open — transfer_complete,
// cip_started, and the idle reasons mean the transfer is genuinely over, and
// re-opening on them creates a phantom batch that posts a duplicate NS unbuild.
// product_index_changed is intentionally excluded: a label/index update on an
// existing silo is a SCADA configuration change, not a physical pipe re-route.
// Re-opening same-tick on it creates a duplicate batch with identical volumes
// (the totalizer doesn't reset on index change). Close the batch normally and
// wait for the next feedPermit rising edge to start a fresh one.
const BOUNDARY_END_REASONS = new Set([
  'source_changed',
  'destination_changed',
])

let machineState = STATE_IDLE
let openBatchId = null
let prevSnapshot = null
let rpmLowTicks = 0
let feedPermitZeroTicks = 0
let runningWhileIdleTicks = 0
// Per-totalizer state for the open batch: { feed, cream, skim } each
// { baseline, last, first, zeroSince, resetSeen } (services/separatorTotalizer).
// Batch volume = reading − baseline. The separator totalizers are PER-TRANSFER
// counters that SCADA zeroes shortly AFTER the feed-permit edge (SD-722), so
// the baseline moves when a reset is observed: 0 for the transfer's own start
// reset, −(volume so far) for a later one. The baseline is persisted to the row
// (feed/cream/skimStartLbs, may be ≤ 0) and the state rebuilt on hydrate.
let openTot = null
// MES open time of the open batch (ms) — start of the reset grace window.
let openedAtMs = null

function reset() {
  machineState = STATE_IDLE
  openBatchId = null
  prevSnapshot = null
  rpmLowTicks = 0
  feedPermitZeroTicks = 0
  runningWhileIdleTicks = 0
  openTot = null
  openedAtMs = null
}

// [state key, snapshot reading, baseline column, volume column]
const TOTALIZERS = [
  ['feed', 'feedTotalLbs', 'feedStartLbs', 'inputVolume'],
  ['cream', 'creamTotalLbs', 'creamStartLbs', 'creamVolume'],
  ['skim', 'skimTotalLbs', 'skimStartLbs', 'skimVolume'],
]

// Columns are DECIMAL(·,2). Round before writing: Sequelize types a JS float
// as NUMERIC(30, <digits in its binary tail>), and an accumulated value like
// 1916067.1199999999 gets scale 10, overflowing tedious's 64-bit encoding
// ("Input parameter 'N' could not be validated" — seen in the SD-722 mock run).
const round2 = v => Math.round((Number(v) || 0) * 100) / 100

// Open-batch MES open time: batchId is `XFR-<pollTime ms>` (survives hydrate
// and replay, unlike createdAt which is wall time).
function openTimeMsFromRow(row) {
  const ms = Number(String(row.batchId || '').split('-')[1])
  if (isFinite(ms) && ms > 0) return ms
  return row.batchStart ? new Date(row.batchStart).getTime() : null
}

// Rebuild totalizer state from a persisted row (hydrate / close without
// in-memory state). last = baseline + volume is the invariant advanceTotalizer
// keeps; first = baseline so the persisted volume counts as observed rise; a
// baseline ≤ 0 means this batch already handled its start reset.
function totStateFromRow(row) {
  const st = {}
  for (const [k, , col, volCol] of TOTALIZERS) {
    const baseline = Number(row[col]) || 0
    const last = baseline + (Number(row[volCol]) || 0)
    st[k] = { baseline, last: last || null, first: baseline || null, zeroSince: null, resetSeen: baseline <= 0, hydrated: true }
  }
  return st
}

/**
 * Advance the open batch's three totalizers by this tick's readings with
 * reset detection (SD-722). Replaces the old `current − baseline` (with a
 * `current < baseline → current` fallback) which could not see a reset once
 * the new transfer's total out-ran the previous transfer's: batch 61 posted
 * cream 9,710 / skim 82,545 lb against a real 28,503 / 318,367.
 *
 * Mutates openTot. Returns { volumes: {feed,cream,skim}, baselineUpdate }
 * where baselineUpdate carries only baseline columns moved by a reset.
 */
function advanceVolumes(snap) {
  const now = snap.pollTime instanceof Date ? snap.pollTime.getTime() : Date.now()
  const volumes = {}
  const baselineUpdate = {}
  for (const [k, snapKey, col] of TOTALIZERS) {
    const prev = openTot[k]
    const { volume, reset, inGrace, ...next } = advanceTotalizer(prev, snap[snapKey], now, openedAtMs)
    openTot[k] = next
    volumes[k] = round2(volume)
    if (reset) {
      baselineUpdate[col] = round2(next.baseline)
      console.warn(`[SeparatorSM] ${k} totalizer reset on batch ${openBatchId}: ${prev.last} → ${snap[snapKey]} (${next.baseline === 0 ? 'transfer start, counting from 0' : 'later transfer, keeping volume so far'}${inGrace ? ', in start grace' : ''})`)
    }
  }
  return { volumes, baselineUpdate }
}

/**
 * Build the rich destinations JSON shape the dashboard (summaryFromDbRow)
 * expects: { raw, resolved, source } with per-side NS item + bin resolution.
 * Mirrors what milkMesService.processSeparationBatch produces at close, but
 * runs every tick so live "running" batches render cleanly instead of showing
 * "no item · no bin" in red until close fires.
 */
function buildResolvedDestinations(snap) {
  const sourceRaw = snap.xfrSource || ''
  const sourceSilo = itemConfig.normalizeSiloName(sourceRaw) || sourceRaw
  const cfg = snap.siloProductConfig || {}
  const lookupCfg = (name) => (name && (cfg[name] || cfg[itemConfig.normalizeSiloName(name) || ''])) || {}

  const sourceCfg = lookupCfg(sourceRaw)
  const sourceIndex = sourceCfg.productIndex || 0
  const sourceName = sourceCfg.productName || ''
  const sourceItem = sourceIndex
    ? itemConfig.getItemByProductIndex(sourceIndex)
    : itemConfig.getItem(snap.xfrItemId, sourceSilo)
  const sourceBinId = sourceSilo ? itemConfig.getBinId(sourceSilo) : null

  const destsRaw = (snap.xfrDestinations || []).filter(Boolean)
  const resolved = destsRaw.map(raw => {
    const silo = itemConfig.normalizeSiloName(raw)
    const kind = itemConfig.classifySiloDestination(raw)
    const dcfg = lookupCfg(raw)
    const idx = dcfg.productIndex || 0
    // Cream item is determined by source, not by the cream silo's productIndex
    // (which is operator-set on the HMI and often stale).
    const item = kind === 'cream'
      ? itemConfig.getCreamItemForSource(sourceItem.id)
      : (idx ? itemConfig.getItemByProductIndex(idx) : { id: null, name: '' })
    return {
      raw,
      silo,
      kind,
      binId: silo ? itemConfig.getBinId(silo) : null,
      productIndex: idx,
      productName: dcfg.productName || '',
      item,
    }
  })

  return {
    raw: destsRaw,
    resolved,
    source: {
      silo: sourceSilo,
      productIndex: sourceIndex,
      productName: sourceName,
      nsItemId: sourceItem.id || null,
      nsItemName: sourceItem.name || null,
      binId: sourceBinId,
    },
  }
}

function destinationsChanged(prev, curr) {
  for (let i = 0; i < 4; i++) {
    const a = prev[i] || ''
    const b = curr[i] || ''
    if (a && b && a !== b) return true
  }
  return false
}

function indexCodesChanged(prevCfg, currCfg, participatingSilos) {
  for (const silo of participatingSilos) {
    if (!silo) continue
    const a = prevCfg[silo]?.productIndex ?? 0
    const b = currCfg[silo]?.productIndex ?? 0
    if (a !== 0 && b !== 0 && a !== b) return true
  }
  return false
}

function inCip(snap) {
  return !!(snap.cipChemReq || snap.cipRinseReq)
}

function canStart(snap) {
  return snap.feedPermit && !inCip(snap) && !!snap.xfrSource
}

function feedPermitRisingEdge(prev, curr) {
  if (!prev) return false
  return curr.feedPermit && !prev.feedPermit
}

async function openBatch(snap, historian, { backfill = true } = {}) {
  const sourceSilo = itemConfig.normalizeSiloName(snap.xfrSource) || snap.xfrSource
  const batchId = `XFR-${snap.pollTime.getTime()}`
  const destinationsJson = JSON.stringify(buildResolvedDestinations(snap))
  // Baseline the totalizers at open. Volumes start at 0 and grow as
  // (current − baseline); without this a re-opened batch re-counts the whole
  // cumulative total and posts a duplicate unbuild.
  // SD-722: these open readings are usually the PREVIOUS transfer's held
  // totals — the per-tick reset detection re-baselines when SCADA zeroes them.
  openTot = {
    feed: newTotalizerState(snap.feedTotalLbs, snap.feedTotalLbs),
    cream: newTotalizerState(snap.creamTotalLbs, snap.creamTotalLbs),
    skim: newTotalizerState(snap.skimTotalLbs, snap.skimTotalLbs),
  }
  openedAtMs = snap.pollTime.getTime()
  const row = await db.MesSeparationBatch.create({
    batchId,
    sourceSilo,
    inputVolume: 0,
    creamVolume: 0,
    skimVolume: 0,
    feedStartLbs: round2(openTot.feed.baseline),
    creamStartLbs: round2(openTot.cream.baseline),
    skimStartLbs: round2(openTot.skim.baseline),
    batchStart: snap.pollTime,
    batchEnd: null,
    transferName: snap.xfrTransferName || null,
    destinations: destinationsJson,
    itemId: snap.xfrItemId || null,
    unit: snap.xfrUnit || null,
    targetVolume: snap.xfrQtyTarget ?? null,
    status: 'running',
    prevSourceSilo: snap.xfrSource,
    prevDestinationsJson: JSON.stringify(snap.xfrDestinations),
    prevIndexCodesJson: JSON.stringify(snap.siloProductConfig),
    lastTickAt: snap.pollTime,
  })
  openBatchId = row.id
  machineState = STATE_RUNNING
  rpmLowTicks = 0
  feedPermitZeroTicks = 0
  runningWhileIdleTicks = 0
  console.log(`[SeparatorSM] OPEN batch ${batchId} sourceSilo=${sourceSilo} dest=${snap.xfrDestinations.filter(Boolean).join(', ')}`)
  statusStore.pushEvent('separation.start', `Opened separation batch ${batchId}`, {
    batchId, sourceSilo, destinations: snap.xfrDestinations.filter(Boolean),
  })

  // Fire-and-forget: crawl back to the sustained FEEDPERMIT-on edge and correct
  // ALL THREE baselines (feed/cream/skim) to their totalizer readings there, so
  // the input window matches the cream/skim per-batch totalizers and milk that
  // flowed before MES detected the batch isn't missed. Skipped on boundary
  // re-opens: the boundary instant IS the true edge, and crawling back would
  // pull the baseline across the boundary into the previous segment.
  if (!backfill) return
  const _rowId = row.id
  const _openFeed = snap.feedTotalLbs || 0
  batchStartFinder.findSeparationActualStart(snap.pollTime, historian)
    .then(async result => {
      if (!result) return
      // Guard against the batch closing before the backfinder returned
      if (openBatchId !== _rowId) return
      const update = { batchStart: result.estimatedStartAt }
      const applied = {}
      const found = { feed: result.feedStart, cream: result.creamStart, skim: result.skimStart }
      for (const [k, , col] of TOTALIZERS) {
        const fv = found[k]
        if (fv == null || !isFinite(fv)) continue
        // SD-722: a tick already saw this totalizer reset → its baseline is
        // authoritative; the finder's edge reading is from before the reset.
        const st = openTot[k]
        if (st.resetSeen) continue
        let b = fv
        // The finder saw a reset between edge and open, or its (lagging)
        // history shows a value ABOVE the latest live reading (null = only
        // zeros seen so far, i.e. already reset) — impossible for a counter
        // unless it reset in between — so count from the reset.
        if (result.resetSeen?.[k] || fv > (st.last ?? 0) + RESET_MIN_DROP) {
          b = 0
          st.resetSeen = true
        }
        st.baseline = b
        update[col] = round2(b)
        applied[k] = b
      }
      await db.MesSeparationBatch.update(update, { where: { id: _rowId } })
      const f = v => (v != null ? v.toFixed(1) : '—')
      console.log(`[SeparatorSM] Back-projected ${batchId} start: ${result.estimatedStartAt.toISOString()}, feedStart: ${f(applied.feed)} lb (was ${_openFeed.toFixed(1)}), creamStart: ${f(applied.cream)}, skimStart: ${f(applied.skim)}`)
    })
    .catch(err => console.warn(`[SeparatorSM] actualStart finder failed for ${batchId}: ${err.message}`))
}

async function persistTick(snap) {
  if (!openBatchId) return
  const { volumes, baselineUpdate } = advanceVolumes(snap)
  await db.MesSeparationBatch.update({
    inputVolume: volumes.feed,
    creamVolume: volumes.cream,
    skimVolume: volumes.skim,
    ...baselineUpdate,
    destinations: JSON.stringify(buildResolvedDestinations(snap)),
    prevSourceSilo: snap.xfrSource,
    prevDestinationsJson: JSON.stringify(snap.xfrDestinations),
    prevIndexCodesJson: JSON.stringify(snap.siloProductConfig),
    lastTickAt: snap.pollTime,
  }, { where: { id: openBatchId } })
  // Keep the dashboard's recentBatches ring in sync with the freshly-persisted
  // row. Without this, in-flight batches show stale volumes (last hydrated
  // value) until close — the separator card and the batch row diverge.
  const refreshed = await db.MesSeparationBatch.findByPk(openBatchId)
  if (refreshed) statusStore.pushSeparationBatchFromDbRow(refreshed)
}

async function closeBatch(snap, endReason) {
  if (!openBatchId) return
  const row = await db.MesSeparationBatch.findByPk(openBatchId)
  if (!row) {
    console.warn(`[SeparatorSM] CLOSE requested but openBatchId=${openBatchId} not in DB`)
    openBatchId = null
    machineState = STATE_IDLE
    return
  }

  // Use the LAST known good values for source/destinations/index — when the
  // close is triggered by a boundary change, prev* fields hold the values at
  // the previous tick (the batch we're closing), while snap.* already holds
  // the new state that fired the boundary.
  const sourceSilo = row.prevSourceSilo || row.sourceSilo
  const prevDests = row.prevDestinationsJson ? JSON.parse(row.prevDestinationsJson) : snap.xfrDestinations
  const prevIndexCodes = row.prevIndexCodesJson ? JSON.parse(row.prevIndexCodesJson) : snap.siloProductConfig

  // Reset-aware volumes (SD-722): same per-tick step as persistTick, so a reset
  // on the close tick is detected rather than subtracted. A falsy close reading
  // (dropout, or a reset still at 0) holds the last volume so we don't zero out
  // a real batch.
  if (!openTot) {
    openTot = totStateFromRow(row)
    openedAtMs = openTimeMsFromRow(row)
  }
  const { volumes, baselineUpdate } = advanceVolumes(snap)
  const closeInput = volumes.feed
  const closeCream = volumes.cream
  const closeSkim = volumes.skim

  await db.MesSeparationBatch.update({
    inputVolume: closeInput,
    creamVolume: closeCream,
    skimVolume: closeSkim,
    ...baselineUpdate,
    batchEnd: snap.pollTime,
    endReason,
    lastTickAt: snap.pollTime,
  }, { where: { id: openBatchId } })

  console.log(`[SeparatorSM] CLOSE batch ${row.batchId} reason=${endReason} input=${closeInput.toFixed(1)} cream=${closeCream.toFixed(1)} skim=${closeSkim.toFixed(1)}`)

  const closedBatchId = openBatchId
  openBatchId = null
  openTot = null
  openedAtMs = null
  machineState = STATE_IDLE
  rpmLowTicks = 0
  feedPermitZeroTicks = 0

  // Phantom-reopen guard: a batch that opened on a flat totalizer (idle reopen /
  // boundary swap / recovery with no new flow) baselines to ~0 input. Skip the
  // NS emit entirely and mark it 'skipped' so it doesn't post a 0-qty unbuild
  // (processSeparationBatch would throw "inputVolume must be > 0") or clutter the
  // error log. This is the no-duplicate outcome the baselining is for.
  if (closeInput < SEPARATION_MIN_INPUT_LBS) {
    console.log(`[SeparatorSM] SKIP emit for batch ${row.batchId} — baselined input ${closeInput.toFixed(1)} lb below ${SEPARATION_MIN_INPUT_LBS} lb floor (phantom reopen, no new flow)`)
    await db.MesSeparationBatch.update(
      { status: 'skipped', errorMessage: `no flow over batch window (input ${closeInput.toFixed(1)} lb)` },
      { where: { id: closedBatchId } },
    )
    const skipped = await db.MesSeparationBatch.findByPk(closedBatchId)
    if (skipped) statusStore.pushSeparationBatchFromDbRow(skipped)
    statusStore.pushEvent('separation.end', `Closed separation batch ${row.batchId} (${endReason}) — skipped, no flow`, {
      batchId: row.batchId, endReason, status: 'skipped',
    })
    return
  }

  // Mass-balance guard: outputs (cream+skim) can't exceed input. When they do,
  // the totalizer windows are misaligned — hold for review instead of posting an
  // unbuild that would conjure phantom inventory into NetSuite.
  const closeOutput = closeCream + closeSkim
  if (closeOutput > closeInput * (1 + MASS_BALANCE_TOLERANCE)) {
    const reason = `mass balance: cream+skim ${closeOutput.toFixed(0)} lb > input ${closeInput.toFixed(0)} lb (out/in ${(closeOutput / closeInput).toFixed(2)}) — totalizer window mismatch, held for review`
    console.warn(`[SeparatorSM] HOLD batch ${row.batchId} — ${reason}`)
    await db.MesSeparationBatch.update(
      { status: 'pending_ns', errorMessage: reason },
      { where: { id: closedBatchId } },
    )
    const held = await db.MesSeparationBatch.findByPk(closedBatchId)
    if (held) statusStore.pushSeparationBatchFromDbRow(held)
    statusStore.pushEvent('separation.end', `Closed separation batch ${row.batchId} (${endReason}) — held for review (mass balance)`, {
      batchId: row.batchId, endReason, status: 'pending_ns',
    })
    return
  }

  // Hand off to the NS-emit path. Re-load the row to pass the canonical
  // payload shape it expects.
  try {
    const updated = await db.MesSeparationBatch.findByPk(closedBatchId)
    const payload = {
      batchId: updated.batchId,
      sourceSilo: updated.sourceSilo,
      destinations: prevDests.filter(Boolean),
      siloProductConfig: prevIndexCodes,
      inputVolume: Number(updated.inputVolume) || 0,
      creamVolume: Number(updated.creamVolume) || 0,
      skimVolume: Number(updated.skimVolume) || 0,
      batchStart: updated.batchStart,
      batchEnd: updated.batchEnd,
      itemId: updated.itemId,
      transferName: updated.transferName,
      unit: updated.unit,
      targetVolume: updated.targetVolume != null ? Number(updated.targetVolume) : undefined,
      endReason,
    }
    const result = await milkMesService.processSeparationBatch(payload)
    if (result.summary) statusStore.pushSeparationBatch(result.summary)
    statusStore.pushEvent('separation.end', `Closed separation batch ${updated.batchId} (${endReason})`, {
      batchId: updated.batchId, endReason, status: result.status,
    })
  } catch (err) {
    console.error(`[SeparatorSM] NS-emit failed for batch ${closedBatchId}: ${err.message}`)
    try {
      await db.MesSeparationBatch.update(
        { status: 'error', errorMessage: err.message },
        { where: { id: closedBatchId } },
      )
    } catch (updateErr) {
      console.error(`[SeparatorSM] Could not mark batch ${closedBatchId} as error: ${updateErr.message}`)
    }
    if (err.summary) statusStore.pushSeparationBatch(err.summary)
    statusStore.pushEvent('separation.batch.error', `NS emit failed for closed batch`, { error: err.message })
  }
}

/**
 * Determine end reason given the previous snapshot, current snapshot, and
 * idle-counter state. Returns null if no end condition fires. Order matters:
 * transfer_complete and cip_started are explicit operator/recipe signals and
 * take priority over boundary detections; idle is last.
 */
function evaluateEndReason(prev, curr, participatingSilos) {
  if (curr.xfrTransferCompleteRising) return 'transfer_complete'
  if (inCip(curr)) return 'cip_started'
  if (prev) {
    if (prev.xfrSource && curr.xfrSource && prev.xfrSource !== curr.xfrSource) return 'source_changed'
    if (prev.xfrSource && !curr.xfrSource) return 'source_changed'
    if (destinationsChanged(prev.xfrDestinations, curr.xfrDestinations)) return 'destination_changed'
    if (indexCodesChanged(prev.siloProductConfig || {}, curr.siloProductConfig || {}, participatingSilos)) return 'product_index_changed'
  }
  if (rpmLowTicks >= TICKS_TO_CLOSE_ON_IDLE) return 'idle_rpm'
  if (feedPermitZeroTicks >= TICKS_TO_CLOSE_ON_IDLE) return 'idle_feedpermit'
  return null
}

async function tick(historian) {
  let snap
  try {
    snap = await historian.getSeparatorTickSnapshot()
  } catch (err) {
    console.error(`[SeparatorSM] Snapshot read failed: ${err.message}`)
    statusStore.pushEvent('separation.poll.error', 'Historian poll failed', { error: err.message })
    return
  }

  // Idle counters tick regardless of state — used for "low RPM 5 min" and
  // "feedPermit=0 5 min" end conditions. Reset whenever the condition isn't met.
  if (snap.motorRpm < IDLE_RPM_THRESHOLD) rpmLowTicks++
  else rpmLowTicks = 0
  if (!snap.feedPermit) feedPermitZeroTicks++
  else feedPermitZeroTicks = 0

  if (machineState === STATE_RUNNING) {
    const participatingSilos = [snap.xfrSource, ...snap.xfrDestinations].filter(Boolean)
    const reason = evaluateEndReason(prevSnapshot, snap, participatingSilos)
    if (reason) {
      await closeBatch(snap, reason)
      // Same-tick re-open: only valid for boundary changes (source/dest/product
      // swap), where the close itself is the start of a new transfer. For
      // transfer_complete / cip_started / idle_* the transfer is over — a new
      // batch must wait for the next feed-permit rising edge in STATE_IDLE.
      if (BOUNDARY_END_REASONS.has(reason) && canStart(snap)) {
        // Boundary re-open: the boundary instant is the true segment edge, so
        // baseline off the live snap — don't crawl back across the boundary.
        await openBatch(snap, historian, { backfill: false })
      }
    } else {
      await persistTick(snap)
    }
  } else if (machineState === STATE_IDLE) {
    if (feedPermitRisingEdge(prevSnapshot, snap) && canStart(snap)) {
      await openBatch(snap, historian)
    } else if (snap.feedPermit && (Number(snap.motorRpm) || 0) >= IDLE_RPM_THRESHOLD && canStart(snap)) {
      // Recovery: equipment is already running but we never saw a rising edge
      // (e.g., MES restarted while separator was active and no DB row was
      // hydratable). Open once we've seen sustained running.
      runningWhileIdleTicks++
      if (runningWhileIdleTicks >= RECOVERY_TICKS_TO_OPEN) {
        console.log(`[SeparatorSM] RECOVERY attempt: feedPermit+RPM held for ${runningWhileIdleTicks} ticks without rising edge`)
        // Reset BEFORE awaiting openBatch so a thrown error doesn't leave the
        // counter pinned ≥ threshold and spam an open attempt every tick. On
        // failure we throttle back to one attempt per recovery window.
        runningWhileIdleTicks = 0
        try {
          // Guard: if a recent failed/pending batch from the same source silo
          // has volumes within 5% of current, the separator is still running
          // the same physical transfer that MES already recorded before restart.
          // Suppress re-open to avoid a duplicate batch with identical volumes.
          const sourceSiloForGuard = itemConfig.normalizeSiloName(snap.xfrSource) || snap.xfrSource
          const recentFailed = sourceSiloForGuard ? await db.MesSeparationBatch.findOne({
            where: {
              sourceSilo: sourceSiloForGuard,
              status: { [Op.in]: ['error', 'pending_ns', 'pending'] },
              lastTickAt: { [Op.gte]: new Date(clock.now() - 8 * 60 * 60 * 1000) },
            },
            order: [['lastTickAt', 'DESC']],
          }) : null
          if (recentFailed) {
            const prevVol = Number(recentFailed.inputVolume) || 0
            const currVol = Number(snap.feedTotalLbs) || 0
            const maxVol = Math.max(prevVol, currVol, 1)
            if (Math.abs(prevVol - currVol) / maxVol < 0.05) {
              console.log(`[SeparatorSM] RECOVERY suppressed: recent ${recentFailed.status} batch ${recentFailed.batchId} has matching volumes (prev=${prevVol} curr=${currVol} lbs) — same physical run`)
              statusStore.pushEvent('separation.recovery.suppressed', `Recovery suppressed (duplicate volume guard)`, {
                existingBatchId: recentFailed.batchId, prevVol, currVol,
              })
            } else {
              await openBatch(snap, historian)
              statusStore.pushEvent('separation.recovery', `Opened batch via recovery fallback (no rising edge)`, {
                motorRpm: snap.motorRpm, source: snap.xfrSource, destinations: snap.xfrDestinations.filter(Boolean),
              })
            }
          } else {
            await openBatch(snap, historian)
            statusStore.pushEvent('separation.recovery', `Opened batch via recovery fallback (no rising edge)`, {
              motorRpm: snap.motorRpm, source: snap.xfrSource, destinations: snap.xfrDestinations.filter(Boolean),
            })
          }
        } catch (err) {
          console.error(`[SeparatorSM] RECOVERY open failed: ${err.message}`)
          statusStore.pushEvent('separation.recovery.error', `Recovery open failed: ${err.message}`, {
            motorRpm: snap.motorRpm,
            source: snap.xfrSource,
            destinations: snap.xfrDestinations.filter(Boolean),
            stack: err.stack,
          })
        }
      }
    } else {
      runningWhileIdleTicks = 0
    }
  }

  prevSnapshot = snap
  setSeparatorStatusSnapshot(snap)
}

function setSeparatorStatusSnapshot(snap) {
  statusStore.setSeparator({
    state: machineState,
    openBatchId,
    feedPermit: snap.feedPermit ? 1 : 0,
    motorRpm: snap.motorRpm,
    cipChemReq: snap.cipChemReq,
    cipRinseReq: snap.cipRinseReq,
    creamFlowGpm: snap.creamFlowGpm,
    skimFlowGpm: snap.skimFlowGpm,
    feedTotalLbs: snap.feedTotalLbs,
    creamTotalLbs: snap.creamTotalLbs,
    skimTotalLbs: snap.skimTotalLbs,
    source: snap.xfrSource,
    destinations: snap.xfrDestinations.filter(Boolean),
    transferName: snap.xfrTransferName,
    itemId: snap.xfrItemId,
    rpmLowTicks,
    feedPermitZeroTicks,
    runningWhileIdleTicks,
    recoveryTicksToOpen: RECOVERY_TICKS_TO_OPEN,
  })
}

/**
 * On startup, resume any in-flight batch persisted as status='running'. The
 * historian doesn't expose "we were in the middle of a batch" — only what's
 * currently flowing — so the DB row is the only source of truth for resume.
 */
async function hydrateFromDb() {
  try {
    const row = await db.MesSeparationBatch.findOne({
      where: { status: 'running' },
      order: [['lastTickAt', 'DESC']],
    })
    if (!row) {
      console.log('[SeparatorSM] No open batch to resume')
      return
    }
    openBatchId = row.id
    machineState = STATE_RUNNING
    // Restore the totalizer baselines + reset-detection state (SD-722) so the
    // resumed batch keeps computing volume as (reading − baseline). Null
    // baselines on pre-baseline rows → 0. Resets during downtime are still
    // caught on the first tick as a drop below baseline + persisted volume.
    openTot = totStateFromRow(row)
    openedAtMs = openTimeMsFromRow(row)
    // Seed prevSnapshot from the stored snapshot fields so boundary detection
    // has a baseline. The first tick after hydrate will repopulate it fully.
    const prevDests = row.prevDestinationsJson ? JSON.parse(row.prevDestinationsJson) : ['', '', '', '']
    const prevCfg = row.prevIndexCodesJson ? JSON.parse(row.prevIndexCodesJson) : {}
    prevSnapshot = {
      pollTime: row.lastTickAt || row.batchStart,
      feedPermit: true,
      motorRpm: 0,
      cipChemReq: false,
      cipRinseReq: false,
      feedTotalLbs: Number(row.inputVolume) || 0,
      creamTotalLbs: Number(row.creamVolume) || 0,
      skimTotalLbs: Number(row.skimVolume) || 0,
      xfrSource: row.prevSourceSilo || row.sourceSilo,
      xfrItemId: row.itemId || '',
      xfrTransferName: row.transferName || '',
      xfrDestinations: prevDests,
      xfrTransferCompleteRising: false,
      siloProductConfig: prevCfg,
    }
    console.log(`[SeparatorSM] Resumed open batch ${row.batchId} (id=${row.id}) sourceSilo=${row.sourceSilo}`)
  } catch (err) {
    console.error(`[SeparatorSM] Hydrate failed: ${err.message}`)
  }
}

function getState() {
  return { machineState, openBatchId, rpmLowTicks, feedPermitZeroTicks, runningWhileIdleTicks }
}

module.exports = {
  tick,
  hydrateFromDb,
  getState,
  reset,
}
