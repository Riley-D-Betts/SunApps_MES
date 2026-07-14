/**
 * Filler hours — time-in-state aggregation for filler machines.
 *
 * Classifies every moment of a time window into one of four categories by
 * merging the delta-stored Historian mode bits:
 *
 *   runtime  = CI_To_Proc.RunMode == 1 (highest priority — Auto_Sanitize_Mode
 *              stays ACTIVE during production, so sanitize must NOT be used)
 *   cip      = CIP_Mode_Enable OR CI_To_Proc.CIPRunning OR CI_To_Proc.SIPRunning
 *   idle     = machine on record but no mode active
 *   unknown  = Historian collection gaps (null disconnect markers)
 *
 * Tag notes (empirically verified against the Historian, SD-655):
 *   - Filler{N}.Filler_State / Filler_Status are NOT reliably collected
 *     (multi-day storage gaps) and their enum meanings are undocumented.
 *   - Only Filler 1 has a live machine-level tag set; Fillers 2-6 expose only
 *     stale WO-integration tags, so `filler` defaults to 1.
 *   - Filler{N}.Main_Drive_Current_Speed is delta-stored and reflects the SET
 *     run speed (cartons/min), not instantaneous speed. Reported as
 *     setSpeedCpm so callers can compare actual throughput to capacity.
 *   - Carton counters are historized too sparsely for rate math — derive
 *     effective rate from production records (e.g. NetSuite WOCs) instead.
 */

const stateTags = (filler) => ({
  run:     `Filler${filler}.CI_To_Proc.RunMode`,
  cipMode: `Filler${filler}.CIP_Mode_Enable`,
  cipRun:  `Filler${filler}.CI_To_Proc.CIPRunning`,
  sipRun:  `Filler${filler}.CI_To_Proc.SIPRunning`,
})

const speedTag = (filler) => `Filler${filler}.Main_Drive_Current_Speed`

// Value of a delta-stored (step) series at time t: last sample at or before t.
// The Historian injects a boundary row at the window start, so `null` here
// means the value is genuinely unknown (pre-history or disconnect marker).
function stepAt(series, t) {
  let v = null
  for (const p of series) {
    if (p.t <= t) v = p.v
    else break
  }
  return v
}

function classify(run, cipMode, cipRun, sipRun) {
  if (run === null && cipMode === null && cipRun === null && sipRun === null) return 'unknown'
  if (Number(run) === 1) return 'runtime'
  if (Number(cipMode) === 1 || Number(cipRun) === 1 || Number(sipRun) === 1) return 'cip'
  return 'idle'
}

/**
 * Compute time-in-state hours for one filler over [since, until].
 * `until` is clamped to now so live queries never count the future as unknown.
 *
 * @param {object} historian  provider instance (app.locals.historian)
 * @returns {{ filler, since, until, windowHours, hours, pct, setSpeedCpm, segments }}
 */
async function getFillerHours(historian, { filler = 1, since, until }) {
  const now = new Date()
  if (until > now) until = now
  if (!(since instanceof Date) || isNaN(since) || !(until instanceof Date) || isNaN(until) || since >= until) {
    throw new Error('Invalid time window')
  }

  const tags = stateTags(filler)
  const series = {}
  await Promise.all(Object.entries(tags).map(async ([key, fqn]) => {
    const rows = await historian._queryProcessValues(fqn, since, until, { verbose: false })
    series[key] = rows.map(r => ({ t: new Date(r.DateTime).getTime(), v: r.Value }))
  }))

  // Merge every change timestamp into one timeline and classify each slice.
  const stamps = new Set([since.getTime(), until.getTime()])
  for (const s of Object.values(series)) for (const p of s) stamps.add(p.t)
  const times = [...stamps]
    .filter(t => t >= since.getTime() && t <= until.getTime())
    .sort((a, b) => a - b)

  const totalsMs = { runtime: 0, cip: 0, idle: 0, unknown: 0 }
  const segments = []
  for (let i = 0; i < times.length - 1; i++) {
    const t0 = times[i], t1 = times[i + 1]
    const cat = classify(
      stepAt(series.run, t0),
      stepAt(series.cipMode, t0),
      stepAt(series.cipRun, t0),
      stepAt(series.sipRun, t0),
    )
    totalsMs[cat] += t1 - t0
    const last = segments[segments.length - 1]
    if (last && last.category === cat) last.end = new Date(t1).toISOString()
    else segments.push({ category: cat, start: new Date(t0).toISOString(), end: new Date(t1).toISOString() })
  }

  const windowMs = until.getTime() - since.getTime()
  const toHours = ms => Math.round(ms / 3600000 * 100) / 100
  const hours = {}
  const pct = {}
  for (const [cat, ms] of Object.entries(totalsMs)) {
    hours[cat] = toHours(ms)
    pct[cat] = Math.round(10000 * ms / windowMs) / 100
  }

  // Set run speed (cartons/min): last known value within the window. The tag
  // is delta-stored (samples can be weeks apart) but the Historian injects a
  // boundary row at `since`, so the window query always carries the value in.
  let setSpeedCpm = null
  try {
    const speedRows = await historian._queryProcessValues(speedTag(filler), since, until, { verbose: false })
    for (const r of speedRows) {
      if (r.Value !== null && !isNaN(Number(r.Value))) setSpeedCpm = Number(r.Value)
    }
  } catch (err) {
    console.warn(`[FillerHours] set-speed lookup failed for Filler${filler}:`, err.message)
  }

  return {
    filler,
    since: since.toISOString(),
    until: until.toISOString(),
    windowHours: toHours(windowMs),
    hours,
    pct,
    setSpeedCpm,
    segments,
  }
}

module.exports = { getFillerHours }
