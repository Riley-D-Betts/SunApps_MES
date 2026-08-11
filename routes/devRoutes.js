const express = require('express')
const { exec } = require('child_process')
const router = express.Router()
const clock = require('../sim/clock')
const db = require('../models')
const statusStore = require('../services/statusStore')
const pollStore = require('../services/pollStore')
const blendTankMesService = require('../services/blendTankMesService')
const surgeTankMesService = require('../services/surgeTankMesService')
const mesItemConfig = require('../services/mesItemConfig')
const nsInventoryLookup = require('../services/nsInventoryLookup')
const separatorStateMachine = require('../services/separatorStateMachine')
const blendTankJob = require('../jobs/blendTankJob')
const surgeTankJob = require('../jobs/surgeTankJob')
const equipmentJob = require('../jobs/equipmentJob')
const issueCompletionJob = require('../jobs/issueCompletionJob')
const inventoryAdjustmentJob = require('../jobs/inventoryAdjustmentJob')
const bulkMilkJob = require('../jobs/bulkMilkJob')
const separationJob = require('../jobs/separationJob')
const runtimeConfigService = require('../services/runtimeConfigService')
const config = require('../config')

// PM2 process name to restart on reset (matches the deploy workflow's
// `pm2 restart sunapps_mes`). Override with PM2_APP_NAME if it ever differs.
const PM2_APP_NAME = process.env.PM2_APP_NAME || 'sunapps_mes'

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
 *                    sim clock back to simStart, then pm2-restart the process
 *                    so ALL in-memory state is rebuilt from the clean DB
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

/**
 * @openapi
 * /api/mes/dev/replay/status:
 *   get:
 *     tags: [Replay]
 *     summary: Replay mode status
 *     description: >
 *       Full replay configuration plus live sim-clock state — what the UI banner reads to
 *       show whether the service is running against the real historian or replaying history.
 *     responses:
 *       200:
 *         description: Current replay config and clock.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 replayMode:  { type: boolean, description: True when replaying historical data through the sim clock. }
 *                 simStart:    { type: string, format: date-time, nullable: true, description: Simulated wall-clock start. }
 *                 speedup:     { type: number, description: Sim clock multiplier — 60 means one simulated hour per real minute. }
 *                 replayCrons: { type: object, description: Cron expressions used while replay is on. }
 *                 clock:       { type: object, description: Live sim clock state (current sim time, paused flag). }
 *                 updatedAt:   { type: string, format: date-time }
 *       500: { description: Failed to read status. }
 */
