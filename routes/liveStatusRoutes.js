const express = require('express')
const router = express.Router()
const statusStore = require('../services/statusStore')

/**
 * Live view of what the MES polling service is currently seeing.
 * Frontend polls these to render the live dashboard.
 */

/**
 * @openapi
 * /api/mes/live-status:
 *   get:
 *     tags: [Live Status]
 *     summary: Live plant snapshot
 *     description: >
 *       Everything the pollers currently believe about the plant floor — separator state,
 *       blend tanks, milk lines, bulk milk intake, and derived silo activity. Served from
 *       the in-memory status store (hydrated from the DB at boot), so it is cheap enough
 *       for the dashboard to poll on a short interval. Reflects the sim clock while replay
 *       mode is on.
 *     responses:
 *       200:
 *         description: Current snapshot.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: Snapshot keyed by subsystem (separator, blendTanks, milkLines, bulkMilk, silos).
 */
// Full snapshot: separator + blend tanks + milk lines + bulk milk + derived silo activity.
router.get('/', (req, res) => {
  res.json(statusStore.snapshot())
})

/**
 * @openapi
 * /api/mes/live-status/events:
 *   get:
 *     tags: [Live Status]
 *     summary: Rolling event log
 *     description: >
 *       The in-memory rolling log of notable poller events (batch starts and ends, state
 *       transitions, NetSuite posts, errors). Non-durable — it is empty after a restart
 *       and is cleared by the replay reset.
 *     parameters:
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Only return events after this timestamp (ISO 8601).
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *         description: Maximum events to return.
 *     responses:
 *       200:
 *         description: Events.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 events: { type: array, items: { type: object } }
 */
// Rolling event log. Supports ?since=ISO and ?limit=N.
router.get('/events', (req, res) => {
  const since = req.query.since
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined
  res.json({ events: statusStore.events({ since, limit }) })
})

module.exports = router
