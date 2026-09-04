const db = require('../models')

/**
 * Wraps MesRuntimeConfig (id=1) with a hot cache + change-listener bus.
 *
 * Boot flow: server.js awaits load() once after sequelize.sync() to populate
 * the cache. Routes call get() / update() at runtime.
 *
 * Listeners are invoked AFTER the DB write and the cache update — server.js
 * registers a single listener that re-applies provider type + cron schedule
 * + sim clock state from the new config.
 */

// Defaults applied when the row is missing fields or fresh. Kept gentle on
// the on-prem historian — 5s wall × SPEEDUP=60 = 5 sim-minutes per tick,
// roughly matching production cadence in sim time without hammering the
// AVEVA REST API with hundreds of concurrent NTLM queries.
const DEFAULT_REPLAY_CRONS = {
  separation: '*/5 * * * * *',
  bulkMilk: '*/30 * * * * *',
  blendTank: '*/5 * * * * *',
  surgeTank: '*/5 * * * * *',
  equipment: '*/10 * * * * *',
  facilityState: '*/10 * * * * *',
  facilityLines: '*/30 * * * * *',
  receiving: '*/10 * * * * *',
  facilityTrucks: '0 * * * * *',
  tick: '*/30 * * * * *',
  invAdjust: '*/30 * * * * *',
  // Price sync is meaningless in replay (prices come from live NS, not the
  // historian) but the key must exist or applyCrons passes undefined to
  // cron.schedule. Hourly is harmlessly rare.
  priceSync: '0 * * * *',
}

let cached = null
const listeners = new Set()

function _normalize(row) {
  let crons = null
  if (row.replayCronsJson) {
    try { crons = JSON.parse(row.replayCronsJson) } catch { crons = null }
  }
  return {
    replayMode: !!row.replayMode,
    simStart: row.simStart ? new Date(row.simStart).toISOString() : null,
    speedup: row.speedup || 60,
    replayCrons: { ...DEFAULT_REPLAY_CRONS, ...(crons || {}) },
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  }
}

async function load() {
  const row = await db.MesRuntimeConfig.findByPk(1)
  if (!row) {
    // ensureRuntimeSchema in models/index.js creates this row; if we somehow
    // race past it, fall back to an in-memory default rather than crashing.
    cached = {
      replayMode: false,
      simStart: null,
      speedup: 60,
      replayCrons: { ...DEFAULT_REPLAY_CRONS },
      updatedAt: null,
    }
    return cached
  }
  cached = _normalize(row)
  return cached
}

function get() {
  if (!cached) {
    throw new Error('runtimeConfigService.get() called before load()')
  }
  return cached
}

async function update(patch) {
  const row = await db.MesRuntimeConfig.findByPk(1)
  if (!row) throw new Error('MesRuntimeConfig row 1 missing — schema bootstrap failed')

  const next = {}
  if (patch.replayMode !== undefined) next.replayMode = !!patch.replayMode
  if (patch.simStart !== undefined) next.simStart = patch.simStart ? new Date(patch.simStart) : null
  if (patch.speedup !== undefined) next.speedup = Number(patch.speedup) || 60
  if (patch.replayCrons !== undefined) {
    next.replayCronsJson = JSON.stringify({ ...DEFAULT_REPLAY_CRONS, ...patch.replayCrons })
  }
  next.updatedAt = new Date()

  await row.update(next)
  cached = _normalize(await row.reload())

  for (const fn of listeners) {
    try { await fn(cached) } catch (err) {
      console.error('[runtimeConfigService] listener failed:', err.message)
    }
  }
  return cached
}

function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

module.exports = { load, get, update, onChange, DEFAULT_REPLAY_CRONS }
