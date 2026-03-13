const apiClient = require('../services/apiClient')
const notifyService = require('../services/notifyService')

let lastPollTime = new Date()

/**
 * Poll Historian for bulk milk flow data and forward raw readings to SunApps_API.
 * No business logic — just poll and forward.
 */
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
        const result = await apiClient.post('/api/mes/milk/bulk-milk/flow', reading)
        console.log(`[BulkMilkJob] Forwarded flow reading: ${result.success ? 'OK' : 'FAIL'}`)
      } catch (err) {
        console.error('[BulkMilkJob] Failed to forward flow reading:', err.message)
        await notifyService.sendAlert(
          'MES_Service: Bulk Milk Flow Forward Failed',
          `Flow reading could not be sent to SunApps_API: ${err.message}`
        )
      }
    }

    lastPollTime = new Date()
  } catch (err) {
    console.error('[BulkMilkJob] Poll error:', err.message)
    await notifyService.sendAlert(
      'MES_Service: Historian Poll Failed',
      `Bulk milk job could not poll Historian: ${err.message}`
    )
  }
}

function getLastPollTime() {
  return lastPollTime
}

module.exports = { run, getLastPollTime }
