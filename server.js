const express = require('express')
const bodyParser = require('body-parser')
const cron = require('node-cron')
const swaggerUi = require('swagger-ui-express')
const config = require('./config')
const { sequelize } = require('./config')
const db = require('./models')
const { createProvider } = require('./historian')
const separationJob = require('./jobs/separationJob')
const separatorStateMachine = require('./services/separatorStateMachine')
const bulkMilkJob = require('./jobs/bulkMilkJob')
const blendTankJob = require('./jobs/blendTankJob')
const surgeTankJob = require('./jobs/surgeTankJob')
const equipmentJob = require('./jobs/equipmentJob')
const issueCompletionJob = require('./jobs/issueCompletionJob')
const inventoryAdjustmentJob = require('./jobs/inventoryAdjustmentJob')
const statusStore = require('./services/statusStore')
const runtimeConfigService = require('./services/runtimeConfigService')
const historianRoutes = require('./routes/historianRoutes')
const milkMesRoutes = require('./routes/milkMesRoutes')
const milkRoutes = require('./routes/milkRoutes')
const liveStatusRoutes = require('./routes/liveStatusRoutes')
const fgPairingRoutes = require('./routes/fgPairingRoutes')
const devRoutes = require('./routes/devRoutes')
const analyticsRoutes = require('./routes/analyticsRoutes')
const bomAdminRoutes = require('./routes/bomAdminRoutes')
const fillerHoursRoutes = require('./routes/fillerHoursRoutes')
const fillerFlowRoutes = require('./routes/fillerFlowRoutes')
const { openapiSpec } = require('./config/swagger')
const clock = require('./sim/clock')

// In prod, silence routine per-tick chatter (every cron job logs progress on each
// fire) so pm2 logs stay readable. console.warn / console.error are left intact so
// real problems still surface. dev / local stay fully verbose. bootLog keeps a
// handle to the original logger so the startup banner below always prints.
const bootLog = console.log.bind(console)
if (config.ENVIRONMENT === 'prod') {
  const noop = () => {}
  console.log = noop
  console.info = noop
  console.debug = noop
}

const app = express()
const startTime = Date.now()

// Mutable holder so cron callbacks always read the CURRENT provider — swapping
// providerHolder.current at runtime takes effect on the next tick without a
// restart. Job code receives the provider as an argument and never caches it.
const baseProviderType = config.HISTORIAN_PROVIDER === 'historical'
  ? 'rest'  // when env says replay, treat rest as the off-state base
  : (config.HISTORIAN_PROVIDER || 'mock')
const providerHolder = { current: createProvider(baseProviderType) }
app.locals.providerHolder = providerHolder

// Cron task registry. applyCrons() stops anything previously scheduled and
// reschedules with the given expressions — invoked at boot and on every
// runtime-config change.
const cronTasks = {}

// Per-job concurrency guards. When the historian is slow (or sim-time
// cadence outpaces a poll's wall-clock duration), the previous tick may
// still be in flight when cron fires the next one. Stacking concurrent
// ticks queues more FQN fetches behind the in-flight ones and creates a
// death spiral. Skip the next fire instead.
const jobRunning = {}
function guarded(name, fn) {
  return async () => {
    if (jobRunning[name]) {
      console.log(`[Cron] Skipping ${name} tick — previous still in flight`)
      return
    }
    jobRunning[name] = true
    try {
      await fn()
    } catch (err) {
      console.error(`[Cron] ${name} tick threw:`, err.message)
    } finally {
      jobRunning[name] = false
    }
  }
}

function applyCrons(crons) {
  for (const [k, task] of Object.entries(cronTasks)) {
    if (task) { try { task.stop() } catch {} }
    cronTasks[k] = null
  }
  cronTasks.separation = cron.schedule(crons.separation, guarded('separation', () => separationJob.run(providerHolder.current)))
  cronTasks.bulkMilk   = cron.schedule(crons.bulkMilk,   guarded('bulkMilk',   () => bulkMilkJob.run(providerHolder.current)))
  cronTasks.blendTank  = cron.schedule(crons.blendTank,  guarded('blendTank',  () => blendTankJob.run(providerHolder.current)))
  cronTasks.surgeTank  = cron.schedule(crons.surgeTank,  guarded('surgeTank',  () => surgeTankJob.run(providerHolder.current)))
  cronTasks.equipment  = cron.schedule(crons.equipment,  guarded('equipment',  () => equipmentJob.run(providerHolder.current)))
  cronTasks.tick       = cron.schedule(crons.tick,       guarded('tick',       () => issueCompletionJob.run(providerHolder.current)))
  cronTasks.invAdjust  = cron.schedule(crons.invAdjust,  guarded('invAdjust',  () => inventoryAdjustmentJob.run(providerHolder.current)))
  console.log('[Server] Cron schedule applied:', JSON.stringify(crons))
}

const PROD_CRONS = {
  separation: config.SEPARATION_CRON,
  bulkMilk:   config.BULK_MILK_CRON,
  blendTank:  config.BLEND_TANK_CRON,
  surgeTank:  config.SURGE_TANK_CRON,
  equipment:  config.EQUIPMENT_CRON,
  tick:       config.TICK_CRON,
  invAdjust:  config.INVENTORY_ADJUSTMENT_CRON,
}

