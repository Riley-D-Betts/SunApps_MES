const milkMesService = require('../services/milkMesService')
const notifyService = require('../services/notifyService')

let lastPollTime = new Date()

async function run(historian) {
  try {
    const readings = await historian.getBulkMilkFlowData(lastPollTime)

    if (readings.length === 0) {
      console.log(`[BulkMilkJob] Poll OK — no new readings since ${lastPollTime.toISOString()}`)
      return
    }

    console.log(`[BulkMilkJob] Found ${readings.length} reading(s) since ${lastPollTime.toISOString()}`)

    for (const reading of readings) {
      try {
        await milkMesService.processBulkMilkFlow(reading)
        console.log('[BulkMilkJob] Processed flow reading')
      } catch (err) {
        console.error('[BulkMilkJob] Failed to process flow reading:', err.message)
        await notifyService.sendAlert(
          'SunApps MES: Bulk Milk Flow Failed',
          `Flow reading could not be processed: ${err.message}`
        )
      }
    }

    lastPollTime = new Date()
  } catch (err) {
    console.error('[BulkMilkJob] Poll error:', err.message)
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
