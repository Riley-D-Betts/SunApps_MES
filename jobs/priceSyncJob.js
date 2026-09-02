const rawMilkPriceService = require('../services/rawMilkPriceService')
const statusStore = require('../services/statusStore')

let lastPollTime = new Date()

// Daily NS-derived raw milk price sync (SD-717). Read-only against NetSuite
// (SuiteQL via the gateway), writes only our own MesRawMilkPrices table —
// deliberately NOT gated by MES_DRY_RUN. Failure just means stale prices;
// the priceSync.error event is the prod-visible signal (console.log is
// silenced in prod).
async function run() {
  try {
    const result = await rawMilkPriceService.syncTick()
    lastPollTime = new Date()
    console.log(`[PriceSyncJob] Derived ${result.derivedFamilies.length} family price(s), ${result.updated} updated`)
    return result
  } catch (err) {
    console.error('[PriceSyncJob] Sync error:', err.message)
    statusStore.pushEvent('priceSync.error', 'Raw milk price sync failed', { error: err.message })
  }
}

function getLastPollTime() {
  return lastPollTime
}

function reset() {
  lastPollTime = new Date()
}

module.exports = { run, getLastPollTime, reset }
