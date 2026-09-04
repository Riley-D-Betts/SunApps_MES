/**
 * Facility settings — small key/value store (JSON values) for things the map
 * needs an admin to decide rather than code: which surge circle is ST81, which
 * blend tank is cocoa, later rack-grid mappings. Same idea as Statado's
 * `_settings` table. Cached in memory after load(); listeners fire on set().
 */
const db = require('../models')

const cache = new Map()
const listeners = new Set()
let loaded = false

async function load() {
  const rows = await db.MesFacilitySetting.findAll()
  cache.clear()
  for (const r of rows) {
    try { cache.set(r.key, JSON.parse(r.valueJson)) } catch { console.warn(`[FacilitySettings] bad JSON for ${r.key}, ignoring`) }
  }
  loaded = true
  console.log(`[FacilitySettings] loaded ${cache.size} setting(s)`)
}

function get(key, dflt = null) {
  return cache.has(key) ? cache.get(key) : dflt
}

async function set(key, value) {
  const valueJson = JSON.stringify(value ?? null)
  const [row, created] = await db.MesFacilitySetting.findOrCreate({ where: { key }, defaults: { key, valueJson, updatedAt: new Date() } })
  if (!created) await row.update({ valueJson, updatedAt: new Date() })
  cache.set(key, value)
  for (const fn of listeners) {
    try { await fn(key, value) } catch (err) { console.warn('[FacilitySettings] listener failed:', err.message) }
  }
  return value
}

function onChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

module.exports = { load, get, set, onChange, isLoaded: () => loaded }
