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
const db = require('../models')
const statusStore = require('./statusStore')
const itemConfig = require('./mesItemConfig')
const milkMesService = require('./milkMesService')

const STATE_IDLE = 'idle'
const STATE_RUNNING = 'running'

const IDLE_RPM_THRESHOLD = 100
const TICKS_TO_CLOSE_ON_IDLE = 30 // 5 min @ 10s/tick
// Recovery fallback: if SM is IDLE but the separator is clearly running
// (feedPermit + RPM up + startable) for this many ticks, open a batch even
// without a rising edge. Catches the post-restart case where feedPermit was
// already true when the service came back up and no hydratable DB row existed.
const RECOVERY_TICKS_TO_OPEN = 6 // 60s @ 10s/tick

// End reasons that represent an in-flight boundary change (source/dest/product
// swap mid-run). Only these warrant a same-tick re-open — transfer_complete,
// cip_started, and the idle reasons mean the transfer is genuinely over, and
// re-opening on them creates a phantom batch that posts a duplicate NS unbuild.
const BOUNDARY_END_REASONS = new Set([
  'source_changed',
  'destination_changed',
  'product_index_changed',
])

let machineState = STATE_IDLE
let openBatchId = null
let prevSnapshot = null
let rpmLowTicks = 0
let feedPermitZeroTicks = 0
let runningWhileIdleTicks = 0

function reset() {
  machineState = STATE_IDLE
  openBatchId = null
  prevSnapshot = null
  rpmLowTicks = 0
  feedPermitZeroTicks = 0
  runningWhileIdleTicks = 0
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

async function openBatch(snap) {
  const sourceSilo = itemConfig.normalizeSiloName(snap.xfrSource) || snap.xfrSource
  const batchId = `XFR-${snap.pollTime.getTime()}`
  const destinationsJson = JSON.stringify(buildResolvedDestinations(snap))
  const row = await db.MesSeparationBatch.create({
    batchId,
    sourceSilo,
    inputVolume: snap.feedTotalLbs || 0,
    creamVolume: snap.creamTotalLbs || 0,
    skimVolume: snap.skimTotalLbs || 0,
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
}

async function persistTick(snap) {
  if (!openBatchId) return
  await db.MesSeparationBatch.update({
    inputVolume: snap.feedTotalLbs || 0,
    creamVolume: snap.creamTotalLbs || 0,
    skimVolume: snap.skimTotalLbs || 0,
    destinations: JSON.stringify(buildResolvedDestinations(snap)),
    prevSourceSilo: snap.xfrSource,
    prevDestinationsJson: JSON.stringify(snap.xfrDestinations),
    prevIndexCodesJson: JSON.stringify(snap.siloProductConfig),
    lastTickAt: snap.pollTime,
  }, { where: { id: openBatchId } })
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

  await db.MesSeparationBatch.update({
    inputVolume: snap.feedTotalLbs || row.inputVolume,
    creamVolume: snap.creamTotalLbs || row.creamVolume,
    skimVolume: snap.skimTotalLbs || row.skimVolume,
    batchEnd: snap.pollTime,
    endReason,
    lastTickAt: snap.pollTime,
  }, { where: { id: openBatchId } })

  console.log(`[SeparatorSM] CLOSE batch ${row.batchId} reason=${endReason} input=${Number(snap.feedTotalLbs).toFixed(1)} cream=${Number(snap.creamTotalLbs).toFixed(1)} skim=${Number(snap.skimTotalLbs).toFixed(1)}`)

  const closedBatchId = openBatchId
  openBatchId = null
  machineState = STATE_IDLE
  rpmLowTicks = 0
  feedPermitZeroTicks = 0

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
        await openBatch(snap)
      }
    } else {
      await persistTick(snap)
    }
  } else if (machineState === STATE_IDLE) {
    if (feedPermitRisingEdge(prevSnapshot, snap) && canStart(snap)) {
      await openBatch(snap)
    } else if (snap.feedPermit && (Number(snap.motorRpm) || 0) >= IDLE_RPM_THRESHOLD && canStart(snap)) {
      // Recovery: equipment is already running but we never saw a rising edge
      // (e.g., MES restarted while separator was active and no DB row was
      // hydratable). Open once we've seen sustained running.
      runningWhileIdleTicks++
      if (runningWhileIdleTicks >= RECOVERY_TICKS_TO_OPEN) {
        console.log(`[SeparatorSM] RECOVERY open: feedPermit+RPM held for ${runningWhileIdleTicks} ticks without rising edge`)
        statusStore.pushEvent('separation.recovery', `Opened batch via recovery fallback (no rising edge)`, {
          motorRpm: snap.motorRpm,
          source: snap.xfrSource,
          destinations: snap.xfrDestinations.filter(Boolean),
        })
        await openBatch(snap)
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
