const apiClient = require('../services/apiClient')
const notifyService = require('../services/notifyService')

let lastPollTime = new Date()

/**
 * Poll Historian for separator batches and forward raw data to SunApps_API.
 * No business logic — just poll and forward.
 */
async function run(historian) {
  try {
    const [batches, status] = await Promise.all([
      historian.getSeparatorBatches(lastPollTime),
      historian.getSeparatorStatus(),
    ])

    // Always log separator status
    logStatusSummary(status, batches.length)

    if (batches.length === 0) return

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

function logStatusSummary(status, batchCount) {
  const ts = new Date().toLocaleTimeString()
  const {
    feedPermit, motorRpm, creamFlowGpm, skimFlowGpm, feedTotalLbs,
    source, itemId, transferName, destinations, creamTotalLbs, skimTotalLbs,
  } = status

  const running = !!feedPermit
  const cip = running && (!feedTotalLbs || feedTotalLbs === 0)
  const from = source || '—'
  const destStr = destinations.length > 0 ? destinations.join(', ') : '—'
  const batchNote = batchCount > 0 ? `  ** ${batchCount} batch(es) completed **` : ''

  const fmt = (lbs) => lbs ? `${Math.round(lbs).toLocaleString()} lb` : '0 lb'
  const fmtGpm = (gpm) => `${Math.max(0, gpm).toFixed(1)} GPM`

  console.log(`\n[${ts}] ── Separator Status ──`)
  if (!running) {
    console.log(`  [idle]${batchNote}`)
  } else if (cip) {
    console.log(`  [CIP] ${Math.round(motorRpm).toLocaleString()} RPM${batchNote}`)
  } else {
    console.log(`  [RUNNING] ${from} → ${destStr}  (${transferName || itemId || '—'})  ${Math.round(motorRpm).toLocaleString()} RPM${batchNote}`)
    console.log(`  Feed: ${fmt(feedTotalLbs)}  Cream: ${fmtGpm(creamFlowGpm)} (${fmt(creamTotalLbs)})  Skim: ${fmtGpm(skimFlowGpm)} (${fmt(skimTotalLbs)})`)
  }
}

function getLastPollTime() {
  return lastPollTime
}

module.exports = { run, getLastPollTime }
