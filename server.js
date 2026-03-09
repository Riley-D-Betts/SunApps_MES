const express = require('express')
const cron = require('node-cron')
const config = require('./config')
const { createProvider } = require('./historian')
const separationJob = require('./jobs/separationJob')
const bulkMilkJob = require('./jobs/bulkMilkJob')
const historianRoutes = require('./routes/historianRoutes')

const app = express()
const historian = createProvider()
const startTime = Date.now()

// Make historian available to route handlers
app.locals.historian = historian

// Health endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    historianProvider: config.HISTORIAN_PROVIDER,
    lastSeparationPoll: separationJob.getLastPollTime().toISOString(),
    lastBulkMilkPoll: bulkMilkJob.getLastPollTime().toISOString(),
  })
})

// Query API — gateway for SunApps_API to pull Historian data on demand
app.use('/api/historian', historianRoutes)

// Schedule jobs
cron.schedule(config.SEPARATION_CRON, () => separationJob.run(historian))
cron.schedule(config.BULK_MILK_CRON, () => bulkMilkJob.run(historian))

// Start server
app.listen(config.PORT, () => {
  console.log(`MES_Service running on port ${config.PORT}`)
  console.log(`  Historian provider: ${config.HISTORIAN_PROVIDER}`)
  console.log(`  Separation poll: ${config.SEPARATION_CRON}`)
  console.log(`  Bulk milk poll: ${config.BULK_MILK_CRON}`)
  console.log(`  Forwarding to: ${config.SUNAPPS_API_URL}`)
})
