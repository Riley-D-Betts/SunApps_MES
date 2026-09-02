const rawMilkPriceService = require('../services/rawMilkPriceService')
const fgRevenueRateService = require('../services/fgRevenueRateService')
const statusStore = require('../services/statusStore')

let lastPollTime = new Date()

// Daily NS-derived pricing sync (SD-717): raw milk $/lb per family + FG
// revenue $/lb per bulk item. Read-only against NetSuite (SuiteQL via the
// gateway), writes only our own price tables — deliberately NOT gated by
// MES_DRY_RUN. Each leg fails independently (one dead query must not starve
// the other); failure just means stale prices, and the priceSync.error /
// fgRevenue.error events are the prod-visible signals (console.log is
// silenced in prod).
async function run() {
  let milk = null
  let fg = null
  try {
    milk = await rawMilkPriceService.syncTick()
    console.log(`[PriceSyncJob] Milk: derived ${milk.derivedFamilies.length} family price(s), ${milk.updated} updated`)
  } catch (err) {
    console.error('[PriceSyncJob] Milk sync error:', err.message)
    statusStore.pushEvent('priceSync.error', 'Raw milk price sync failed', { error: err.message })
  }
  try {
    fg = await fgRevenueRateService.syncTick()
    console.log(`[PriceSyncJob] FG revenue: derived ${fg.derivedItems.length} rate(s), ${fg.updated} updated`)
  } catch (err) {
    console.error('[PriceSyncJob] FG revenue sync error:', err.message)
    statusStore.pushEvent('fgRevenue.error', 'FG revenue rate sync failed', { error: err.message })
  }
  lastPollTime = new Date()
  return { milk, fg }
}

function getLastPollTime() {
  return lastPollTime
}

function reset() {
  lastPollTime = new Date()
}

module.exports = { run, getLastPollTime, reset }