// Reconcile provider + cron + sim clock to the persisted runtime config.
// Called at boot once the DB is ready, and again from devRoutes whenever the
// user toggles or updates settings. The reset() calls keep in-memory job state
// from leaking across mode flips — DB rows are left alone (use /reset for that).
function reconcileMode(rtConfig) {
  if (rtConfig.replayMode) {
    if (rtConfig.simStart) {
      try {
        clock.initSim({ start: rtConfig.simStart, speedup: rtConfig.speedup })
      } catch (err) {
        console.error('[Server] Failed to init sim clock:', err.message)
      }
    } else {
      clock.stopSim()
    }
    if (!(providerHolder.current && providerHolder.current.constructor.name === 'HistoricalProvider')) {
      providerHolder.current = createProvider('historical')
      separatorStateMachine.reset()
      blendTankJob.reset()
      surgeTankJob.reset()
      equipmentJob.reset()
      issueCompletionJob.reset()
      separationJob.reset()
      inventoryAdjustmentJob.reset()
    }
    applyCrons(rtConfig.replayCrons)
    console.log(`[Server] Replay mode ON — provider=historical, simStart=${rtConfig.simStart}, speedup=${rtConfig.speedup}x`)
  } else {
    clock.stopSim()
    if (providerHolder.current && providerHolder.current.constructor.name === 'HistoricalProvider') {
      providerHolder.current = createProvider(baseProviderType)
      separatorStateMachine.reset()
      blendTankJob.reset()
      surgeTankJob.reset()
      equipmentJob.reset()
      issueCompletionJob.reset()
      separationJob.reset()
      inventoryAdjustmentJob.reset()
    }
    applyCrons(PROD_CRONS)
    console.log(`[Server] Replay mode OFF — provider=${baseProviderType}, env CRONs`)
  }
}
app.locals.reconcileMode = reconcileMode

sequelize.sync().then(async () => {
  await db.ensureRuntimeSchema()
  await statusStore.hydrateSeparationBatches(db.MesSeparationBatch)
  await statusStore.hydrateTickState(db.MesBlendTankBatch, db.MesPipeIssueState, db.MesSurgeTankBatch, db.MesSurgeTankIssueState)
  await statusStore.hydrateRecentBlendBatches(db.MesBlendTankBatch)
  await statusStore.hydrateRecentSurgeBatches(db.MesSurgeTankBatch)
  await separatorStateMachine.hydrateFromDb()
  await blendTankJob.hydrateFromDb(db.MesBlendTankBatch)
  await surgeTankJob.hydrateFromDb(db.MesSurgeTankBatch)
  console.log('Sequelize models synced.')

  // Load persisted runtime config and reconcile. devRoutes will register a
  // change listener so subsequent updates also reconcile.
  await runtimeConfigService.load()
  reconcileMode(runtimeConfigService.get())
  runtimeConfigService.onChange(reconcileMode)
})

app.use(bodyParser.json({ limit: '50mb' }))
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }))

// Legacy accessor — routes read req.app.locals.historian to grab the current
// provider. Backed by a getter so a hot-swap on providerHolder.current
// transparently flows through to every existing consumer.
Object.defineProperty(app.locals, 'historian', {
  get() { return providerHolder.current },
})

// Interactive API docs: Swagger UI at /api-docs, raw spec at /api-docs.json.
app.get('/api-docs.json', (req, res) => res.json(openapiSpec))
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(openapiSpec, {
  customSiteTitle: 'SunApps MES — reference',
  explorer: true,
}))

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Liveness and poller freshness
 *     description: >
 *       Reports uptime, which historian provider is currently active
 *       (`RestProvider`, `MockProvider`, or `HistoricalProvider` while replay mode is on),
 *       and the last poll timestamp for the separation, bulk milk and blend tank jobs.
 *       Used by the deploy workflow's smoke check.
 *     responses:
 *       200:
 *         description: Service is up.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status:             { type: string, example: ok }
 *                 uptime:             { type: integer, description: Seconds since process start. }
 *                 historianProvider:  { type: string, nullable: true, description: Class name of the active provider. }
 *                 lastSeparationPoll: { type: string, format: date-time }
 *                 lastBulkMilkPoll:   { type: string, format: date-time }
 *                 lastBlendTankPoll:  { type: string, format: date-time }
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    historianProvider: providerHolder.current?.constructor?.name || null,
    lastSeparationPoll: separationJob.getLastPollTime().toISOString(),
    lastBulkMilkPoll: bulkMilkJob.getLastPollTime().toISOString(),
    lastBlendTankPoll: blendTankJob.getLastPollTime().toISOString(),
  })
})

app.use('/api/historian', historianRoutes)
app.use('/api/mes/milk', milkMesRoutes)
app.use('/api/mes/live-status', liveStatusRoutes)
app.use('/api/mes/fg-pairings', fgPairingRoutes)
app.use('/api/milk', milkRoutes)
app.use('/api/mes/dev/replay', devRoutes)
app.use('/api/mes/analytics', analyticsRoutes)
app.use('/api/mes/bom-admin', bomAdminRoutes)
app.use('/api/mes/filler-hours', fillerHoursRoutes)
app.use('/api/mes/filler-flow', fillerFlowRoutes)

app.listen(config.PORT, () => {
  bootLog(`SunApps MES Service running on port ${config.PORT} [env=${config.ENVIRONMENT}, tablePrefix=${config.TABLE_PREFIX}]`)
  bootLog(`  Base historian provider (replay-off): ${baseProviderType}`)
  bootLog(`  Dry run: ${config.MES_DRY_RUN}`)
})
