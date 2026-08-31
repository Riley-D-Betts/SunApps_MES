/**
 * In-memory snapshot of the latest state from each poller plus a rolling
 * event log. The polling jobs write here at the end of every cycle; routes
 * read from it to expose a live view to the frontend.
 *
 * Everything is ephemeral — cleared on process restart. This is a view into
 * "what is MES_Service seeing right now", not a durable history store.
 * (Use the poll-store or DB for durable history.)
 */

const clock = require('../sim/clock')

const MAX_EVENTS = 500
const MAX_RECENT_BATCHES = 20
const MAX_RECENT_TANK_BATCHES = 25

const state = {
  separator: null,                 // { status, recentBatchCount, pollDurationMs, pollAt }
  blendTanks: null,                // { tanks: [...], lines: [...], pollDurationMs, pollAt }
  bulkMilk: null,                  // { reading, creamTotal, skimTotal, pollDurationMs, pollAt }
  silos: null,                     // { silos: [...], pollDurationMs, pollAt }
  uhts: null,                      // { uhts: [...], pollDurationMs, pollAt }
  surgeTanks: null,                // { tanks: [...], pollDurationMs, pollAt }
  fillers: null,                   // { fillers: [...], pollDurationMs, pollAt }
  lastPoll: {
    separator: null,
    blendTank: null,
    bulkMilk: null,
    equipment: null,
  },
  events: [],                      // newest first
  recentBatches: [],               // newest first; each entry is a processed separator batch
  recentBlendBatches: [],          // newest first; completed/closed MesBlendTankBatch rows
  recentSurgeBatches: [],          // newest first; completed/closed MesSurgeTankBatch rows
  // Authoritative tick state. Shape:
  //   { batches: [blend], pipeStates: { [line]: ... },
  //     surgeBatches: [surge], surgeIssueStates: { [tankId]: ... }, updatedAt }
  tick: null,
}

function now() {
  return new Date(clock.now()).toISOString()
}

function pushEvent(type, message, data) {
  state.events.unshift({ t: now(), type, message, data: data ?? null })
  if (state.events.length > MAX_EVENTS) state.events.length = MAX_EVENTS
}

function setSeparator(snapshot) {
  state.separator = { ...snapshot, pollAt: now() }
  state.lastPoll.separator = state.separator.pollAt
}

function setBlendTanks(snapshot) {
  state.blendTanks = { ...snapshot, pollAt: now() }
  state.lastPoll.blendTank = state.blendTanks.pollAt
}

function setBulkMilk(snapshot) {
  state.bulkMilk = { ...snapshot, pollAt: now() }
  state.lastPoll.bulkMilk = state.bulkMilk.pollAt
}

function setSilos(snapshot) {
  state.silos = { ...snapshot, pollAt: now() }
  state.lastPoll.equipment = state.silos.pollAt
}

function setUhts(snapshot) {
  state.uhts = { ...snapshot, pollAt: now() }
  state.lastPoll.equipment = state.uhts.pollAt
}

function setSurgeTanks(snapshot) {
  state.surgeTanks = { ...snapshot, pollAt: now() }
  state.lastPoll.equipment = state.surgeTanks.pollAt
}

function setFillers(snapshot) {
  state.fillers = { ...snapshot, pollAt: now() }
  state.lastPoll.equipment = state.fillers.pollAt
}

/**
 * Record a processed separation batch. Kept as a ring buffer (newest first)
 * so the dashboard can render the last N runs without a DB query. Each entry
 * captures the resolved source/cream/skim products + NS item + bin so an
 * operator can see at a glance whether the unbuild made it to NetSuite.
 */
/**
 * Snapshot of issue/completion tick state. Written by issueCompletionJob at
 * the end of each tick (and once on startup via hydrateTickState). The
 * dashboard reads this to render per-line "pending delta" / per-tank
 * "cumulative completed" without hitting the DB on every snapshot read.
 *
 * Shape:
 *   {
 *     batches: [{ batchId, tankId, productName, nsWorkOrderId, nsWorkOrderNumber,
 *                 cumulativeIssuedLbs, cumulativeCompletedLbs,
 *                 lastIssueAt, lastCompletionAt }],
 *     pipeStates: { [line]: { batchId, tankId, lastIssuedTotalizerLbs,
 *                              lastIssueAt, lastTotalizerLbs, lastObservedAt } },
 *     updatedAt
 *   }
 */
