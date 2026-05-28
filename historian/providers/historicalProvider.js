const RestProvider = require('./restProvider')
const clock = require('../../sim/clock')

/**
 * Historical provider. Inherits every method from RestProvider unchanged;
 * the only difference is "what does 'now' mean":
 *
 *   - _getCurrentValue(fqn) reroutes to _getValueAt(fqn, simNow()) so each
 *     read returns the historian's recorded value at the sim clock's
 *     current pinned timestamp.
 *   - _now() returns simNow() so the UHT software-totalizer's delta math
 *     uses sim-elapsed intervals (not wall-clock).
 *
 * Delta tracking (_prevCreamTotal, _prevSurgeGal, _prevTransferComplete,
 * _uhtMilkGal, etc.) evolves naturally as the MES ticks through sim time —
 * each call sees the next sim moment and computes the next delta against
 * the previous one. Same code path as live; only the data source moves.
 */
class HistoricalProvider extends RestProvider {
  _now() {
    return clock.simNow()
  }

  async _getCurrentValue(fqn, { verbose = false } = {}) {
    const pv = await this._getValueAt(fqn, new Date(clock.simNow()))
    if (verbose) {
      console.log(`[HistoricalProvider] ${fqn} @ ${new Date(clock.simNow()).toISOString()} → ${pv ? `${pv.Value ?? pv.Text}` : 'null'}`)
    }
    return pv
  }
}

module.exports = HistoricalProvider
