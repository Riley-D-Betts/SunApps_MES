const express = require('express')
const bodyParser = require('body-parser')
const cron = require('node-cron')
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
const statusStore = require('./services/statusStore')
const runtimeConfigService = require('./services/runtimeConfigService')
const historianRoutes = require('./routes/historianRoutes')
const milkMesRoutes = require('./routes/milkMesRoutes')
const milkRoutes = require('./routes/milkRoutes')
const liveStatusRoutes = require('./routes/liveStatusRoutes')
const fgPairingRoutes = require('./routes/fgPairingRoutes')
const devRoutes = require('./routes/devRoutes')
const clock = require('./sim/clock')

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
function applyCrons(crons) {
  for (const [k, task] of Object.entries(cronTasks)) {
    if (task) { try { task.stop() } catch {} }
    cronTasks[k] = null
  }
  cronTasks.separation = cron.schedule(crons.separation, () => separationJob.run(providerHolder.current))
  cronTasks.bulkMilk   = cron.schedule(crons.bulkMilk,   () => bulkMilkJob.run(providerHolder.current))
  cronTasks.blendTank  = cron.schedule(crons.blendTank,  () => blendTankJob.run(providerHolder.current))
  cronTasks.surgeTank  = cron.schedule(crons.surgeTank,  () => surgeTankJob.run(providerHolder.current))
  cronTasks.equipment  = cron.schedule(crons.equipment,  () => equipmentJob.run(providerHolder.current))
  cronTasks.tick       = cron.schedule(crons.tick,       () => issueCompletionJob.run(providerHolder.current))
  console.log('[Server] Cron schedule applied:', JSON.stringify(crons))
}

const PROD_CRONS = {
  separation: config.SEPARATION_CRON,
  bulkMilk:   config.BULK_MILK_CRON,
  blendTank:  config.BLEND_TANK_CRON,
  surgeTank:  config.SURGE_TANK_CRON,
  equipment:  config.EQUIPMENT_CRON,
  tick:       config.TICK_CRON,
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

app.listen(config.PORT, () => {
  console.log(`SunApps MES Service running on port ${config.PORT}`)
  console.log(`  Base historian provider (replay-off): ${baseProviderType}`)
  console.log(`  Dry run: ${config.MES_DRY_RUN}`)
})