function setTick(tick) {
  state.tick = { ...tick, updatedAt: now() }
}

async function hydrateTickState(MesBlendTankBatch, MesPipeIssueState, MesSurgeTankBatch, MesSurgeTankIssueState) {
  try {
    const batches = await MesBlendTankBatch.findAll({
      where: { status: 'active' },
      order: [['detectedAt', 'DESC']],
    })
    const pipeStates = await MesPipeIssueState.findAll()
    const batchById = Object.fromEntries(batches.map(b => [b.id, b]))
    const pipeMap = {}
    for (const ps of pipeStates) {
      const b = batchById[ps.blendTankBatchId]
      pipeMap[ps.line] = {
        batchId: ps.blendTankBatchId,
        tankId: b?.tankId || null,
        lastIssuedTotalizerLbs: parseFloat(ps.lastIssuedTotalizerLbs) || 0,
        lastIssueAt: ps.lastIssueAt,
        lastTotalizerLbs: ps.lastTotalizerLbs != null ? parseFloat(ps.lastTotalizerLbs) : null,
        lastObservedAt: ps.lastObservedAt,
      }
    }

    let surgeBatches = []
    let surgeIssueStates = {}
    if (MesSurgeTankBatch) {
      const surgeRows = await MesSurgeTankBatch.findAll({
        where: { status: 'active' },
        order: [['detectedAt', 'DESC']],
      })
      surgeBatches = surgeRows.map(b => ({
        batchId: b.id,
        tankId: b.tankId,
        productName: b.productName,
        mesItem: b.mesItem,
        mesItemName: surgeItemName(b.mesItem),
        feedingUhtId: b.feedingUhtId,
        feedingFromEntName: b.feedingFromEntName,
        parserConfidence: b.parserConfidence,
        nsWorkOrderId: b.nsWorkOrderId,
        nsWorkOrderNumber: b.nsWorkOrderNumber,
        cumulativeIssuedLbs: parseFloat(b.cumulativeIssuedLbs) || 0,
        cumulativeOutputLbs: parseFloat(b.cumulativeOutputLbs) || 0,
        cumulativeCompletedLbs: parseFloat(b.cumulativeCompletedLbs) || 0,
        wasteLbs: b.wasteLbs != null ? parseFloat(b.wasteLbs) : null,
        wastePercent: b.wastePercent != null ? parseFloat(b.wastePercent) : null,
        concurrentFillDrain: !!b.concurrentFillDrain,
        concurrentTickCount: Number(b.concurrentTickCount) || 0,
        drainFillerLines: b.drainFillerLines || null,
        meteredDrainLbs: parseFloat(b.meteredDrainLbs) || 0,
        meteredDrainTickCount: Number(b.meteredDrainTickCount) || 0,
        outputWithDrainLbs: b.outputWithDrainLbs != null ? parseFloat(b.outputWithDrainLbs) : null,
        lastDrainTotalizerGal: b.lastDrainTotalizerGal != null ? parseFloat(b.lastDrainTotalizerGal) : null,
        lastDrainObservedAt: b.lastDrainObservedAt || null,
        consecutiveIssueFailures: Number(b.consecutiveIssueFailures) || 0,
        lastIssueError: b.lastIssueError || null,
        lastIssueErrorAt: b.lastIssueErrorAt || null,
        lastIssueAt: b.lastIssueAt,
        lastCompletionAt: b.lastCompletionAt,
        detectedAt: b.detectedAt,
      }))
      if (MesSurgeTankIssueState) {
        const issueRows = await MesSurgeTankIssueState.findAll()
        const surgeById = Object.fromEntries(surgeRows.map(b => [b.id, b]))
        for (const row of issueRows) {
          const b = surgeById[row.surgeTankBatchId]
          // Key on tankId so the UI can look up by surge tank ID directly.
          const key = b?.tankId || `batch:${row.surgeTankBatchId}`
          surgeIssueStates[key] = {
            batchId: row.surgeTankBatchId,
            tankId: b?.tankId || null,
            uhtId: row.uhtId,
            lastIssuedUhtGal: parseFloat(row.lastIssuedUhtGal) || 0,
            lastIssueAt: row.lastIssueAt,
            lastTotalizerGal: row.lastTotalizerGal != null ? parseFloat(row.lastTotalizerGal) : null,
            lastObservedAt: row.lastObservedAt,
            lastFromEntName: row.lastFromEntName,
          }
        }
      }
    }

    setTick({
      batches: batches.map(b => ({
        batchId: b.id,
        tankId: b.tankId,
        productName: b.productName,
        mesItem: b.mesItem,                   // resolved NS item id (string)
        mesItemName: blendItemName(b.mesItem), // catalog name for the id, if known
        parserConfidence: b.parserConfidence, // exact / high / medium / low / override / none
        nsWorkOrderId: b.nsWorkOrderId,
        nsWorkOrderNumber: b.nsWorkOrderNumber,
        cumulativeIssuedLbs: parseFloat(b.cumulativeIssuedLbs) || 0,
        cumulativeOutputLbs: parseFloat(b.cumulativeOutputLbs) || 0,
        cumulativeCompletedLbs: parseFloat(b.cumulativeCompletedLbs) || 0,
        wasteLbs: b.wasteLbs != null ? parseFloat(b.wasteLbs) : null,
        wastePercent: b.wastePercent != null ? parseFloat(b.wastePercent) : null,
        lastIssueAt: b.lastIssueAt,
        lastCompletionAt: b.lastCompletionAt,
      })),
      pipeStates: pipeMap,
      surgeBatches,
      surgeIssueStates,
    })
    console.log(`[StatusStore] Hydrated tick state: ${batches.length} blend batch(es), ${pipeStates.length} pipe state(s), ${surgeBatches.length} surge batch(es), ${Object.keys(surgeIssueStates).length} surge issue state(s)`)
  } catch (err) {
    console.error('[StatusStore] Failed to hydrate tick state:', err.message)
  }
}

