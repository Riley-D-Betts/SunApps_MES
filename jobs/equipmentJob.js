const statusStore = require('../services/statusStore')
const notifyService = require('../services/notifyService')
const itemConfig = require('../services/mesItemConfig')

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
    // Resolve each UHT's PLC item code (e.g. "200001") to its NetSuite item.
    // The lookup is cached after the first hit per code, so most polls are
    // instant. Failures are silent — we just leave currentItemName blank.
    const uhtsResolved = await Promise.all(uhts.map(async u => {
      let currentItemName = ''
      let currentItemNsId = null
      if (u.currentItem) {
        try {
          const resolved = await itemConfig.resolveNSItemByMesCode(u.currentItem)
          if (resolved) {
            currentItemName = resolved.name || ''
            currentItemNsId = resolved.id || null
          }
        } catch (err) {
          console.warn(`[EquipmentJob] Item resolve failed for ${u.uhtId}/${u.currentItem}: ${err.message}`)
        }
      }
      return { ...u, currentItemName, currentItemNsId }
    }))
    const uhtsDecorated = uhtsResolved.map(u => ({ ...u, destSurgeTankId: routing?.[u.uhtId] || null }))
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
