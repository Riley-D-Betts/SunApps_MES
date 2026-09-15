/**
 * Back-project actual batch start times from historian history.
 *
 * When MES detects a new blend/surge batch, `detectedAt` is set to clock.now()
 * — the moment the polling loop noticed the trigger.  The actual physical
 * process (milk flowing from a silo, UHT filling a surge tank) started
 * earlier.  These functions query historian history to find the real start
 * and return { estimatedStartAt, method } for storage as `actualStartAt`.
 *
 * Both functions return null when no clear start can be found in the lookback
 * window (e.g. replays with limited history, very short fills).
 */

const LINES = ['ML1', 'ML2', 'ML3', 'ML4', 'CL1', 'CL2']

const BLEND_LOOKBACK_MS      = 6 * 60 * 60 * 1000  // 6 h — covers late-named fills
const SURGE_LOOKBACK_MS      = 4 * 60 * 60 * 1000  // 4 h — covers fill-and-drain cycle
const SEPARATION_LOOKBACK_MS = 2 * 60 * 60 * 1000  // 2 h — covers feed-permit gaps

// Max gap between consecutive REQUESTED_BY samples for the same tank before
// we treat the gap as a fill boundary (different batch / idle period).
const LINE_GAP_MS = 20 * 60 * 1000  // 20 min

const SURGE_MIN_RISE_GAL = 100   // gal net rise required to call a surge start real
const BLEND_MIN_RISE_LBS = 200   // lbs rise required for the weight fallback

// Separator totalizer tags + densities (mirror historian/providers/restProvider).
// Feed is LBS; cream/skim are GAL converted to lbs by density so all three
// baselines are in the same unit. ALL THREE are per-transfer counters that
// SCADA zeroes a few seconds to ~9 min AFTER the FEEDPERMIT edge (SD-722, see
// services/separatorTotalizer.js) — a reading at the edge is usually the
// PREVIOUS transfer's final total, not a baseline for this one.
const SEP_FEED_TOTAL_TAG  = 'Product.SepFeedTotal'
const SEP_CREAM_TOTAL_TAG = 'Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized'
const SEP_SKIM_TOTAL_TAG  = 'Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized'
const CREAM_DENSITY_PPG = 8.3
const SKIM_DENSITY_PPG  = 8.63
// Feed-permit off-gaps shorter than this are treated as flicker (a brief drop at
// a source/destination change), not a true end of the feed-on run.
const FEEDPERMIT_FLICKER_MS = 90 * 1000

const { isReset } = require('./separatorTotalizer')

/**
 * For a blend tank, find when milk actually started flowing into it.
 *
 * Primary strategy: LINE_REQUESTED_BY on all six milk lines.  The SCADA sets
 * the destination vessel name the moment a line begins flowing, so the
 * earliest continuous stretch pointing at this tank = actual start of flow.
 *
 * Fallback: BT_WEIGHT_LBS rising edge (handles late-named batches where
 * REQUESTED_BY was empty or pointed at "Unrouted" during the fill).
 *
 * @param {string}   tankId           e.g. 'BlendTank1A'
 * @param {Date}     detectedAt       when MES triggered the batch open
 * @param {object}   historian        restProvider / historicalProvider
 * @param {Function} normalizeTankRef canonical tank-name normalizer
 * @param {object}   [opts]           { lookbackMs }
 * @returns {{ estimatedStartAt: Date, method: string } | null}
 */
async function findBlendTankActualStart(tankId, detectedAt, historian, normalizeTankRef, opts = {}) {
  if (!historian?._queryProcessValues) return null
  const since = new Date(detectedAt.getTime() - (opts.lookbackMs ?? BLEND_LOOKBACK_MS))
  const tankCanonical = normalizeTankRef(tankId)

  // Query REQUESTED_BY for all six lines in parallel
  const lineResults = await Promise.all(
    LINES.map(async line => {
      try {
        return await historian._queryProcessValues(
          `${line}.REQUESTEDBY`, since, detectedAt, { verbose: false }
        )
      } catch {
        return []
      }
    })
  )

  // Collect timestamps where any line was pointing at this tank
  const qualifying = []
  for (const rows of lineResults) {
    for (const r of rows) {
      if (normalizeTankRef(r.Value || '') === tankCanonical) {
        qualifying.push(new Date(r.DateTime))
      }
    }
  }

  if (qualifying.length > 0) {
    qualifying.sort((a, b) => a - b)
    const blockStart = _findContiguousBlockStart(qualifying, LINE_GAP_MS)
    if (blockStart) return { estimatedStartAt: blockStart, method: 'line-requested-by' }
  }

  // Fallback: weight-based rising edge
  try {
    const rows = await historian._queryProcessValues(
      `${tankId}.100LT.SCL_LBS`, since, detectedAt, { verbose: false }
    )
    if (rows && rows.length >= 4) {
      const series = rows
        .map(r => ({ t: new Date(r.DateTime), v: parseFloat(r.Value) }))
        .filter(p => !isNaN(p.v))
        .sort((a, b) => a.t - b.t)
      const result = _findRisingEdge(series, BLEND_MIN_RISE_LBS)
      if (result) return { estimatedStartAt: result.estimatedStartAt, method: 'weight-rising-edge' }
    }
  } catch {}

  return null
}