/**
 * Load the most recent completed/closed blend tank batches into the in-memory
 * ring. Run on startup so the dashboard has history without waiting for the
 * next close event.
 */
async function hydrateRecentBlendBatches(MesBlendTankBatch) {
  try {
    // Include active rows so the operator sees in-progress work, not just
    // closed history. Order by detectedAt so the freshest batch is on top
    // regardless of status.
    const rows = await MesBlendTankBatch.findAll({
      order: [['detectedAt', 'DESC']],
      limit: MAX_RECENT_TANK_BATCHES,
    })
    state.recentBlendBatches = rows.map(blendBatchSummary)
    console.log(`[StatusStore] Hydrated recentBlendBatches: ${state.recentBlendBatches.length} row(s)`)
  } catch (err) {
    console.error('[StatusStore] Failed to hydrate recent blend batches:', err.message)
  }
}

async function hydrateRecentSurgeBatches(MesSurgeTankBatch) {
  try {
    const rows = await MesSurgeTankBatch.findAll({
      order: [['detectedAt', 'DESC']],
      limit: MAX_RECENT_TANK_BATCHES,
    })
    state.recentSurgeBatches = rows.map(surgeBatchSummary)
    console.log(`[StatusStore] Hydrated recentSurgeBatches: ${state.recentSurgeBatches.length} row(s)`)
  } catch (err) {
    console.error('[StatusStore] Failed to hydrate recent surge batches:', err.message)
  }
}

// Resolve an NS item ID back to its catalog name for the dashboard. Falls
// through to null when the parser doesn't know the ID — UI shows just the
// numeric ID in that case.
let _blendCatalog = null
let _surgeCatalog = null
function _ensureCatalogs() {
  if (!_blendCatalog) {
    try { _blendCatalog = require('./blendTankProductParser').PRODUCT_CATALOG } catch { _blendCatalog = [] }
  }
  if (!_surgeCatalog) {
    try { _surgeCatalog = require('./surgeTankProductParser').PRODUCT_CATALOG } catch { _surgeCatalog = [] }
  }
}
function blendItemName(mesItem) {
  if (mesItem == null) return null
  _ensureCatalogs()
  const hit = _blendCatalog.find(p => String(p.nsId) === String(mesItem))
  return hit?.name || null
}
function surgeItemName(mesItem) {
  if (mesItem == null) return null
  _ensureCatalogs()
  const hit = _surgeCatalog.find(p => String(p.nsId) === String(mesItem))
  return hit?.name || null
}

