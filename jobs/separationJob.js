const milkMesService = require('../services/milkMesService')
const notifyService = require('../services/notifyService')

let lastPollTime = new Date()

async function run(historian) {
  try {
    const [batches, status] = await Promise.all([
      historian.getSeparatorBatches(lastPollTime),
      historian.getSeparatorStatus(),
    ])

    logStatusSummary(status, batches.length)

    if (batches.length === 0) return

    for (const batch of batches) {
      try {
        const result = await milkMesService.processSeparationBatch(batch)
        if (!result.duplicate) {
          console.log(`[SeparationJob] Processed batch ${batch.batchId}: status=${result.status}`)
        }
      } catch (err) {
        console.error(`[SeparationJob] Failed to process batch ${batch.batchId}:`, err.message)
        await notifyService.sendAlert(
          'SunApps MES: Separation Batch Failed',
          `Batch ${batch.batchId} could not be processed: ${err.message}`
        )
      }
    }

    lastPollTime = new Date()
  } catch (err) {
    console.error('[SeparationJob] Poll error:', err.message)
    await notifyService.sendAlert(
      'SunApps MES: Historian Poll Failed',
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
