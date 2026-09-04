const trucksSource = require('../services/facilityTrucksSource')

/** Polls the NetSuite milk-truck queue for the facility map (services/facilityTrucksSource.js). */
async function run() {
  try {
    await trucksSource.poll()
  } catch (err) {
    console.error('[FacilityTrucksJob] Tick error:', err.message)
  }
}

function reset() { trucksSource.reset() }

module.exports = { run, reset }