function blendBatchSummary(b) {
  return {
    id: b.id,
    tankId: b.tankId,
    productName: b.productName,
    mesItem: b.mesItem,
    mesItemName: blendItemName(b.mesItem),
    nsWorkOrderId: b.nsWorkOrderId,
    nsWorkOrderNumber: b.nsWorkOrderNumber,
    status: b.status,
    parserConfidence: b.parserConfidence,
    fromEntName: b.fromEntName,
    toEntName: b.toEntName,
    cumulativeIssuedLbs: parseFloat(b.cumulativeIssuedLbs) || 0,
    cumulativeOutputLbs: parseFloat(b.cumulativeOutputLbs) || 0,
    cumulativeCompletedLbs: parseFloat(b.cumulativeCompletedLbs) || 0,
    wasteLbs: b.wasteLbs != null ? parseFloat(b.wasteLbs) : null,
    wastePercent: b.wastePercent != null ? parseFloat(b.wastePercent) : null,
    detectedAt: b.detectedAt,
    completedAt: b.completedAt,
    errorMessage: b.errorMessage,
  }
}

function surgeBatchSummary(b) {
  return {
    id: b.id,
    tankId: b.tankId,
    productName: b.productName,
    mesItem: b.mesItem,
    mesItemName: surgeItemName(b.mesItem),
    feedingUhtId: b.feedingUhtId,
    feedingFromEntName: b.feedingFromEntName,
    componentItemId: b.componentItemId,
    componentBinId: b.componentBinId,
    componentResolvedFrom: b.componentResolvedFrom,
    layerSkipReason: b.layerSkipReason,
    pairingStatus: b.pairingStatus,
    nsWorkOrderId: b.nsWorkOrderId,
    nsWorkOrderNumber: b.nsWorkOrderNumber,
    status: b.status,
    parserConfidence: b.parserConfidence,
    cumulativeIssuedLbs: parseFloat(b.cumulativeIssuedLbs) || 0,
    cumulativeOutputLbs: parseFloat(b.cumulativeOutputLbs) || 0,
    cumulativeCompletedLbs: parseFloat(b.cumulativeCompletedLbs) || 0,
    wasteLbs: b.wasteLbs != null ? parseFloat(b.wasteLbs) : null,
    wastePercent: b.wastePercent != null ? parseFloat(b.wastePercent) : null,
    concurrentFillDrain: !!b.concurrentFillDrain,
    concurrentTickCount: Number(b.concurrentTickCount) || 0,
    drainFillerLines: b.drainFillerLines || null,
    meteredDrainLbs: parseFloat(b.meteredDrainLbs) || 0,
    meteredDrainTickCount: Number(b.meteredDrainTickCount) || 0,
    outputWithDrainLbs: b.outputWithDrainLbs != null ? parseFloat(b.outputWithDrainLbs) : null,
    consecutiveIssueFailures: Number(b.consecutiveIssueFailures) || 0,
    lastIssueError: b.lastIssueError || null,
    detectedAt: b.detectedAt,
    completedAt: b.completedAt,
    errorMessage: b.errorMessage,
  }
}

function recordClosedBlendBatch(record) {
  const summary = blendBatchSummary(record)
  const idx = state.recentBlendBatches.findIndex(b => b.id === summary.id)
  if (idx >= 0) {
    state.recentBlendBatches[idx] = summary
  } else {
    state.recentBlendBatches.unshift(summary)
    if (state.recentBlendBatches.length > MAX_RECENT_TANK_BATCHES) {
      state.recentBlendBatches.length = MAX_RECENT_TANK_BATCHES
    }
  }
}

function recordClosedSurgeBatch(record) {
  const summary = surgeBatchSummary(record)
  const idx = state.recentSurgeBatches.findIndex(b => b.id === summary.id)
  if (idx >= 0) {
    state.recentSurgeBatches[idx] = summary
  } else {
    state.recentSurgeBatches.unshift(summary)
    if (state.recentSurgeBatches.length > MAX_RECENT_TANK_BATCHES) {
      state.recentSurgeBatches.length = MAX_RECENT_TANK_BATCHES
    }
  }
}

