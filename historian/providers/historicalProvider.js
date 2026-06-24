const RestProvider = require('./restProvider')
const clock = require('../../sim/clock')

// How long a fetched value is reused before the historian is asked again, in
// SIM-time milliseconds. Tuned to ONLY de-dup the within-tick burst (multiple
// jobs reading the same FQN within the same cron fire) — must stay shorter
// than the cron interval or delta-tracked tags break (surge gallons,
// totalizers, the XFR rising-edge bit all need fresh values per tick).
const CACHE_TTL_SIM_MS = 15 * 1000  // 15 sim-seconds

// Max concurrent historian queries in flight. The on-prem AVEVA returns 500s
// (empty body) under sustained ProcessValues load — even at 5–8 concurrent
// requests with 10-min windows. Drop to 3 so the historian sees a steady
// trickle instead of a burst. This makes ticks take longer to drain but
// avoids the server giving up entirely.
const MAX_INFLIGHT = 3

// Failed-call retry with exponential backoff. Single retry handles the
// transient overload case — if the historian is still dying after one
// backoff, the cache won't refetch for CACHE_TTL_SIM_MS anyway so we
// won't spam it again immediately.
const RETRY_DELAYS_MS = [250, 750]

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
    // Aggregated fetch-failure stats so we log a summary instead of one
    // event per failed tag.
    this._fetchFailures = 0
    this._lastFailLogMs = 0
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
    let lastErr = null
    try {
      const pinned = new Date(simNow)
      const windowStart = new Date(pinned.getTime() - VALUE_AT_WINDOW_MS)
      for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
        try {
          const values = await this._queryProcessValues(fqn, windowStart, pinned, { verbose: false })
          pv = values.length > 0 ? values[values.length - 1] : null
          lastErr = null
          break
        } catch (err) {
          lastErr = err
          if (attempt < RETRY_DELAYS_MS.length) {
            await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt]))
          }
        }
      }
    } finally {
      this._release()
    }
    if (lastErr) {
      // After exhausted retries: swallow the error, return null, and let the
      // tick continue with partial data instead of failing the whole job.
      // Job code already handles null PVs gracefully (val(i)?.Value ?? 0
      // pattern everywhere). Log + count rather than spamming the event
      // stream — the summary lands in /health.
      this._fetchFailures++
      const now = Date.now()
      if (now - this._lastFailLogMs > 30_000) {
        console.warn(`[HistoricalProvider] ${this._fetchFailures} historian fetch failure(s) since last log; latest: ${fqn} → ${lastErr.message}`)
        this._lastFailLogMs = now
      }
      return null
    }
    this._fqnCache.set(fqn, { simT: simNow, value: pv })
    if (verbose) {
      console.log(`[HistoricalProvider] ${fqn} @ ${new Date(simNow).toISOString()} → ${pv ? `${pv.Value ?? pv.Text}` : 'null'}`)
    }
    return pv
  }
}

module.exports = HistoricalProvider
