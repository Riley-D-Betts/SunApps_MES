const facilityStateService = require('../services/facilityStateService')

/**
 * Recomputes the facility-map state from the latest live-status snapshot and
 * broadcasts the change-set. Pure in-memory work — the historian is polled by
 * the other jobs; this one only reads statusStore.
 */
async function run() {
  try {
    await facilityStateService.requestRefresh('poll')
  } catch (err) {
    console.error('[FacilityStateJob] Tick error:', err.message)
  }
}

function reset() {
  facilityStateService.reset()
}

module.exports = { run, reset }
