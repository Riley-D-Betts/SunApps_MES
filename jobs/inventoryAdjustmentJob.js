const tankAtRestSweepService = require('../services/tankAtRestSweepService')
const notifyService = require('../services/notifyService')
const statusStore = require('../services/statusStore')

let lastPollTime = new Date()

async function run(historian) {
  try {
    const result = await tankAtRestSweepService.tick(historian)
    lastPollTime = new Date()
    // Count posted ADJUSTMENT LEGS (each reconciled tank fans out into one leg
    // per item), not the number of tanks touched.
    const ok = result?.legsAdjusted || 0
    const failed = result?.legsFailed || 0
    if (ok > 0 || failed > 0) {
      const summary = failed > 0
        ? `Sweep: ${ok} ok, ${failed} failed`
        : `Sweep posted ${ok} adjustment(s)`
      statusStore.pushEvent(
        failed > 0 ? 'inventoryAdjustment.sweepPartial' : 'inventoryAdjustment.sweep',
        summary,
        { ok, failed, adjustments: result.adjustments, failures: result.failures }
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