function pushSeparationBatch(batch) {
  const entry = { t: now(), ...batch }
  // Upsert by batchId so per-tick refreshes for an in-flight batch replace the
  // existing ring entry instead of accumulating duplicates. The close path
  // (which produces a richer summary with nsTransactionId / errorMessage) wins
  // because it overwrites the same slot.
  const idx = entry.batchId
    ? state.recentBatches.findIndex(b => b.batchId === entry.batchId)
    : -1
  if (idx >= 0) {
    state.recentBatches[idx] = entry
  } else {
    state.recentBatches.unshift(entry)
    if (state.recentBatches.length > MAX_RECENT_BATCHES) {
      state.recentBatches.length = MAX_RECENT_BATCHES
    }
  }
}

function pushSeparationBatchFromDbRow(row) {
  pushSeparationBatch(summaryFromDbRow(row))
}

/**
 * Reshape a MesSeparationBatch DB row into the dashboard summary shape. Handles
 * two historical formats of the `destinations` column: the new JSON object
 * (`{ raw, resolved, source }`) with full product+bin resolution, and the
 * legacy plain-array-of-strings format which has no per-destination items.
 * Legacy rows render with just a source row on the dashboard (cream/skim
 * hidden) — good enough to show history without requiring a migration.
 */
function summaryFromDbRow(row) {
  let parsed = null
  if (row.destinations) {
    try { parsed = JSON.parse(row.destinations) } catch { /* legacy/non-JSON */ }
  }
  const hasNewFormat = parsed && !Array.isArray(parsed) && parsed.source
  const resolvedList = hasNewFormat && Array.isArray(parsed.resolved) ? parsed.resolved : []

  const toSide = (s) => s ? {
    silo: s.silo || s.raw || '',
    productIndex: s.productIndex ?? 0,
    productName: s.productName ?? '',
    nsItemId: s.nsItemId ?? s.item?.id ?? null,
    nsItemName: s.nsItemName ?? s.item?.name ?? '',
    binId: s.binId ?? null,
  } : null

  const source = hasNewFormat ? parsed.source : { silo: row.sourceSilo }
  const cream = resolvedList.find(d => d.kind === 'cream') || null
  const skim = resolvedList.find(d => d.kind === 'skim' && (d.silo || d.raw) !== row.sourceSilo) || null

  const ts = row.processedAt || row.createdAt || new Date(clock.now())
  return {
    t: (ts instanceof Date ? ts : new Date(ts)).toISOString(),
    batchId: row.batchId,
    batchStart: row.batchStart,
    batchEnd: row.batchEnd,
    transferName: row.transferName || null,
    source: toSide(source),
    cream: toSide(cream),
    skim: toSide(skim),
    inputVolume: Number(row.inputVolume) || 0,
    creamVolume: Number(row.creamVolume) || 0,
    skimVolume: Number(row.skimVolume) || 0,
    wasteVolume: Number(row.wasteVolume) || 0,
    wastePercent: Number(row.wastePercent) || 0,
    status: row.status,
    nsTransactionId: row.nsTransactionId || null,
    errorMessage: row.errorMessage || undefined,
  }
}

/**
 * Load the most recent batches from the DB into the in-memory ring on startup.
 * Without this the dashboard panel is empty after every redeploy until the
 * next real batch fires. Pass the Sequelize model so statusStore stays
 * decoupled from the models/ directory.
 */
async function hydrateSeparationBatches(MesSeparationBatch) {
  try {
    const rows = await MesSeparationBatch.findAll({
      order: [['createdAt', 'DESC']],
      limit: MAX_RECENT_BATCHES,
    })
    // DB comes back newest-first. Push oldest-first so the final ring is
    // newest-first (pushSeparationBatch unshifts).
    state.recentBatches = []
    for (const row of rows.slice().reverse()) {
      state.recentBatches.unshift(summaryFromDbRow(row))
    }
    console.log(`[StatusStore] Hydrated recentBatches with ${state.recentBatches.length} row(s) from DB`)
  } catch (err) {
    console.error('[StatusStore] Failed to hydrate recentBatches:', err.message)
  }
}

