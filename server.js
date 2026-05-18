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
const historianRoutes = require('./routes/historianRoutes')
const milkMesRoutes = require('./routes/milkMesRoutes')
const milkRoutes = require('./routes/milkRoutes')
const liveStatusRoutes = require('./routes/liveStatusRoutes')
const fgPairingRoutes = require('./routes/fgPairingRoutes')

const app = express()
const historian = createProvider()
const startTime = Date.now()

sequelize.sync().then(async () => {
  await db.ensureRuntimeSchema()
  await statusStore.hydrateSeparationBatches(db.MesSeparationBatch)
  await statusStore.hydrateTickState(db.MesBlendTankBatch, db.MesPipeIssueState, db.MesSurgeTankBatch, db.MesSurgeTankIssueState)
  await statusStore.hydrateRecentBlendBatches(db.MesBlendTankBatch)
  await statusStore.hydrateRecentSurgeBatches(db.MesSurgeTankBatch)
  // Restore in-memory tank state so the cron jobs recognize batches that were
  // already running before the restart. Without this, the first poll would
  // see an empty in-memory state and either false-fire a new WO (if the
  // product is set) or never close the orphaned DB row (if it later clears).
  await separatorStateMachine.hydrateFromDb()
  await blendTankJob.hydrateFromDb(db.MesBlendTankBatch)
  await surgeTankJob.hydrateFromDb(db.MesSurgeTankBatch)
  console.log('Sequelize models synced.')
})

app.use(bodyParser.json({ limit: '50mb' }))
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }))

app.locals.historian = historian

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    historianProvider: config.HISTORIAN_PROVIDER,
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

cron.schedule(config.SEPARATION_CRON, () => separationJob.run(historian))
cron.schedule(config.BULK_MILK_CRON, () => bulkMilkJob.run(historian))
cron.schedule(config.BLEND_TANK_CRON, () => blendTankJob.run(historian))
cron.schedule(config.SURGE_TANK_CRON, () => surgeTankJob.run(historian))
cron.schedule(config.EQUIPMENT_CRON, () => equipmentJob.run(historian))
cron.schedule(config.TICK_CRON, () => issueCompletionJob.run(historian))

app.listen(config.PORT, () => {
  console.log(`SunApps MES Service running on port ${config.PORT}`)
  console.log(`  Historian provider: ${config.HISTORIAN_PROVIDER}`)
  console.log(`  Separation poll: ${config.SEPARATION_CRON}`)
  console.log(`  Bulk milk poll: ${config.BULK_MILK_CRON}`)
  console.log(`  Blend tank poll: ${config.BLEND_TANK_CRON}`)
  console.log(`  Surge tank poll: ${config.SURGE_TANK_CRON}`)
  console.log(`  Equipment poll: ${config.EQUIPMENT_CRON}`)
  console.log(`  Tick (issue/completion): ${config.TICK_CRON}`)
  console.log(`  Dry run: ${config.MES_DRY_RUN}`)
})