/**
 * For a surge tank, find when the UHT actually started filling it.
 * Uses the surge-level-gallons rising edge.
 *
 * @param {string} tankId     e.g. 'ST83'
 * @param {Date}   detectedAt when MES triggered the batch open
 * @param {object} historian  restProvider / historicalProvider
 * @param {object} [opts]     { lookbackMs }
 * @returns {{ estimatedStartAt: Date, method: string } | null}
 */
async function findSurgeTankActualStart(tankId, detectedAt, historian, opts = {}) {
  if (!historian?._queryProcessValues) return null
  const since = new Date(detectedAt.getTime() - (opts.lookbackMs ?? SURGE_LOOKBACK_MS))

  // Derive FQN: ST81 → ThermaRoute.ThermaRoute.ST81_LT8101_Gal
  // The num is the single digit at the end of ST8N (1–4).
  const num = parseInt(tankId.replace('ST8', ''), 10)
  if (isNaN(num)) return null
  const fqn = `ThermaRoute.ThermaRoute.${tankId}_LT8${num}01_Gal`

  try {
    const rows = await historian._queryProcessValues(fqn, since, detectedAt, { verbose: false })
    if (!rows || rows.length < 4) return null
    const series = rows
      .map(r => ({ t: new Date(r.DateTime), v: parseFloat(r.Value) }))
      .filter(p => !isNaN(p.v))
      .sort((a, b) => a.t - b.t)
    const result = _findRisingEdge(series, SURGE_MIN_RISE_GAL)
    if (result) return { estimatedStartAt: result.estimatedStartAt, method: 'level-rising-edge' }
  } catch {}

  return null
}

/**
 * Given a sorted-ascending array of timestamps, find the start of the last
 * contiguous block where all consecutive gaps are <= maxGapMs.
 * Works backward from the most recent sample.
 */
function _findContiguousBlockStart(sorted, maxGapMs) {
  if (!sorted.length) return null
  let blockStart = sorted[sorted.length - 1]
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (sorted[i + 1] - sorted[i] > maxGapMs) break
    blockStart = sorted[i]
  }
  return blockStart
}

/**
 * Walk a sorted-ascending [{t, v}] series backward to find the start of the
 * current rising segment.  Looks for the last point where the value was at
 * least minRise below the endpoint, then advances forward to the first
 * sustained upward step.
 */
function _findRisingEdge(series, minRise) {
  if (!series || series.length < 4) return null
  const endVal = series[series.length - 1].v
  const step = minRise * 0.05   // 5% of minRise as the "sustained upward" threshold

  let minVal = endVal
  let minIdx = series.length - 1

  for (let i = series.length - 2; i >= 0; i--) {
    const v = series[i].v
    if (v < minVal) { minVal = v; minIdx = i }

    if (endVal - v >= minRise) {
      // series[i] is before the fill. Walk forward to the first upward step.
      for (let j = i; j < series.length - 1; j++) {
        if (series[j + 1].v > series[j].v + step) {
          return { estimatedStartAt: series[j].t }
        }
      }
      return { estimatedStartAt: series[minIdx].t }
    }
  }

  return null
}

/**
 * Integrate UHT FT1102_Output (milk inlet GPM) over [since, until] from
 * historian to estimate how many gallons accumulated BEFORE the batch was
 * detected.  The result can be subtracted from the current software totalizer
 * to back-fill the issue-state baseline (surgeTankMesService pre-seeding).
 *
 * Uses trapezoidal integration; only counts positive GPM values.  Returns 0
 * when data is unavailable or the window is empty.
 *
 * @param {string} uhtId     'UHT1' or 'UHT2'
 * @param {Date}   since     start of backfill window (actual batch start)
 * @param {Date}   until     end of backfill window (detection time)
 * @param {object} historian restProvider / historicalProvider
 * @returns {Promise<number>} gallons accumulated in the window; 0 on failure
 */
