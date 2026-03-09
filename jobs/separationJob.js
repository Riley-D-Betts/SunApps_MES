const apiClient = require('../services/apiClient')
const notifyService = require('../services/notifyService')

let lastPollTime = new Date()

/**
 * Poll Historian for separator batches and forward raw data to SunApps_API.
 * No business logic — just poll and forward.
 */
async function run(historian) {
  try {
    const batches = await historian.getSeparatorBatches(lastPollTime)

    if (batches.length === 0) return

    console.log(`[SeparationJob] Found ${batches.length} batch(es) since ${lastPollTime.toISOString()}`)

    for (const batch of batches) {
      try {
        const result = await apiClient.post('/api/mes/milk/separation/batch', batch)
        console.log(`[SeparationJob] Forwarded batch ${batch.batchId}: ${result.success ? 'OK' : 'FAIL'}`)
      } catch (err) {
        console.error(`[SeparationJob] Failed to forward batch ${batch.batchId}:`, err.message)
        await notifyService.sendAlert(
          'MES_Service: Separation Batch Forward Failed',
          `Batch ${batch.batchId} could not be sent to SunApps_API: ${err.message}`
        )
      }
    }

    lastPollTime = new Date()
  } catch (err) {
    console.error('[SeparationJob] Poll error:', err.message)
    await notifyService.sendAlert(
      'MES_Service: Historian Poll Failed',
      `Separation job could not poll Historian: ${err.message}`
    )
  }
}

function getLastPollTime() {
  return lastPollTime
}

module.exports = { run, getLastPollTime }
