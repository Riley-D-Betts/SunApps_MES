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
 *   - Filler{N}.Filler_State / Filler_Status are frozen registers (12 / 2
 *     through running, CIP, and idle alike) — never use them for state.
 *   - Only Filler 1 has a live machine-level tag set; Fillers 2-6 expose only
 *     stale WO-integration tags, so `filler` defaults to 1.
 *   - Filler{N}.Main_Drive_Current_Speed reflects the SET run speed
 *     (cartons/min). Reported as setSpeedCpm for capacity comparison.
 *   - RETRIEVAL GOTCHA: ProcessValues surfaces only sparse rows for many
 *     analog tags (and interpolates window boundaries), but AnalogSummary
 *     exposes the full underlying storage — the carton master counters are
 *     stored at ~1 Hz. Counter deltas MUST be read via AnalogSummary.
 *   - L{1,2}_Carton_Count_Master are lifetime cumulative per-SIDE counters
 *     (Filler 1's two sides, both report Line 1); their sum matches
 *     Carton_Count_Total's increments. Never reset, so window deltas are
 *     exact: cartons = (last - first) per side, summed.
 */

const stateTags = (filler) => ({
  run:     `Filler${filler}.CI_To_Proc.RunMode`,
  cipMode: `Filler${filler}.CIP_Mode_Enable`,
  cipRun:  `Filler${filler}.CI_To_Proc.CIPRunning`,
  sipRun:  `Filler${filler}.CI_To_Proc.SIPRunning`,
})

const speedTag = (filler) => `Filler${filler}.Main_Drive_Current_Speed`
const masterCountTags = (filler) => [
  `Filler${filler}.L1_Carton_Count_Master`,
  `Filler${filler}.L2_Carton_Count_Master`,
]

// First/Last of a tag over [since, until] via a single-bucket AnalogSummary.
// Unlike ProcessValues, this reads the full underlying storage (no sparse-row
// illusion, no boundary interpolation).
async function analogWindowFirstLast(historian, fqn, since, until) {
  const resolution = Math.max(until.getTime() - since.getTime(), 1000)
  const filter = `FQN eq '${fqn}' and StartDateTime ge ${since.toISOString()} and EndDateTime le ${until.toISOString()}`
  const url = `${historian.baseUrl}/AnalogSummary?$filter=${encodeURIComponent(filter)}&Resolution=${resolution}`
  const data = await historian._get(url, { verbose: false })
  const row = data.value?.[0]
  if (!row || row.First == null || row.Last == null) return null
  return { first: Number(row.First), last: Number(row.Last), count: row.Count ?? null }
}

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

  // Cartons produced: exact window deltas of the lifetime per-side master
  // counters (both sides belong to the same report line).
  let cartons = null
  let cartonsBySide = null
  try {
    const sides = await Promise.all(
      masterCountTags(filler).map(fqn => analogWindowFirstLast(historian, fqn, since, until))
    )
    if (sides.every(Boolean)) {
      cartonsBySide = sides.map(s => Math.round(s.last - s.first))
      cartons = cartonsBySide.reduce((a, b) => a + b, 0)
    }
  } catch (err) {
    console.warn(`[FillerHours] carton-count lookup failed for Filler${filler}:`, err.message)
  }

  // True effective rate over machine run time, vs setSpeedCpm capacity.
  const runtimeMin = totalsMs.runtime / 60000
  const effectiveCpm = cartons !== null && runtimeMin > 0
    ? Math.round(cartons / runtimeMin * 10) / 10
    : null

  return {
    filler,
    since: since.toISOString(),
    until: until.toISOString(),
    windowHours: toHours(windowMs),
    hours,
    pct,
    setSpeedCpm,
    cartons,
    cartonsBySide,
    effectiveCpm,
    segments,
  }
}

module.exports = { getFillerHours }