/**
 * Derive a silo occupancy view from the current separator + blend-tank line
 * snapshots. We don't poll silos directly — a silo's "status" is whatever
 * line or transfer is currently using it.
 */
function deriveSilos() {
  const silos = {}
  const touch = (name, role, detail) => {
    if (!name) return
    if (!silos[name]) silos[name] = { silo: name, activity: [] }
    silos[name].activity.push({ role, ...detail })
  }

  const sep = state.separator?.status
  if (sep) {
    if (sep.feedPermit && sep.source) {
      touch(sep.source, 'separator_feed', {
        transferName: sep.transferName,
        itemId: sep.itemId,
        feedTotalLbs: sep.feedTotalLbs,
      })
    }
    for (const d of sep.destinations || []) {
      touch(d, 'separator_destination', {
        transferName: sep.transferName,
        creamFlowGpm: sep.creamFlowGpm,
        skimFlowGpm: sep.skimFlowGpm,
      })
    }
  }

  for (const line of state.blendTanks?.lines || []) {
    if (line.siloName && (line.active || line.totalizerLbs > 0)) {
      touch(line.siloName, 'line_source', {
        line: line.line,
        productName: line.productName,
        destination: line.requestedBy,
        totalizerLbs: line.totalizerLbs,
        active: line.active,
      })
    }
  }

  return Object.values(silos)
}

/**
 * Merge the polled silo levels (from getSiloStatus) with derived activity
 * (from separator + line snapshots). Activity is keyed by siloId so each
 * silo object gets any current transfers appended.
 */
function combineSilos() {
  const activity = deriveSilos()
  const activityBySilo = Object.fromEntries(activity.map(a => [a.silo, a.activity]))
  const polled = state.silos?.silos ?? []

  if (polled.length === 0) {
    // No level data yet — fall back to just the activity view.
    return activity
  }

  return polled.map(s => ({
    ...s,
    activity: activityBySilo[s.siloId] ?? [],
  }))
}

function snapshot() {
  // Errored batches stay in the ring (and in console/DB) for diagnostics but
  // are hidden from the dashboard so the panel isn't dominated by pre-fix NS
  // rejections. Flip this filter when we want errors surfaced again.
  return {
    generatedAt: now(),
    separator: state.separator,
    blendTanks: state.blendTanks,
    bulkMilk: state.bulkMilk,
    silos: combineSilos(),
    uhts: state.uhts,
    surgeTanks: state.surgeTanks,
    fillers: state.fillers,
    // Errors are kept in the ring so operators can see *why* a transfer
    // failed. Pre-fix they were hidden; surfacing them is more useful.
    recentBatches: state.recentBatches,
    recentBlendBatches: state.recentBlendBatches,
    recentSurgeBatches: state.recentSurgeBatches,
    tick: state.tick,
    lastPoll: { ...state.lastPoll },
    eventCount: state.events.length,
  }
}

function events({ since, limit } = {}) {
  let list = state.events
  if (since) {
    const sinceMs = new Date(since).getTime()
    list = list.filter(e => new Date(e.t).getTime() > sinceMs)
  }
  if (limit) list = list.slice(0, limit)
  return list
}

function clear() {
  state.separator = null
  state.blendTanks = null
  state.bulkMilk = null
  state.silos = null
  state.uhts = null
  state.surgeTanks = null
  state.fillers = null
  state.lastPoll = { separator: null, blendTank: null, bulkMilk: null, equipment: null }
  state.events.length = 0
  state.recentBatches.length = 0
  state.recentBlendBatches.length = 0
  state.recentSurgeBatches.length = 0
  state.tick = null
}

module.exports = {
  pushEvent,
  setSeparator,
  setBlendTanks,
  setBulkMilk,
  setSilos,
  setUhts,
  setSurgeTanks,
  setFillers,
  pushSeparationBatch,
  pushSeparationBatchFromDbRow,
  hydrateSeparationBatches,
  setTick,
  hydrateTickState,
  hydrateRecentBlendBatches,
  hydrateRecentSurgeBatches,
  recordClosedBlendBatch,
  recordClosedSurgeBatch,
  snapshot,
  events,
  clear,
}
