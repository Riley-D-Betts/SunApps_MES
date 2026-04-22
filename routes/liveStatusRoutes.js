const express = require('express')
const router = express.Router()
const statusStore = require('../services/statusStore')

/**
 * Live view of what the MES polling service is currently seeing.
 * Frontend polls these to render the live dashboard.
 */

// Full snapshot: separator + blend tanks + milk lines + bulk milk + derived silo activity.
router.get('/', (req, res) => {
  res.json(statusStore.snapshot())
})

// Rolling event log. Supports ?since=ISO and ?limit=N.
router.get('/events', (req, res) => {
  const since = req.query.since
  const limit = req.query.limit ? parseInt(req.query.limit, 10) : undefined
  res.json({ events: statusStore.events({ since, limit }) })
})

module.exports = router
