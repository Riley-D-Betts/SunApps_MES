'use strict'

/**
 * Blend fill-while-draining check (SD-722).
 *
 * Blend loss = milk issued − load-cell rise. If a UHT is pulling from the tank
 * while it fills, the rise under-counts arrival and the loss is only an upper
 * bound. The physical truth is the tank's outlet valve to a UHT thermostat
 * (the same valves restProvider.getUhtStatus uses when UHT{n}.FromEntName is
 * blank). A surge-batch overlap shortcut was tried first and was wrong 26 of
 * 27 times on prod (8/15–9/14) — surge batches pin their source at start and
 * outlive it — so this reads the valve history instead.
 *
 * Runs ONCE per batch: at close (fire-and-forget from processWOEnd, never
 * affects NetSuite) and via scripts/backfillBlendDrainFlags.js. Two historian
 * reads. The result is stored on the batch row:
 *   drainedWhileFilling  true | false | null (null = never checked / no historian)
 *   drainOverlapMinutes  minutes an outlet valve was open during the fill window
 */

const db = require('../models')

// Blend tank → its outlet valves to TSTAT-1/UHT1 and TSTAT-2/UHT2.
const OUTLET_VALVES = {
  BlendTank1A: [['UHT1', 'BlendSystem.VG_8014MP_Y1_STA'], ['UHT2', 'BlendSystem.VG_8013MP_Y1_STA']],
  BlendTank1B: [['UHT1', 'BlendSystem.VG_8024MP_Y1_STA'], ['UHT2', 'BlendSystem.VG_8023MP_Y1_STA']],
  BlendTank2A: [['UHT1', 'BlendSystem.VG_8034MP_Y1_STA'], ['UHT2', 'BlendSystem.VG_8033MP_Y1_STA']],
  BlendTank2B: [['UHT1', 'BlendSystem.VG_8044MP_Y1_STA'], ['UHT2', 'BlendSystem.VG_8043MP_Y1_STA']],
}
// A valve open for less than this during the fill is a blip, not a drain.
const MIN_OPEN_MINUTES = 5
// Look this far before the fill for the valve's starting state.
const LOOKBACK_MS = 12 * 3600 * 1000

/** Fill window = first → last inflow tick; fallback start/detected → completed. */
async function fillWindow(batch) {
  const [row] = await db.sequelize.query(
    `SELECT MIN([createdAt]) AS fs, MAX([createdAt]) AS fe FROM [${db.MesBlendTankInflow.getTableName()}] WHERE [blendTankBatchId] = :id`,
    { type: db.Sequelize.QueryTypes.SELECT, replacements: { id: batch.id } })
  const start = row && row.fs ? new Date(row.fs) : new Date(batch.actualStartAt || batch.detectedAt || batch.createdAt)
  let end = row && row.fe ? new Date(row.fe) : new Date(batch.completedAt || batch.createdAt)
  if (end.getTime() - start.getTime() < 60000) end = new Date(start.getTime() + 60000)
  return { start, end }
}

/** Minutes a discrete tag was truthy within [start, end], from ProcessValues history. */
async function openMinutes(historian, fqn, start, end) {
  const pv = await historian._queryProcessValues(fqn, new Date(start.getTime() - LOOKBACK_MS), end, { verbose: false })
  const pts = (pv || []).map(p => ({ t: new Date(p.DateTime).getTime(), v: Number(p.Value) ? 1 : 0 })).sort((a, b) => a.t - b.t)
  let state = 0
  for (const p of pts) if (p.t <= start.getTime()) state = p.v
  let cursor = start.getTime(), openMs = 0
  for (const p of pts) {
    if (p.t <= start.getTime() || p.t >= end.getTime()) continue
    if (state) openMs += p.t - cursor
    cursor = p.t; state = p.v
  }
  if (state) openMs += end.getTime() - cursor
  return openMs / 60000
}

/**
 * Check one batch and (unless dryRun) store the result. Returns
 * { checked, drained, minutes, byUht, window } or { checked:false, reason }.
 */
async function checkBatch(batch, historian, { dryRun = false } = {}) {
  const valves = OUTLET_VALVES[batch.tankId]
  if (!valves) return { checked: false, reason: `no outlet valve map for ${batch.tankId}` }
  if (!historian || typeof historian._queryProcessValues !== 'function') return { checked: false, reason: 'historian cannot read history' }
  const window = await fillWindow(batch)
  const byUht = {}
  for (const [uht, fqn] of valves) byUht[uht] = Math.round((await openMinutes(historian, fqn, window.start, window.end)) * 10) / 10
  const minutes = Math.max(...Object.values(byUht))
  const drained = minutes >= MIN_OPEN_MINUTES
  if (!dryRun) await db.MesBlendTankBatch.update({ drainedWhileFilling: drained, drainOverlapMinutes: minutes }, { where: { id: batch.id } })
  return { checked: true, drained, minutes, byUht, window: { start: window.start.toISOString(), end: window.end.toISOString() } }
}

module.exports = { checkBatch, OUTLET_VALVES, MIN_OPEN_MINUTES }
