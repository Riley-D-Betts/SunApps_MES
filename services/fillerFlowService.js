/**
 * Filler flow — windowed Filler 1 inlet flow analytics (SD-708).
 *
 * Serves run volumes, flow trend points, and totalizer deltas for the
 * TR11_FT1140 meter on the ThermaRoute leg (surge tanks ST81/82 → Filler 1).
 * State windows (runtime/cip/idle/unknown) come from fillerHoursService's
 * computeStateSegments so this report and Machine Efficiency agree.
 *
 * PROVIDER CAVEATS: historian._get/baseUrl BYPASS HistoricalProvider's sim
 * clock and MAX_INFLIGHT=3 semaphore (only _now/_getCurrentValue are
 * overridden) — under replay this endpoint reads the REAL historian at
 * wall-clock time, same as /api/mes/filler-hours. The AVEVA server 500s
 * (empty body) at 5-8 concurrent requests, so the AnalogSummary queries here
 * run SEQUENTIALLY; only the 4 discrete state reads (inside
 * computeStateSegments) are parallel — matching shipped filler-hours
 * behavior. MockProvider has no baseUrl/_get; the route answers 501 under
 * mock rather than throwing.
 *
 * TAG CAVEATS (SD-708 probe, scripts/probeTr11FillerFlow.js):
 *   - FQNs MUST come from RestProvider.TAGS — the `THermaRoute` totalizer
 *     prefix typo is the real catalog string and AnalogSummary $filter is
 *     case-SENSITIVE (wrong case silently returns zero rows).
 *   - ProcessValues is deadbanded to ~nothing for these analogs; AnalogSummary
 *     only. (The discrete state tags stay on ProcessValues — that's fine.)
 *   - The totalizer counts ALL flow incl. CIP/flush (~13.1k gal of flush
 *     before the first production run) — totalizer.deltaGal is NOT production
 *     volume; use volume.byState.runtime or runs[].
 *   - The totalizer is a RESETTABLE odometer (not resetting as of 2026-08);
 *     delta math is reset-tolerant: window Minimum < First flags a reset and
 *     volume falls back to Σ(minutely Average × 1 min) integration — the
 *     probe-validated method (0.05% agreement vs the odometer), NEVER the
 *     AnalogSummary `Integral` field (inconsistent time basis).
 *   - ProcessValues lags ~1 h during DST, so state near until≈now can trail
 *     into 'unknown'; AnalogSummary lag is undocumented (probe saw
 *     current-hour data) — the last trend bucket may be partial; the
 *     coverage/measured fields expose it.
 *   - History begins 2026-08-18T20:40Z; earlier windows return nulls, not
 *     errors.
 */

const RestProvider = require('../historian/providers/restProvider')
const { computeStateSegments, analogWindowFirstLast } = require('./fillerHoursService')

const { FILLER1_INLET_FLOW, FILLER1_INLET_FLOW_TOTAL } = RestProvider.TAGS

// Small tolerance for odometer noise when deciding "did it reset / go
// backwards" — well under the meter's per-sample quantization.
const RESET_EPS_GAL = 0.001

// Paged AnalogSummary read (the probe's getPaged generalized over
// historian._get). Sequential by design — see the semaphore caveat above.
async function analogSummaryPaged(historian, fqn, since, until, resolutionMs, cap = 100000) {
  const filter = `FQN eq '${fqn}' and StartDateTime ge ${since.toISOString()} and EndDateTime le ${until.toISOString()}`
  let url = `${historian.baseUrl}/AnalogSummary?$filter=${encodeURIComponent(filter)}&Resolution=${resolutionMs}`
  const all = []
  while (url && all.length < cap) {
    const data = await historian._get(url, { verbose: false })
    all.push(...(data?.value || []))
    url = data?.['@odata.nextLink'] || null
  }
  return all
}

const num = v => (v != null && !isNaN(Number(v)) ? Number(v) : null)

// Gallons that flowed during one AnalogSummary bucket: Average GPM × bucket
// minutes (actual row span, so partial tail buckets weigh correctly).
function rowGallons(row) {
  const avg = num(row.Average)
  if (avg == null) return 0
  const spanMin = (Date.parse(row.EndDateTime) - Date.parse(row.StartDateTime)) / 60000
  return spanMin > 0 ? avg * spanMin : 0
}

