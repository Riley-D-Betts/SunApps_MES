const config = require('../config')
const lossReportService = require('../services/lossReportService')
const statusStore = require('../services/statusStore')
const plantTime = require('../utils/plantTime')

let lastPollTime = new Date()

// Daily MesLossDaily rollup (SD-729): re-computes the last LOSS_ROLLUP_DAYS
// plant days (default 3 — batches close late and get retried/rejected for a
// day or two) at 05:40 plant time, after priceSync (05:10) so the frozen $
// use that morning's prices. Idempotent per day. Reads the batch tables,
// writes only MesLossDaily — not gated by MES_DRY_RUN (it is our own table).
// Runs once at boot too, so a freshly deployed instance has yesterday's row.
async function run({ days = config.LOSS_ROLLUP_DAYS } = {}) {
  const today = plantTime.plantDateString()
  const toDay = plantTime.addPlantDays(today, -1)
  const fromDay = plantTime.addPlantDays(today, -Math.max(1, days))
  try {
    const result = await lossReportService.rollupDaily({ fromDay, toDay })
    console.log(`[LossRollupJob] ${fromDay}..${toDay}: ${result.rows} row(s) over ${result.daysWithData} day(s)`)
    statusStore.pushEvent('lossRollup.ok', `Loss history rolled up ${fromDay}..${toDay}`, result)
    lastPollTime = new Date()
    return result
  } catch (err) {
    console.error('[LossRollupJob] rollup error:', err.message)
    statusStore.pushEvent('lossRollup.error', 'Loss history rollup failed', { error: err.message, fromDay, toDay })
    throw err
  }
}

function getLastPollTime() {
  return lastPollTime
}

function reset() {
  lastPollTime = new Date()
}

module.exports = { run, getLastPollTime, reset }
