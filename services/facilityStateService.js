/**
 * Facility state service — the single owner of "what the facility map shows".
 *
 * Every tick it maps the live-status snapshot onto SVG ids (facilityAdapter),
 * diffs the result against the previous tick by id, bumps a version when
 * anything changed, and broadcasts ONLY the change-set through the Gateway to
 * socket room `facility-map` (event `facility:updated`). Browsers hydrate once
 * from GET /api/mes/facility/state and then apply change-sets; a version gap
 * makes a client resync on its own. This is the scheduler's shape
 * (SunApps_NetSuite/services/schedulerStateService.js), reused.
 *
 * Nothing here touches the historian or NetSuite; it is a pure view over
 * statusStore, the cached scheduler window (facilityLinesSource), the admin
 * assignments and the manual overrides.
 *
 * Manual overrides (settings key `overrides`, keyed by SVG id) win over every
 * derived status until they expire or are cleared: a supervisor can mark a
 * line down or a tank on hold from the map. An override on `line<n>` paints
 * the line and all its drawn members.
 */
const statusStore = require('./statusStore')
const settings = require('./facilitySettingsService')
const core = require('../clients/coreClient')
const { buildEntities } = require('./facilityAdapter')
const { mergeAssignments, LINE_MEMBERS } = require('./facilityJoins')
const linesSource = require('./facilityLinesSource')
const trucksSource = require('./facilityTrucksSource')
const clock = require('../sim/clock')

const state = {
  entities: {},        // id → EntityState (with updatedAt)
  updatedAt: null,     // ISO of last successful refresh that changed something
  version: 0,
  stale: false,        // last refresh threw; serving last-good data
  seeded: false,
}
const prev = new Map() // id → JSON string of the entity minus volatile fields
let lastRefreshAt = null
let lastHeartbeatAt = 0
const HEARTBEAT_MS = 15_000   // when nothing changes, tell clients we are still polling (their "polled Xs ago")
let lastChangeSetSize = 0
let lastBroadcastError = null
let lastError = null

const now = () => new Date(clock.now()).toISOString()
const stableJson = (ent) => { const { updatedAt, ...rest } = ent; return JSON.stringify(rest) }

// ── refresh chaining (never coalesce: a queued refresh must see the latest snapshot) ──
let current = null
let pending = null
function requestRefresh(reason = 'poll') {
  if (current) {
    if (!pending) {
      pending = current.catch(() => {}).then(() => {
        pending = null
        current = execRefresh(reason).finally(() => { current = null })
        return current
      })
    }
    return pending
  }
  current = execRefresh(reason).finally(() => { current = null })
  return current
}

async function execRefresh(reason) {
  try {
    const nowMs = clock.now()
    const snapshot = statusStore.snapshot()
    const assignments = mergeAssignments(settings.get('assignments', {}))
    const fresh = buildEntities(snapshot, assignments, nowMs, linesSource.snapshot(nowMs), trucksSource.snapshot(nowMs))
    applyOverrides(fresh, nowMs)
    const changeSet = diffAndAdvance(fresh, reason)
    state.stale = false
    lastError = null
    lastRefreshAt = now()
    if (changeSet) {
      changeSet.refreshedAt = lastRefreshAt
      broadcast(changeSet)
      lastHeartbeatAt = Date.now()
    } else if (state.seeded && Date.now() - lastHeartbeatAt >= HEARTBEAT_MS) {
      // empty change-set at the current version: clients treat it as a duplicate but refresh their age
      broadcast({ version: state.version, baseVersion: state.version, reason: 'heartbeat', updatedAt: state.updatedAt, refreshedAt: lastRefreshAt, upserted: [], removedIds: [] })
      lastHeartbeatAt = Date.now()
    }
    return changeSet
  } catch (err) {
    state.stale = true
    lastError = err.message
    console.error('[FacilityState] refresh failed:', err.message)
    return null
  }
}

const OVERRIDE_STATUSES = new Set(['running', 'idle', 'cip', 'changeover', 'down', 'hold'])