// Distribute one minutely row's gallons across [start, end] by time overlap.
function overlapFraction(row, startMs, endMs) {
  const rs = Date.parse(row.StartDateTime)
  const re = Date.parse(row.EndDateTime)
  if (re <= rs) return 0
  const lo = Math.max(rs, startMs)
  const hi = Math.min(re, endMs)
  return hi > lo ? (hi - lo) / (re - rs) : 0
}

/**
 * Windowed Filler 1 inlet flow report.
 *
 * @param {object} historian  provider instance (app.locals.historian) — must
 *                            expose baseUrl/_get (the route 501s otherwise)
 * @param {object} opts       { filler = 1, since: Date, until: Date,
 *                              resolution = 3600000 (ms per trend bucket) }
 */
async function getFillerFlow(historian, { filler = 1, since, until, resolution = 3600000 }) {
  const now = new Date()
  if (until > now) until = now

  const windowMs = until.getTime() - since.getTime()
  const bucketsExpected = Math.max(1, Math.ceil(windowMs / resolution))

  // 1. State windows (4 parallel ProcessValues — the shipped pattern).
  const { segments } = await computeStateSegments(historian, { filler, since, until })

  // 2. AnalogSummary reads, sequential (see header).
  const trendFlow = await analogSummaryPaged(historian, FILLER1_INLET_FLOW, since, until, resolution)
  const trendTot = await analogSummaryPaged(historian, FILLER1_INLET_FLOW_TOTAL, since, until, resolution)
  const minutely = resolution === 60000
    ? trendFlow
    : await analogSummaryPaged(historian, FILLER1_INLET_FLOW, since, until, 60000)
  const totWin = await analogWindowFirstLast(historian, FILLER1_INLET_FLOW_TOTAL, since, until)

  // 3. Reset detection over the whole window.
  const resetDetected = !!totWin && (
    (totWin.min != null && totWin.min < totWin.first - RESET_EPS_GAL) ||
    totWin.last < totWin.first - RESET_EPS_GAL
  )

  // 4. Reset-immune integrated volume (probe-validated: Σ avg × span).
  const integratedGal = minutely.reduce((s, r) => s + rowGallons(r), 0)

  // 5. Trend: one point per EXPECTED bucket — AnalogSummary omits empty
  // buckets, so gaps become explicit measured:false points. Rows are joined
  // to buckets numerically (nearest index), not by timestamp string.
  const flowByIdx = new Map()
  for (const r of trendFlow) {
    const idx = Math.round((Date.parse(r.StartDateTime) - since.getTime()) / resolution)
    if (idx >= 0 && idx < bucketsExpected && !flowByIdx.has(idx)) flowByIdx.set(idx, r)
  }
  const totByIdx = new Map()
  for (const r of trendTot) {
    const idx = Math.round((Date.parse(r.StartDateTime) - since.getTime()) / resolution)
    if (idx >= 0 && idx < bucketsExpected && !totByIdx.has(idx)) totByIdx.set(idx, r)
  }
  const trend = []
  for (let k = 0; k < bucketsExpected; k++) {
    const t = new Date(since.getTime() + k * resolution)
    const flow = flowByIdx.get(k)
    const tot = totByIdx.get(k)
    const samples = flow ? (flow.Count ?? 0) : 0
    const measured = !!flow && samples > 0
    // Per-bucket volume from the totalizer, spanned to the NEXT bucket's First
    // so the ~1 s between one bucket's Last and the next's First isn't dropped
    // (Σ then telescopes to the window delta exactly; per-bucket Last−First
    // undercounted ~81 gal/h at minutely resolution). Reset signature in or
    // across the bucket → integrate the bucket's average flow instead.
    let volumeGal = 0
    const totFirst = tot ? num(tot.First) : null
    const totLast = tot ? num(tot.Last) : null
    const totMin = tot ? num(tot.Minimum) : null
    const nextTot = totByIdx.get(k + 1)
    const totEnd = (nextTot ? num(nextTot.First) : null) ?? totLast
    if (totFirst != null && totEnd != null
        && totEnd >= totFirst - RESET_EPS_GAL
        && (totMin == null || totMin >= totFirst - RESET_EPS_GAL)) {
      volumeGal = Math.max(0, totEnd - totFirst)
    } else if (flow) {
      volumeGal = rowGallons(flow)
    }
    trend.push({
      t: t.toISOString(),
      avgGpm: measured ? num(flow.Average) : null,
      minGpm: measured ? num(flow.Minimum) : null,
      maxGpm: measured ? num(flow.Maximum) : null,
      volumeGal: Math.round(volumeGal * 10) / 10,
      samples,
      measured,
    })
  }

  // 6. Volume by state category + runs, from minutely integration distributed
  // across segments by time overlap (reset-immune, zero extra requests;
  // edge-bucket error ≤ ~1 gal at the observed ~84 GPM peak).
  const byState = { runtime: 0, cip: 0, idle: 0, unknown: 0 }
  const segMs = segments.map(s => ({
    category: s.category,
    startMs: Date.parse(s.start),
    endMs: Date.parse(s.end),
  }))
  const segGal = new Array(segMs.length).fill(0)
  for (const row of minutely) {
    const gal = rowGallons(row)
    if (!gal) continue
    for (let i = 0; i < segMs.length; i++) {
      const f = overlapFraction(row, segMs[i].startMs, segMs[i].endMs)
      if (f > 0) {
        segGal[i] += gal * f
        byState[segMs[i].category] += gal * f
      }
    }
  }
  for (const cat of Object.keys(byState)) byState[cat] = Math.round(byState[cat] * 10) / 10
  const runs = segMs
    .map((s, i) => ({ s, gal: segGal[i] }))
    .filter(({ s }) => s.category === 'runtime')
    .map(({ s, gal }) => {
      const minutes = (s.endMs - s.startMs) / 60000
      return {
        start: new Date(s.startMs).toISOString(),
        end: new Date(s.endMs).toISOString(),
        minutes: Math.round(minutes * 10) / 10,
        volumeGal: Math.round(gal * 10) / 10,
        avgGpm: minutes > 0 ? Math.round((gal / minutes) * 10) / 10 : null,
      }
    })

  // 7. Headline volume: odometer delta when trustworthy, integration on reset,
  // null when the window predates the tag's history entirely. The server
  // returns placeholder AnalogSummary rows (Count 0, "NaN" values) even for
  // pre-history windows, so "has data" means an actually-sampled bucket.
  const hasFlowData = minutely.some(r => (r.Count ?? 0) > 0 && num(r.Average) != null)
  let totalGal = null
  let method = null
  if (totWin && !resetDetected) {
    totalGal = Math.round((totWin.last - totWin.first) * 10) / 10
    method = 'totalizer'
  } else if (hasFlowData) {
    totalGal = Math.round(integratedGal * 10) / 10
    method = 'integrated'
  }

  const flowRowsSorted = (trendFlow.length ? trendFlow : minutely).filter(r => (r.Count ?? 0) > 0)
  return {
    filler,
    since: since.toISOString(),
    until: until.toISOString(),
    resolution,
    windowHours: Math.round(windowMs / 3600000 * 100) / 100,
    flowTag: FILLER1_INLET_FLOW,
    totalizerTag: FILLER1_INLET_FLOW_TOTAL,
    totalizer: totWin
      ? {
          first: totWin.first,
          last: totWin.last,
          deltaGal: Math.round((totWin.last - totWin.first) * 10) / 10,
          resetDetected,
        }
      : null,
    volume: {
      totalGal,
      method,
      integratedGal: Math.round(integratedGal * 10) / 10,
      byState,
    },
    runs,
    trend,
    coverage: {
      bucketsExpected,
      bucketsMeasured: trend.filter(p => p.measured).length,
      firstSampleAt: flowRowsSorted.length ? (flowRowsSorted[0].FirstDateTime ?? flowRowsSorted[0].StartDateTime) : null,
      lastSampleAt: flowRowsSorted.length
        ? (flowRowsSorted[flowRowsSorted.length - 1].LastDateTime ?? flowRowsSorted[flowRowsSorted.length - 1].EndDateTime)
        : null,
    },
  }
}

module.exports = { getFillerFlow }
