const milkMesService = require('../services/milkMesService')
const notifyService = require('../services/notifyService')
const statusStore = require('../services/statusStore')

let lastPollTime = new Date()

async function run(historian) {
  const pollStart = Date.now()
  try {
    const readings = await historian.getBulkMilkFlowData(lastPollTime)

    const latest = readings[readings.length - 1] || null
    statusStore.setBulkMilk({
      readingCount: readings.length,
      latestReading: latest,
      creamTotal: latest?.creamTotal ?? null,
      skimTotal: latest?.skimTotal ?? null,
      pollDurationMs: Date.now() - pollStart,
    })

    if (readings.length === 0) {
      console.log(`[BulkMilkJob] Poll OK — no new readings since ${lastPollTime.toISOString()}`)
      return
    }

    console.log(`[BulkMilkJob] Found ${readings.length} reading(s) since ${lastPollTime.toISOString()}`)

    for (const reading of readings) {
      try {
        await milkMesService.processBulkMilkFlow(reading)
        console.log('[BulkMilkJob] Processed flow reading')
        statusStore.pushEvent('bulkMilk.flow', `Flow reading processed: cream=${reading.creamVolume.toFixed(1)} gal, skim=${reading.skimVolume.toFixed(1)} gal`, reading)
      } catch (err) {
        console.error('[BulkMilkJob] Failed to process flow reading:', err.message)
        statusStore.pushEvent('bulkMilk.flow.error', 'Flow reading failed', { error: err.message })
        await notifyService.sendAlert(
          'SunApps MES: Bulk Milk Flow Failed',
          `Flow reading could not be processed: ${err.message}`
        )
      }
    }

    lastPollTime = new Date()
  } catch (err) {
    console.error('[BulkMilkJob] Poll error:', err.message)
    statusStore.pushEvent('bulkMilk.poll.error', 'Historian poll failed', { error: err.message })
    await notifyService.sendAlert(
      'SunApps MES: Historian Poll Failed',
      `Bulk milk job could not poll Historian: ${err.message}`
    )
  }
}

function getLastPollTime() {
  return lastPollTime
}

module.exports = { run, getLastPollTime }
