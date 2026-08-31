const express = require('express')
const router = express.Router()
const fillerFlowService = require('../services/fillerFlowService')

/**
 * Filler flow API — windowed Filler 1 inlet flow analytics (SD-708): run
 * volumes, flow trend points, and totalizer deltas from the TR11_FT1140
 * meter (surge tanks ST81/82 → Filler 1).
 */

const MAX_TREND_BUCKETS = 10100 // admits exactly 7 days at minutely (10,080)
// The service integrates minutely AnalogSummary rows across the whole window
// (for byState/runs) regardless of the trend resolution — one row per minute,
// so the window itself must be bounded or a coarse-resolution request over a
// huge span drags six-figure row counts through the historian.
const MAX_WINDOW_MS = 35 * 24 * 3600 * 1000 // 35 days ≈ 50,400 minutely rows

/**
 * @openapi
 * /api/mes/filler-flow:
 *   get:
 *     tags: [Filler Flow]
 *     summary: Filler 1 inlet flow volumes and trend for a window
 *     description: >
 *       Windowed analytics for the Filler 1 inlet flow meter (TR11_FT1140 on the
 *       ThermaRoute leg from surge tanks ST81/82): totalizer first/last/delta with
 *       reset detection, total volume (odometer delta, falling back to integrated
 *       flow across a reset), volume split by machine state (runtime/cip/idle/unknown
 *       — the meter also counts flush/CIP water, so use `volume.byState.runtime` or
 *       `runs[]` for production volume, never the raw totalizer delta), per-run
 *       volumes, and trend points at a caller-chosen bucket resolution with explicit
 *       measured:false gaps. `until` is clamped to now.
 *
 *
 *       Windows are caller-defined (ISO 8601, UTC, max 35 days) — the API
 *       deliberately has no shift/day bucketing or plant-timezone logic; anchor
 *       `since` to a shift boundary to get shift-aligned trend buckets.
 *       Historization of these tags began 2026-08-18T20:40Z; earlier windows
 *       return nulls, not errors. Requires the live AVEVA historian (returns 501
 *       under the mock provider).
 *     parameters:
 *       - in: query
 *         name: filler
 *         schema: { type: integer, minimum: 1, maximum: 1, default: 1 }
 *         description: Filler number. Only Filler 1 has an inlet flow meter.
 *       - in: query
 *         name: since
 *         required: true
 *         schema: { type: string, format: date-time }
 *         description: Window start (ISO 8601).
 *       - in: query
 *         name: until
 *         required: true
 *         schema: { type: string, format: date-time }
 *         description: Window end (ISO 8601). Must be after `since`; clamped to now.
 *       - in: query
 *         name: resolution
 *         schema: { type: integer, minimum: 60000, default: 3600000 }
 *         description: Trend bucket size in milliseconds (min 60000 = 1 minute; storage is minute-dense).
 *     responses:
 *       200:
 *         description: Flow volumes, runs, and trend for the window.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: >
 *                 totalizer {first,last,deltaGal,resetDetected}, volume {totalGal,
 *                 method, integratedGal, byState}, runs[], trend[] (one point per
 *                 expected bucket), coverage {bucketsExpected, bucketsMeasured, ...}.
 *       400: { description: Bad filler, missing/invalid window, future window, resolution too fine, or too many trend buckets. }
 *       500: { description: Historian query failed. }
 *       501: { description: The active historian provider (mock) cannot serve AnalogSummary queries. }
 */
router.get('/', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    if (!historian?.baseUrl || typeof historian._get !== 'function') {
      return res.status(501).json({
        error: 'filler-flow requires the AVEVA historian REST API (AnalogSummary); the current provider (mock) does not implement it',
      })
    }

    // Default only when the param is ABSENT — an explicit filler=0 or
    // filler=abc must 400 per the schema, not silently become Filler 1.
    const filler = req.query.filler === undefined ? 1 : Number(req.query.filler)
    if (filler !== 1) {
      return res.status(400).json({ error: 'only Filler 1 has an inlet flow meter (TR11_FT1140)' })
    }
    if (!req.query.since || !req.query.until) {
      return res.status(400).json({ error: 'Provide since and until ISO datetime query params' })
    }
    const since = new Date(req.query.since)
    const until = new Date(req.query.until)
    if (isNaN(since) || isNaN(until) || since >= until) {
      return res.status(400).json({ error: 'Invalid since/until window' })
    }
    if (since >= new Date()) {
      return res.status(400).json({ error: 'Window is entirely in the future' })
    }
    if (until.getTime() - since.getTime() > MAX_WINDOW_MS) {
      return res.status(400).json({ error: 'Window exceeds 35 days — narrow it (the report integrates minute-level data across the whole window)' })
    }
    const resolution = req.query.resolution != null ? parseInt(req.query.resolution) : 3600000
    if (isNaN(resolution) || resolution < 60000) {
      return res.status(400).json({ error: 'resolution must be ≥ 60000 ms (1 minute)' })
    }
    const buckets = Math.ceil((Math.min(until.getTime(), Date.now()) - since.getTime()) / resolution)
    if (buckets > MAX_TREND_BUCKETS) {
      return res.status(400).json({
        error: `window/resolution yields ${buckets} trend buckets; max ${MAX_TREND_BUCKETS} — increase resolution or narrow the window`,
      })
    }

    const result = await fillerFlowService.getFillerFlow(historian, { filler, since, until, resolution })
    res.json(result)
  } catch (err) {
    console.error('[FillerFlowRoutes] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
