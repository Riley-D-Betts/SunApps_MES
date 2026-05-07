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

    // Decorate UHTs with their active surge tank and surge tanks with their UHT.
    // routing is { UHT1: ['ST81','ST82'], UHT2: ['ST83','ST84'] } — each UHT is
    // permanently plumbed to two tanks. Active tank = whichever of the pair has
    // the highest positive level-delta this tick (level-delta > 0 means it's
    // being filled). Both connected tanks map back to the same UHT for the
    // reverse lookup (connectedUht on the surge tank object).
    const stToUht = {}
    const uhtActiveTank = {}
    for (const [uhtId, connectedTanks] of Object.entries(routing || {})) {
      if (!connectedTanks) continue
      const best = connectedTanks
        .map(tid => surgeTanks.find(s => s.tankId === tid))
        .filter(Boolean)
        .reduce((a, b) => ((b.pollDeltaGal ?? -Infinity) > (a?.pollDeltaGal ?? -Infinity) ? b : a), null)
      // Require >5 gal delta to distinguish genuine fill from sensor noise (~4 gal/tick).
      uhtActiveTank[uhtId] = (best?.pollDeltaGal > 5 ? best.tankId : null) ?? connectedTanks[0]
      for (const tid of connectedTanks) stToUht[tid] = uhtId
    }
    // activeFillTanks: the single tank per UHT pair that is confirmed rising this tick.
    const activeFillTanks = new Set(
      Object.values(uhtActiveTank).filter(tid => {
        const tank = surgeTanks.find(s => s.tankId === tid)
        return tank?.pollDeltaGal > 5
      })
    )
    const uhtsDecorated = uhts.map(u => ({ ...u, destSurgeTankId: uhtActiveTank[u.uhtId] || null }))
    const surgeTanksDecorated = surgeTanks.map(s => ({
      ...s,
      connectedUht: stToUht[s.tankId] || null,
      activeFill: activeFillTanks.has(s.tankId),
    }))

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
