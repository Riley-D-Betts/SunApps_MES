const express = require('express')
const router = express.Router()
const fillerHoursService = require('../services/fillerHoursService')

/**
 * Filler hours API — historical time-in-state for filler machines, used by
 * the Portal's Machine Efficiency report (via SunApps_Gateway).
 */

/**
 * @openapi
 * /api/mes/filler-hours:
 *   get:
 *     tags: [Filler Hours]
 *     summary: Filler time-in-state for a window
 *     description: >
 *       Time-in-state breakdown (runtime / cip / idle / unknown) plus set run speed for one
 *       filler over a time window, derived from the machine's historian state tags. Backs
 *       the Portal's Machine Efficiency report via SunApps_Gateway. `until` is clamped to now.
 *
 *
 *       Caveat: only Filler 1 currently has live machine-level historian tags. Fillers 2-6
 *       return an all-unknown breakdown until their tags are historized.
 *     parameters:
 *       - in: query
 *         name: filler
 *         schema: { type: integer, minimum: 1, maximum: 6, default: 1 }
 *         description: Filler number (1-6).
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
 *     responses:
 *       200:
 *         description: Time-in-state breakdown for the filler.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Hours per state (runtime / cip / idle / unknown) plus the set run speed.
 *       400: { description: filler out of range, missing since/until, or an invalid window. }
 *       500: { description: Historian query failed. }
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
