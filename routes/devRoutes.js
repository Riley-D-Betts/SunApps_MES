const express = require('express')
const router = express.Router()
const clock = require('../sim/clock')
const db = require('../models')
const statusStore = require('../services/statusStore')
const pollStore = require('../services/pollStore')
const blendTankMesService = require('../services/blendTankMesService')
const surgeTankMesService = require('../services/surgeTankMesService')
const mesItemConfig = require('../services/mesItemConfig')
const separatorStateMachine = require('../services/separatorStateMachine')
const blendTankJob = require('../jobs/blendTankJob')
const surgeTankJob = require('../jobs/surgeTankJob')
const equipmentJob = require('../jobs/equipmentJob')
const issueCompletionJob = require('../jobs/issueCompletionJob')
const separationJob = require('../jobs/separationJob')
const runtimeConfigService = require('../services/runtimeConfigService')

/**
 * Replay control surface — backed by the persisted MesRuntimeConfig row.
 * Updates write to the DB, refresh the in-memory cache, and notify server.js
 * which reconciles the running provider / cron schedule / sim clock.
 *
 *   GET  /status   — full config + live clock state for the UI banner
 *   POST /enable   — turn on replay mode (body may include simStart, speedup,
 *                    replayCrons to update them at the same time)
 *   POST /disable  — turn off replay mode (provider falls back to base type,
 *                    cron returns to env defaults, sim clock stops)
 *   POST /config   — update simStart / speedup / replayCrons without
 *                    toggling mode — applies live if replay is currently on
 *   POST /pause    — freeze sim clock
 *   POST /resume   — unfreeze
 *   POST /reset    — truncate dev tables + reset in-memory state + roll the
 *                    sim clock back to simStart
 */

function buildStatus() {
  const cfg = runtimeConfigService.get()
  const clockStatus = clock.getStatus()
  return {
    replayMode: cfg.replayMode,
    simStart: cfg.simStart,
    speedup: cfg.speedup,
    replayCrons: cfg.replayCrons,
    clock: clockStatus,
    updatedAt: cfg.updatedAt,
  }
}

router.get('/status', (req, res) => {
  try {
    res.json(buildStatus())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.post('/enable', async (req, res) => {
  try {
    const patch = { replayMode: true }
    if (req.body?.simStart) patch.simStart = req.body.simStart
    if (req.body?.speedup) patch.speedup = req.body.speedup
    if (req.body?.replayCrons) patch.replayCrons = req.body.replayCrons
    await runtimeConfigService.update(patch)
    res.json(buildStatus())
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.post('/disable', async (req, res) => {
  try {
    await runtimeConfigService.update({ replayMode: false })
    res.json(buildStatus())
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.post('/config', async (req, res) => {
  try {
    const patch = {}
    if (req.body?.simStart !== undefined) patch.simStart = req.body.simStart
    if (req.body?.speedup !== undefined) patch.speedup = req.body.speedup
    if (req.body?.replayCrons !== undefined) patch.replayCrons = req.body.replayCrons
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: 'No settings provided' })
    await runtimeConfigService.update(patch)
    res.json(buildStatus())
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

router.post('/pause', (req, res) => {
  clock.pause()
  res.json(buildStatus())
})

router.post('/resume', (req, res) => {
  clock.resume()
  res.json(buildStatus())
})

router.post('/reset', async (req, res) => {
  try {
    // 1. Roll sim clock back to its persisted start.
    clock.resetSim()

    // 2. Reset per-module in-memory state so a fresh replay run starts clean.
    separatorStateMachine.reset()
    blendTankJob.reset()
    surgeTankJob.reset()
    equipmentJob.reset()
    issueCompletionJob.reset()
    separationJob.reset()
    blendTankMesService.clearCaches()
    surgeTankMesService.clearCaches()
    mesItemConfig.clearCaches()
    statusStore.clear()
    pollStore.clear()

    // 3. Truncate dev tables children-first to satisfy FK constraints.
    const order = [
      'MesBlendTankInflows',
      'MesPipeIssueStates',
      'MesBlendTankBatches',
      'MesSurgeTankIssueStates',
      'MesSurgeTankBatches',
      'MesSeparationBatches',
      'MesBulkMilkRuns',
      'MesProcessingLog',
      'MesFgInputPairings',
    ]
    for (const table of order) {
      try {
        await db.sequelize.query(`DELETE FROM ${table}`)
      } catch (err) {
        console.warn(`[DevRoutes] reset: failed to clear ${table}: ${err.message}`)
      }
    }

    // 4. Re-seed canonical FG input pairings (truncated above).
    if (db.seedFgInputPairings) await db.seedFgInputPairings()

    console.log('[DevRoutes] Replay reset complete')
    res.json(buildStatus())
  } catch (err) {
    console.error('[DevRoutes] reset failed:', err)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
