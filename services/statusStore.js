/**
 * In-memory snapshot of the latest state from each poller plus a rolling
 * event log. The polling jobs write here at the end of every cycle; routes
 * read from it to expose a live view to the frontend.
 *
 * Everything is ephemeral — cleared on process restart. This is a view into
 * "what is MES_Service seeing right now", not a durable history store.
 * (Use the poll-store or DB for durable history.)
 */

const MAX_EVENTS = 500
const MAX_RECENT_BATCHES = 20

const state = {
  separator: null,                 // { status, recentBatchCount, pollDurationMs, pollAt }
  blendTanks: null,                // { tanks: [...], lines: [...], pollDurationMs, pollAt }
  bulkMilk: null,                  // { reading, creamTotal, skimTotal, pollDurationMs, pollAt }
  silos: null,                     // { silos: [...], pollDurationMs, pollAt }
  uhts: null,                      // { uhts: [...], pollDurationMs, pollAt }
  surgeTanks: null,                // { tanks: [...], pollDurationMs, pollAt }
  lastPoll: {
    separator: null,
    blendTank: null,
    bulkMilk: null,
    equipment: null,
  },
  events: [],                      // newest first
  recentBatches: [],               // newest first; each entry is a processed separator batch
}

function now() {
  return new Date().toISOString()
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

/**
 * Record a processed separation batch. Kept as a ring buffer (newest first)
 * so the dashboard can render the last N runs without a DB query. Each entry
 * captures the resolved source/cream/skim products + NS item + bin so an
 * operator can see at a glance whether the unbuild made it to NetSuite.
 */
function pushSeparationBatch(batch) {
  state.recentBatches.unshift({ t: now(), ...batch })
  if (state.recentBatches.length > MAX_RECENT_BATCHES) {
    state.recentBatches.length = MAX_RECENT_BATCHES
  }
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

  const ts = row.processedAt || row.createdAt || new Date()
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
  return {
    generatedAt: now(),
    separator: state.separator,
    blendTanks: state.blendTanks,
    bulkMilk: state.bulkMilk,
    silos: combineSilos(),
    uhts: state.uhts,
    surgeTanks: state.surgeTanks,
    recentBatches: state.recentBatches,
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

module.exports = {
  pushEvent,
  setSeparator,
  setBlendTanks,
  setBulkMilk,
  setSilos,
  setUhts,
  setSurgeTanks,
  pushSeparationBatch,
  hydrateSeparationBatches,
  snapshot,
  events,
}
