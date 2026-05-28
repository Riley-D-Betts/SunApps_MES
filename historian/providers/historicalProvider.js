const RestProvider = require('./restProvider')
const clock = require('../../sim/clock')

// How long a fetched value is reused before the historian is asked again, in
// SIM-time milliseconds. The on-prem historian gets unhappy under 60×-cadence
// load when every cron fires every FQN at full sim speed; with this cache,
// each FQN is only refetched every CACHE_TTL_SIM_MS of simulated time even if
// every job asks for it on every tick.
const CACHE_TTL_SIM_MS = 5 * 60 * 1000  // 5 sim-minutes

// Max concurrent historian queries in flight. The on-prem AVEVA returns 500s
// (empty body) when the request rate gets too high — observed in production
// at >20 concurrent NTLM ProcessValues queries. This semaphore caps the
// in-flight count so a single tick's burst of dozens of FQN fetches drains
// in queued batches rather than overwhelming the server.
const MAX_INFLIGHT = 5

// Narrower window than RestProvider's default 30-min lookback so the
// historian doesn't have to scan and return huge ranges per tag per tick.
// 10 min still covers slowly-changing tags (NOTE_STRING, product index)
// while keeping the per-query payload small.
const VALUE_AT_WINDOW_MS = 10 * 60 * 1000

/**
 * Historical provider. Inherits every method from RestProvider unchanged;
 * the only difference is "what does 'now' mean":
 *
 *   - _getCurrentValue(fqn) reroutes to a sim-time-pinned ProcessValues
 *     lookup, gated by a per-FQN cache and a concurrency semaphore.
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
    // In-process semaphore: count of historian requests currently in flight.
    this._inflight = 0
    // FIFO of resolve callbacks for callers waiting on a slot.
    this._waitQueue = []
  }

  _now() {
    return clock.simNow()
  }

  async _acquire() {
    if (this._inflight < MAX_INFLIGHT) {
      this._inflight++
      return
    }
    await new Promise(resolve => this._waitQueue.push(resolve))
    this._inflight++
  }

  _release() {
    this._inflight--
    const next = this._waitQueue.shift()
    if (next) next()
  }

  async _getCurrentValue(fqn, { verbose = false } = {}) {
    const simNow = clock.simNow()
    const cached = this._fqnCache.get(fqn)
    // Skip cache when sim clock has rolled back (after a /reset) — the
    // cached entry now points to a "future" sim moment and is stale.
    if (cached && cached.simT <= simNow && simNow - cached.simT < CACHE_TTL_SIM_MS) {
      return cached.value
    }
    await this._acquire()
    let pv = null
    try {
      const pinned = new Date(simNow)
      const windowStart = new Date(pinned.getTime() - VALUE_AT_WINDOW_MS)
      const values = await this._queryProcessValues(fqn, windowStart, pinned, { verbose: false })
      pv = values.length > 0 ? values[values.length - 1] : null
    } finally {
      this._release()
    }
    this._fqnCache.set(fqn, { simT: simNow, value: pv })
    if (verbose) {
      console.log(`[HistoricalProvider] ${fqn} @ ${new Date(simNow).toISOString()} → ${pv ? `${pv.Value ?? pv.Text}` : 'null'}`)
    }
    return pv
  }
}

module.exports = HistoricalProvider