router.get('/status', (req, res) => {
  try {
    res.json(buildStatus())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * @openapi
 * /api/mes/dev/replay/enable:
 *   post:
 *     tags: [Replay]
 *     summary: Turn on replay mode
 *     description: >
 *       Switches the service to the historical provider and starts the sim clock, so the
 *       cron jobs replay past plant activity instead of polling live. All in-memory job
 *       state is reset on the switch; DB rows are left alone. The body may update
 *       simStart / speedup / replayCrons at the same time.
 *
 *
 *       Note this only changes where data is READ from — jobs still post to whatever
 *       NetSuite account is configured, so replaying against a production account will
 *       create real transactions.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               simStart:    { type: string, format: date-time, description: Point in history to start replaying from. }
 *               speedup:     { type: number, description: Sim clock multiplier. }
 *               replayCrons: { type: object, description: Cron expressions to use while replaying. }
 *     responses:
 *       200: { description: Replay enabled — returns the new status. }
 *       400: { description: Invalid settings. }
 */
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

/**
 * @openapi
 * /api/mes/dev/replay/disable:
 *   post:
 *     tags: [Replay]
 *     summary: Turn off replay mode
 *     description: >
 *       Returns the service to its base provider (the `HISTORIAN_PROVIDER` env value, or
 *       `mock` when unset), restores the env cron schedule, and stops the sim clock.
 *       In-memory job state is reset on the switch; DB rows are left alone.
 *     responses:
 *       200: { description: Replay disabled — returns the new status. }
 *       400: { description: Failed to disable. }
 */
router.post('/disable', async (req, res) => {
  try {
    await runtimeConfigService.update({ replayMode: false })
    res.json(buildStatus())
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

/**
 * @openapi
 * /api/mes/dev/replay/config:
 *   post:
 *     tags: [Replay]
 *     summary: Update replay settings
 *     description: >
 *       Updates simStart / speedup / replayCrons without toggling replay mode. Changes apply
 *       live if replay is currently on. At least one setting must be supplied.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               simStart:    { type: string, format: date-time }
 *               speedup:     { type: number }
 *               replayCrons: { type: object }
 *     responses:
 *       200: { description: Settings updated — returns the new status. }
 *       400: { description: No settings provided, or the values were invalid. }
 */
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

/**
 * @openapi
 * /api/mes/dev/replay/pause:
 *   post:
 *     tags: [Replay]
 *     summary: Pause the sim clock
 *     description: Freezes simulated time. Cron jobs keep firing but see a stationary clock, so replay stops advancing.
 *     responses:
 *       200: { description: Clock paused — returns the current status. }
 */
router.post('/pause', (req, res) => {
  clock.pause()
  res.json(buildStatus())
})

/**
 * @openapi
 * /api/mes/dev/replay/resume:
 *   post:
 *     tags: [Replay]
 *     summary: Resume the sim clock
 *     description: Unfreezes simulated time after a pause.
 *     responses:
 *       200: { description: Clock resumed — returns the current status. }
 */
router.post('/resume', (req, res) => {
  clock.resume()
  res.json(buildStatus())
})

/**
 * @openapi
 * /api/mes/dev/replay/reset:
 *   post:
 *     tags: [Replay]
 *     summary: Reset all replay state (DESTRUCTIVE)
 *     description: >
 *       Wipes the service back to a clean slate for a fresh replay run. In order it rolls
 *       the sim clock back to `simStart`, clears every job's in-memory state and the status
 *       and poll stores, DELETES ALL ROWS from the MES batch tables (blend tank batches and
 *       inflows, pipe and surge issue states, surge tank batches, separation batches, bulk
 *       milk runs, inventory adjustments, the processing log, and FG input pairings),
 *       re-seeds the canonical FG input pairings, and then pm2-restarts the process so all
 *       state rehydrates from the emptied tables.
 *
 *
 *       The response is sent BEFORE the restart, so a 200 means the truncation succeeded
 *       and the restart was scheduled — not that the service is back up. The restart is
 *       best-effort: outside pm2 it just logs a failure.
 *
 *
 *       This deletes production MES history if pointed at a production database. There is
 *       no confirmation parameter and no authentication in front of it.
 *     responses:
 *       200:
 *         description: Tables cleared and a pm2 restart scheduled.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 replayMode: { type: boolean }
 *                 restarting: { type: boolean, example: true }
 *       500: { description: Reset failed before the response was sent. }
 */
router.post('/reset', async (req, res) => {
  try {
    // 1. Roll sim clock back to its persisted start.
    clock.resetSim()

    // 2. Reset per-module in-memory state so a fresh replay run starts clean.
    //    (Belt-and-suspenders for non-pm2/local runs; under pm2 the restart in
    //    step 5 rebuilds all of this from scratch anyway.)
    separatorStateMachine.reset()
    blendTankJob.reset()
    surgeTankJob.reset()
    equipmentJob.reset()
    issueCompletionJob.reset()
    inventoryAdjustmentJob.reset()
    bulkMilkJob.reset()
    blendTankMesService.clearCaches()
    surgeTankMesService.clearCaches()
    mesItemConfig.clearCaches()
    nsInventoryLookup.clearCaches()
    statusStore.clear()
    pollStore.clear()

    // 3. Truncate dev tables children-first to satisfy FK constraints.
    const P = config.TABLE_PREFIX
    const order = [
      'MesBlendTankInflows',
      'MesPipeIssueStates',
      'MesBlendTankBatches',
      'MesSurgeTankIssueStates',
      'MesSurgeTankBatches',
      'MesSeparationBatches',
      'MesBulkMilkRuns',
      'MesInventoryAdjustments',
      'MesProcessingLog',
      'MesFgInputPairings',
    ]
    for (const table of order) {
      try {
        await db.sequelize.query(`DELETE FROM ${P}${table}`)
      } catch (err) {
        console.warn(`[DevRoutes] reset: failed to clear ${P}${table}: ${err.message}`)
      }
    }

    // 4. Re-seed canonical FG input pairings (truncated above).
    if (db.seedFgInputPairings) await db.seedFgInputPairings()

    console.log('[DevRoutes] Replay reset complete — restarting process via pm2')

    // 5. Respond BEFORE the restart (pm2 restart tears down this process, so
    //    the response must flush first), then pm2-restart so every job's
    //    in-memory state is rebuilt fresh by hydrateFromDb against the now-empty
    //    tables and the sim clock re-anchors to simStart on boot. Best-effort:
    //    if pm2 isn't managing this process (local dev), the step-2 resets
    //    already left things clean and we just log the failure.
    res.json({ ...buildStatus(), restarting: true })

    setTimeout(() => {
      exec(`pm2 restart ${PM2_APP_NAME}`, (err, stdout, stderr) => {
        if (err) {
          console.error(`[DevRoutes] pm2 restart ${PM2_APP_NAME} failed (not under pm2?): ${err.message}`)
        } else {
          console.log(`[DevRoutes] pm2 restart ${PM2_APP_NAME} issued: ${stdout.trim()}`)
        }
      })
    }, 500)
  } catch (err) {
    console.error('[DevRoutes] reset failed:', err)
    if (!res.headersSent) res.status(500).json({ error: err.message })
  }
})

module.exports = router
