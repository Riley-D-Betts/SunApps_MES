const express = require('express')
const router = express.Router()
const fillerHoursService = require('../services/fillerHoursService')

/**
 * Filler hours API — historical time-in-state for filler machines, used by
 * the Portal's Machine Efficiency report (via SunApps_Gateway).
 */

/**
 * GET /api/mes/filler-hours?filler=1&since=ISO&until=ISO
 * Time-in-state breakdown (runtime / cip / idle / unknown) plus set run speed
 * for one filler over a time window. `until` is clamped to now.
 *
 * Note: only Filler 1 currently has live machine-level Historian tags;
 * Fillers 2-6 will return all-unknown until their tags are historized.
 */
router.get('/', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const filler = parseInt(req.query.filler) || 1
    if (filler < 1 || filler > 6) return res.status(400).json({ error: 'filler must be 1-6' })
    if (!req.query.since || !req.query.until) {
      return res.status(400).json({ error: 'Provide since and until ISO datetime query params' })
    }
    const since = new Date(req.query.since)
    const until = new Date(req.query.until)
    if (isNaN(since) || isNaN(until) || since >= until) {
      return res.status(400).json({ error: 'Invalid since/until window' })
    }

    const result = await fillerHoursService.getFillerHours(historian, { filler, since, until })
    res.json(result)
  } catch (err) {
    console.error('[FillerHoursRoutes] error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