/** Active overrides (expired ones dropped — and purged from settings when any expired). */
function activeOverrides(nowMs) {
  const all = settings.get('overrides', {}) || {}
  const live = {}
  let expired = false
  for (const [id, o] of Object.entries(all)) {
    if (!o || !OVERRIDE_STATUSES.has(o.status)) continue
    if (o.until && Date.parse(o.until) <= nowMs) { expired = true; continue }
    live[id] = o
  }
  if (expired) settings.set('overrides', live).catch((err) => console.warn('[FacilityState] purge of expired overrides failed:', err.message))
  return live
}

/** Paint manual overrides over the derived entities. A line override covers its members. */
function applyOverrides(fresh, nowMs) {
  for (const [id, o] of Object.entries(activeOverrides(nowMs))) {
    const digit = /^line([1-6])$/.exec(id)?.[1]
    const targets = digit ? [id, ...(LINE_MEMBERS[digit] || [])] : [id]
    for (const t of targets) {
      const prev = fresh[t] || {}
      fresh[t] = {
        ...prev,
        status: o.status,
        primary: o.note ? `${o.note}${prev.primary ? ` · ${prev.primary}` : ''}` : prev.primary || 'Manual override',
        group: o.status === 'running' ? prev.group || null : null,
        override: { of: id, status: o.status, note: o.note || '', by: o.by || '', setAt: o.setAt, until: o.until || null },
        source: 'manual',
      }
    }
  }
}

/** Compare against the previous tick; return a change-set or null when nothing moved. */
function diffAndAdvance(fresh, reason) {
  const stamp = now()
  const upserted = []
  const removedIds = []
  const nextJson = new Map()
  for (const [id, ent] of Object.entries(fresh)) {
    const json = stableJson(ent)
    nextJson.set(id, json)
    if (prev.get(id) !== json) {
      state.entities[id] = { ...ent, updatedAt: stamp }
      upserted.push({ id, ...state.entities[id] })
    }
  }
  for (const id of prev.keys()) {
    if (!nextJson.has(id)) { removedIds.push(id); delete state.entities[id] }
  }
  const wasSeeded = state.seeded
  prev.clear()
  for (const [id, json] of nextJson) prev.set(id, json)
  state.seeded = true

  const changed = upserted.length > 0 || removedIds.length > 0
  if (!wasSeeded) {
    // cold start: seed, bump, broadcast nothing — open clients resync on the next version gap
    state.version++
    state.updatedAt = stamp
    lastChangeSetSize = 0
    return null
  }
  if (!changed) return null
  const baseVersion = state.version
  state.version++
  state.updatedAt = stamp
  lastChangeSetSize = upserted.length + removedIds.length
  return { version: state.version, baseVersion, reason, updatedAt: state.updatedAt, upserted, removedIds }
}

function broadcast(changeSet) {
  core.broadcastFacilityState(changeSet)
    .then(() => { lastBroadcastError = null })
    .catch((err) => {
      lastBroadcastError = err.message
      console.warn('[FacilityState] broadcast failed (non-fatal):', err.message)
    })
}

/** Full state for hydration. Waits for the first refresh on a cold start. */
async function getState() {
  if (!state.seeded) await requestRefresh('hydrate')
  return {
    entities: state.entities, updatedAt: state.updatedAt, refreshedAt: lastRefreshAt, version: state.version, stale: state.stale,
    assignments: mergeAssignments(settings.get('assignments', {})),
    overrides: activeOverrides(clock.now()),
  }
}

function health() {
  return {
    version: state.version, updatedAt: state.updatedAt, stale: state.stale, seeded: state.seeded,
    entityCount: Object.keys(state.entities).length, lastRefreshAt, lastChangeSetSize, lastBroadcastError, lastError,
    overrides: Object.keys(activeOverrides(clock.now())).length,
    lines: linesSource.health(),
    trucks: trucksSource.health(),
  }
}

/** Forget everything (replay resets); the next refresh re-seeds without broadcasting. */
function reset() {
  state.entities = {}
  state.updatedAt = null
  state.seeded = false
  state.stale = false
  prev.clear()
}

// Assignments or overrides changed (admin page, map panel) → re-derive right away.
settings.onChange((key) => { if (key === 'assignments' || key === 'overrides') requestRefresh(key) })

module.exports = { requestRefresh, getState, health, reset, activeOverrides, OVERRIDE_STATUSES }
