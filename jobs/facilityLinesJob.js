const linesSource = require('../services/facilityLinesSource')
const facilityStateService = require('../services/facilityStateService')

/**
 * Polls the Production Scheduler window and the staging consumption queues for
 * the facility map's line status (see services/facilityLinesSource.js). When
 * the scheduler's version moved, re-derives the map right away instead of
 * waiting for the next facility-state tick.
 */
async function run() {
  try {
    const changed = await linesSource.poll()
    if (changed) await facilityStateService.requestRefresh('scheduler')
  } catch (err) {
    console.error('[FacilityLinesJob] Tick error:', err.message)
  }
}

function reset() {
  linesSource.reset()
}

module.exports = { run, reset }