async function integrateFt1102BackfillGal(uhtId, since, until, historian) {
  if (!historian?._queryProcessValues || !uhtId) return 0
  if (until <= since) return 0
  const tag = `${uhtId}.FT1102_Output`
  try {
    const rows = await historian._queryProcessValues(tag, since, until, { verbose: false })
    if (!rows || rows.length < 2) return 0
    const series = rows
      .map(r => ({ t: new Date(r.DateTime), v: Math.max(0, parseFloat(r.Value) || 0) }))
      .filter(p => isFinite(p.v))
      .sort((a, b) => a.t - b.t)
    if (series.length < 2) return 0
    let totalGal = 0
    for (let i = 1; i < series.length; i++) {
      const elapsedMin = (series[i].t - series[i - 1].t) / 60000
      const avgGpm = (series[i - 1].v + series[i].v) / 2
      if (avgGpm > 0 && elapsedMin > 0) totalGal += avgGpm * elapsedMin
    }
    return totalGal
  } catch {
    return 0
  }
}

const SEP_SUMMARY_RESOLUTION_MS = 30 * 1000

/**
 * Time-ordered readings for one analog tag from AnalogSummary buckets
 * (First, Minimum@MinDateTime, Maximum@MaxDateTime, Last) — Min/Max keep their
 * own timestamps so a reset inside one bucket stays visible and in order.
 * Placeholder buckets (Count 0, "NaN") contribute nothing. Sequential paging.
 *
 * AnalogSummary, NOT ProcessValues, for the separator totalizers: ProcessValues
 * is swinging-door compressed and DST-lagged, and its window-boundary values
 * are wrong for these tags (batch 169: it returned 1,851 / 868 lb around the
 * edge while AnalogSummary shows the counter holding 250,651 lb), which faked
 * a reset. Reads bypass HistoricalProvider's semaphore (like fillerFlowService),
 * so callers must keep them sequential. Returns null when the provider can't
 * do raw OData (mock).
 */
async function analogSummaryPoints(historian, tag, start, end, resolutionMs = SEP_SUMMARY_RESOLUTION_MS) {
  if (!historian?._get || !historian.baseUrl) return null
  const filter = `FQN eq '${tag}' and StartDateTime ge ${start.toISOString()} and EndDateTime le ${end.toISOString()}`
  let url = `${historian.baseUrl}/AnalogSummary?$filter=${encodeURIComponent(filter)}&Resolution=${resolutionMs}`
  const rows = []
  while (url) {
    const d = await historian._get(url, { verbose: false })
    rows.push(...(d?.value || []))
    url = d?.['@odata.nextLink'] || null
  }
  const pts = []
  const add = (t, v) => {
    const n = v != null ? Number(v) : NaN
    if (isFinite(n) && isFinite(t)) pts.push({ t, v: n })
  }
  for (const x of rows) {
    if ((x.Count ?? 1) === 0) continue
    const st = new Date(x.StartDateTime).getTime()
    const en = x.EndDateTime ? new Date(x.EndDateTime).getTime() : st + resolutionMs
    add(st, x.First)
    if (x.MinDateTime) { const t = new Date(x.MinDateTime).getTime(); if (t >= st && t <= en) add(t, x.Minimum) }
    if (x.MaxDateTime) { const t = new Date(x.MaxDateTime).getTime(); if (t >= st && t <= en) add(t, x.Maximum) }
    add(en, x.Last)
  }
  return pts.sort((a, b) => a.t - b.t)
}

/**
 * Reset-aware baseline for one separator totalizer at a back-projected start.
 *
 * Reads the tag over [edge, until] (until = the MES open time, i.e. only data
 * that existed when the batch opened — replay must not see the future). The
 * value at the edge is the first reading at/after it. If any later reading is
 * a reset (SCADA zeroing the counter for this transfer) the baseline is 0: the
 * batch counts from the reset. SD-722: the old code returned the edge reading,
 * which is the previous transfer's final total (batch 175: feed 172,066 lb,
 * reset 12 s after the edge). Resets after the open are caught per tick by
 * separatorStateMachine. Returns { value, resetSeen } (tag units) or null.
 */
async function _resetAwareBaselineAt(tag, edge, until, historian) {
  try {
    const startMs = Math.floor(edge.getTime() / SEP_SUMMARY_RESOLUTION_MS) * SEP_SUMMARY_RESOLUTION_MS
    const endMs = Math.max(until ? until.getTime() : 0, startMs) + SEP_SUMMARY_RESOLUTION_MS
    const pts = await analogSummaryPoints(historian, tag, new Date(startMs), new Date(endMs))
    if (!pts || !pts.length) return null
    const inWin = pts.filter(p => p.t <= endMs)
    if (!inWin.length) return null
    let prev = inWin[0].v
    for (const p of inWin.slice(1)) {
      if (isReset(prev, p.v)) return { value: 0, resetSeen: true }
      prev = p.v
    }
    return { value: inWin[0].v, resetSeen: false }
  } catch {
    return null
  }
}

