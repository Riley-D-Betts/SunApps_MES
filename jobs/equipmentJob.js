const statusStore = require('../services/statusStore')
const notifyService = require('../services/notifyService')

// Minimum gal/tick delta required to count as genuine fill (above ~4 gal sensor noise).
const FILL_NOISE_GAL = 5
// Consecutive ticks the OTHER tank must exceed the noise floor before we switch designation.
const SWITCH_TICKS = 12  // 12 × 5s = 60s of sustained fill on the other tank
// Consecutive below-noise ticks across ALL connected tanks before clearing (UHT stopped/idle).
const IDLE_TICKS = 36    // 36 × 5s = 3 min of silence

// Persistent fill-tank state per UHT — survives across poll ticks so the badge
// is sticky and doesn't flicker when the level sensor dips to noise momentarily.
// Shape: { activeTankId: string|null, lowTickCount: number, otherHighTicks: {[tid]: number} }
const _fillState = {}

function resolveActiveFillTank(uhtId, connectedTanks, surgeTanks) {
  if (!_fillState[uhtId]) {
    _fillState[uhtId] = { activeTankId: null, lowTickCount: 0, otherHighTicks: {} }
  }
  const state = _fillState[uhtId]
  const deltaOf = tid => surgeTanks.find(s => s.tankId === tid)?.pollDeltaGal ?? 0
  const others   = tid => connectedTanks.filter(t => t !== tid)

  if (state.activeTankId === null) {
    const winner = connectedTanks.find(tid => deltaOf(tid) > FILL_NOISE_GAL)
    if (winner) {
      state.activeTankId = winner
      state.lowTickCount = 0
      state.otherHighTicks = {}
    }
    return state.activeTankId
  }

  if (deltaOf(state.activeTankId) > FILL_NOISE_GAL) {
    // Clearly filling — stay, reset counters
    state.lowTickCount = 0
    state.otherHighTicks = {}
    return state.activeTankId
  }

  // Active tank is below noise floor this tick — count it
  state.lowTickCount++

  // Track consecutive high-ticks for each non-active tank
  for (const tid of others(state.activeTankId)) {
    state.otherHighTicks[tid] = deltaOf(tid) > FILL_NOISE_GAL
      ? (state.otherHighTicks[tid] || 0) + 1
      : 0
  }

  // Switch only if another tank has been consistently above noise for SWITCH_TICKS
  const candidate = others(state.activeTankId)
    .find(tid => (state.otherHighTicks[tid] || 0) >= SWITCH_TICKS)
  if (candidate) {
    state.activeTankId = candidate
    state.lowTickCount = 0
    state.otherHighTicks = {}
    return state.activeTankId
  }

  // Clear designation if all tanks have been below noise for IDLE_TICKS (UHT stopped)
  if (state.lowTickCount >= IDLE_TICKS) {
    state.activeTankId = null
    state.lowTickCount = 0
    state.otherHighTicks = {}
    return null
  }

  // Sticky — keep current designation through the noise dip
  return state.activeTankId
}

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
    // permanently plumbed to two tanks. resolveActiveFillTank uses hysteresis so
    // the designation doesn't flicker on noise dips (see constants above).
    const stToUht = {}
    const uhtActiveTank = {}
    for (const [uhtId, connectedTanks] of Object.entries(routing || {})) {
      if (!connectedTanks) continue
      uhtActiveTank[uhtId] = resolveActiveFillTank(uhtId, connectedTanks, surgeTanks)
      for (const tid of connectedTanks) stToUht[tid] = uhtId
    }

    const activeFillSet = new Set(Object.values(uhtActiveTank).filter(Boolean))
    const uhtsDecorated = uhts.map(u => ({ ...u, destSurgeTankId: uhtActiveTank[u.uhtId] || null }))
    const surgeTanksDecorated = surgeTanks.map(s => ({
      ...s,
      connectedUht: stToUht[s.tankId] || null,
      activeFill: activeFillSet.has(s.tankId),
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

function reset() {
  for (const k of Object.keys(_fillState)) delete _fillState[k]
}

module.exports = { run, reset }
