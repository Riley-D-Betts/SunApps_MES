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
 *       Everything the pollers currently believe about the plant floor. Served from
 *       the in-memory status store (hydrated from the DB at boot), so it is cheap enough
 *       for the dashboard to poll on a short interval. Sections are null until their
 *       first poll completes (HTTP serves before hydration finishes) and each carries
 *       its own pollAt. Reflects the sim clock while replay mode is on.
 *     responses:
 *       200:
 *         description: Current snapshot.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: >
 *                 Snapshot keyed by subsystem — separator, blendTanks (tanks + lines),
 *                 bulkMilk, silos (levels merged with derived activity), uhts, surgeTanks,
 *                 fillers (Filler 1 inlet meter — inletGpm, inletTotalizerGal, measured,
 *                 running, sampleAt), recentBatches, recentBlendBatches, recentSurgeBatches,
 *                 tick, lastPoll, eventCount.
 */
// Full snapshot: all poller sections + recent-batch rings + tick state (see @openapi above).
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