/**
 * Walk a sorted-ascending FEEDPERMIT series ({t, on}) backward from the most
 * recent ON sample to the start of the sustained feed-on run, treating OFF gaps
 * shorter than `flickerMs` as still-on (a brief permit drop at a source/dest
 * change is flicker, not a true end of the run).
 */
function _sustainedFeedStart(series, flickerMs) {
  if (!series.length) return null
  let i = series.length - 1
  while (i >= 0 && !series[i].on) i--          // skip trailing OFF samples
  if (i < 0) return null
  let blockStart = series[i].t
  let j = i - 1
  while (j >= 0) {
    if (series[j].on) { blockStart = series[j].t; j--; continue }
    // Contiguous run of OFF samples ending at j; measure the off duration as
    // (first-off → next-on). A real gap ends the run; flicker is skipped.
    let k = j
    while (k - 1 >= 0 && !series[k - 1].on) k--
    const offDuration = series[j + 1].t - series[k].t
    if (offDuration >= flickerMs) break
    j = k - 1
  }
  return blockStart
}

/**
 * For a separation batch, find when the separator actually started flowing and
 * the feed/cream/skim totalizer baselines at that moment.
 *
 * The true start is the beginning of the sustained FEEDPERMIT-on run (flicker
 * at source/destination boundaries debounced). All three baselines are taken
 * reset-aware over [edge, openTime] so their deltas measure the same physical
 * run: a reset seen in that span means baseline 0 (SD-722). Feed is lbs;
 * cream/skim are gal × density → lbs.
 *
 * @param {Date}   openTime  when MES opened the batch (snap.pollTime)
 * @param {object} historian restProvider / historicalProvider
 * @param {object} [opts]    { lookbackMs }
 * @returns {{ estimatedStartAt: Date, feedStart: number, creamStart: number|null,
 *            skimStart: number|null, resetSeen: {feed,cream,skim}, method: string } | null}
 */
async function findSeparationActualStart(openTime, historian, opts = {}) {
  if (!historian?._queryProcessValues) return null
  const since = new Date(openTime.getTime() - (opts.lookbackMs ?? SEPARATION_LOOKBACK_MS))

  let estimatedStartAt = null
  try {
    const fpRows = await historian._queryProcessValues('SEPSTAT.FEEDPERMIT', since, openTime, { verbose: false })
    if (fpRows && fpRows.length >= 2) {
      const series = fpRows
        .map(r => ({ t: new Date(r.DateTime), on: (parseFloat(r.Value) || 0) >= 0.5 }))
        .filter(p => !isNaN(p.t.getTime()))
        .sort((a, b) => a.t - b.t)
      estimatedStartAt = _sustainedFeedStart(series, FEEDPERMIT_FLICKER_MS)
    }
  } catch {}

  if (!estimatedStartAt) return null

  // Reset-aware baselines for all three totalizers at the true start (SD-722).
  // Feed is required (it's the input measure); cream/skim are best-effort
  // (null leaves the open baseline).
  // Sequential: AnalogSummary reads bypass the replay semaphore (AVEVA 500s at
  // 5–8 concurrent requests).
  const feed = await _resetAwareBaselineAt(SEP_FEED_TOTAL_TAG, estimatedStartAt, openTime, historian)
  const cream = await _resetAwareBaselineAt(SEP_CREAM_TOTAL_TAG, estimatedStartAt, openTime, historian)
  const skim = await _resetAwareBaselineAt(SEP_SKIM_TOTAL_TAG, estimatedStartAt, openTime, historian)
  if (feed == null || !isFinite(feed.value)) return null
  const lbs = (r, ppg) => (r != null && isFinite(r.value) ? r.value * ppg : null)

  return {
    estimatedStartAt,
    feedStart: feed.value,
    creamStart: lbs(cream, CREAM_DENSITY_PPG),
    skimStart: lbs(skim, SKIM_DENSITY_PPG),
    // Which totalizers were seen resetting between the edge and the open
    // (baseline forced to 0 for those).
    resetSeen: { feed: !!feed.resetSeen, cream: !!cream?.resetSeen, skim: !!skim?.resetSeen },
    method: 'feedpermit-sustained-edge',
  }
}

module.exports = {
  findBlendTankActualStart,
  findSurgeTankActualStart,
  integrateFt1102BackfillGal,
  findSeparationActualStart,
  // exported for scripts/recomputeSeparationVolumes.js (same baseline logic)
  _resetAwareBaselineAt,
  analogSummaryPoints,
}
