const statusStore = require('../services/statusStore')
const notifyService = require('../services/notifyService')

/**
 * Polls the Historian for silo levels, UHT status, and surge tank status.
 * Pure read-only status feed — nothing gets written back to NetSuite from
 * here. Data is stored in statusStore for the live dashboard.
 */
async function run(historian) {
  const pollStart = Date.now()
  try {
    const [silos, uhts, surgeTanks] = await Promise.all([
      historian.getSiloStatus(),
      historian.getUhtStatus(),
      historian.getSurgeTankStatus(),
    ])

    const durationMs = Date.now() - pollStart

    statusStore.setSilos({ silos, pollDurationMs: durationMs })
    statusStore.setUhts({ uhts, pollDurationMs: durationMs })
    statusStore.setSurgeTanks({ tanks: surgeTanks, pollDurationMs: durationMs })

    console.log(`[EquipmentJob] Polled ${silos.length} silos, ${uhts.length} UHTs, ${surgeTanks.length} surge tanks in ${durationMs}ms`)
  } catch (err) {
    console.error('[EquipmentJob] Poll error:', err.message)
    statusStore.pushEvent('equipment.poll.error', 'Equipment poll failed', { error: err.message })
    await notifyService.sendAlert(
      'SunApps MES: Historian Poll Failed',
      `Equipment job could not poll Historian: ${err.message}`
    )
  }
}

module.exports = { run }
