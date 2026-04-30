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
    const [silos, uhts, surgeTanks, routing] = await Promise.all([
      historian.getSiloStatus(),
      historian.getUhtStatus(),
      historian.getSurgeTankStatus(),
      historian.getUhtSurgeTankRouting(),
    ])

    // Decorate UHTs with their routed surge tank, and surge tanks with the
    // UHT that's connected to them (reverse map). Operators only ever route
    // one UHT per surge tank at a time, so the matrix is sparse — at most
    // 2 of the 4 surge tanks have a connectedUht at any moment.
    const stToUht = {}
    for (const [uht, st] of Object.entries(routing || {})) {
      if (st) stToUht[st] = uht
    }
    const uhtsDecorated = uhts.map(u => ({ ...u, destSurgeTankId: routing?.[u.uhtId] || null }))
    const surgeTanksDecorated = surgeTanks.map(s => ({ ...s, connectedUht: stToUht[s.tankId] || null }))

    const durationMs = Date.now() - pollStart

    statusStore.setSilos({ silos, pollDurationMs: durationMs })
    statusStore.setUhts({ uhts: uhtsDecorated, pollDurationMs: durationMs })
    statusStore.setSurgeTanks({ tanks: surgeTanksDecorated, pollDurationMs: durationMs })

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
