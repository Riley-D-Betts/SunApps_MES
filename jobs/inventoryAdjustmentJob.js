const tankAtRestSweepService = require('../services/tankAtRestSweepService')
const notifyService = require('../services/notifyService')
const statusStore = require('../services/statusStore')

let lastPollTime = new Date()

async function run(historian) {
  try {
    const result = await tankAtRestSweepService.tick(historian)
    lastPollTime = new Date()
    if (result?.adjustments?.length > 0) {
      statusStore.pushEvent(
        'inventoryAdjustment.sweep',
        `Sweep posted ${result.adjustments.length} adjustment(s)`,
        { count: result.adjustments.length, adjustments: result.adjustments }
      )
    }
    return result
  } catch (err) {
    console.error('[InventoryAdjustmentJob] Sweep error:', err.message)
    statusStore.pushEvent('inventoryAdjustment.error', 'Inventory adjustment sweep failed', { error: err.message })
    await notifyService.sendAlert(
      'SunApps MES: Inventory Adjustment Sweep Failed',
      `Inventory adjustment sweep threw: ${err.message}`
    )
  }
}

function getLastPollTime() {
  return lastPollTime
}

function reset() {
  lastPollTime = new Date()
}

module.exports = { run, getLastPollTime, reset }
