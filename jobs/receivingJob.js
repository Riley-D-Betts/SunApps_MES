const statusStore = require('../services/statusStore')

/**
 * Polls the two milk receiving bays (XFR transfer objects) for the live
 * dashboard and the facility map. Read-only: nothing is written back.
 */
async function run(historian) {
  const pollStart = Date.now()
  try {
    const bays = await historian.getReceivingStatus()
    statusStore.setReceiving({ bays, pollDurationMs: Date.now() - pollStart })
    const active = bays.filter((b) => b.transferReady && !b.transferComplete)
    console.log(`[ReceivingJob] Polled ${bays.length} bays${active.length ? ' — ' + active.map((b) => `${b.bayId}: truck ${b.source || '?'} → ${b.destinations.join('+') || '?'} ${Math.round(b.qtyActualLbs)} lb`).join('; ') : ' — idle'} in ${Date.now() - pollStart}ms`)
  } catch (err) {
    console.error('[ReceivingJob] Poll error:', err.message)
    statusStore.pushEvent('receiving.poll.error', 'Receiving poll failed', { error: err.message })
  }
}

function reset() {}

module.exports = { run, reset }
