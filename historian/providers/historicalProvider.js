const RestProvider = require('./restProvider')
const clock = require('../../sim/clock')

// How long a fetched value is reused before the historian is asked again, in
// SIM-time milliseconds. The on-prem historian gets unhappy under 60×-cadence
// load when every cron fires every FQN at full sim speed; with this cache,
// each FQN is only refetched every CACHE_TTL_SIM_MS of simulated time even if
// every job asks for it on every tick.
const CACHE_TTL_SIM_MS = 30 * 1000  // 30 sim-seconds

/**
 * Historical provider. Inherits every method from RestProvider unchanged;
 * the only difference is "what does 'now' mean":
 *
 *   - _getCurrentValue(fqn) reroutes to _getValueAt(fqn, simNow()) so each
 *     read returns the historian's recorded value at the sim clock's
 *     current pinned timestamp, throttled by a per-FQN sim-time cache.
 *   - _now() returns simNow() so the UHT software-totalizer's delta math
 *     uses sim-elapsed intervals (not wall-clock).
 *
 * Delta tracking (_prevCreamTotal, _prevSurgeGal, _prevTransferComplete,
 * _uhtMilkGal, etc.) evolves naturally as the MES ticks through sim time —
 * each call sees the next sim moment and computes the next delta against
 * the previous one. Same code path as live; only the data source moves.
 */
class HistoricalProvider extends RestProvider {
  constructor() {
    super()
    // Map<fqn, { simT: number, value: object|null }>
    this._fqnCache = new Map()
  }

  _now() {
    return clock.simNow()
  }

  async _getCurrentValue(fqn, { verbose = false } = {}) {
    const simNow = clock.simNow()
    const cached = this._fqnCache.get(fqn)
    // Skip cache when sim clock has rolled back (after a /reset) — the
    // cached entry now points to a "future" sim moment and is stale.
    if (cached && cached.simT <= simNow && simNow - cached.simT < CACHE_TTL_SIM_MS) {
      return cached.value
    }
    // Use the same Tags(fqn)/Raw endpoint that live RestProvider uses, just
    // filtered to "latest at or before pinned sim time" — returns a single
    // point per call instead of a 30-min window scan, so the historian is
    // not asked to materialize huge ranges per tag per tick.
    const isoSim = new Date(simNow).toISOString()
    const filter = `DateTime le ${isoSim}`
    const url = `${this.baseUrl}/Tags('${encodeURIComponent(fqn)}')/Raw?$filter=${encodeURIComponent(filter)}&$orderby=DateTime%20desc&$top=1`
    let pv = null
    try {
      const data = await this._get(url, { verbose: false })
      pv = data.value?.[0] || null
    } catch (err) {
      // Fall back to the ProcessValues window scan if the Raw endpoint
      // rejects the DateTime filter for this tag (some on-prem builds are
      // picky about which historic queries Tags/Raw will honor).
      try {
        pv = await this._getValueAt(fqn, new Date(simNow))
      } catch (e2) {
        throw err  // surface the original Raw-endpoint failure
      }
    }
    this._fqnCache.set(fqn, { simT: simNow, value: pv })
    if (verbose) {
      console.log(`[HistoricalProvider] ${fqn} @ ${isoSim} → ${pv ? `${pv.Value ?? pv.Text}` : 'null'}`)
    }
    return pv
  }
}

module.exports = HistoricalProvider
