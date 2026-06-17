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

/**
 * For a separation batch, find when the separator actually started flowing.
 *
 * Primary strategy: FEEDPERMIT rising edge (0→1 transition) — the same
 * signal the state machine uses to open a batch, so the actual start is the
 * last 0→1 edge before openTime.
 *
 * Also reads SepFeedTotal (the cumulative feed odometer) at the rising edge
 * so the caller can correct feedStartLbs and recover milk that flowed before
 * MES detected the batch.
 *
 * @param {Date}   openTime  when MES opened the batch (snap.pollTime)
 * @param {object} historian restProvider / historicalProvider
 * @param {object} [opts]    { lookbackMs }
 * @returns {{ estimatedStartAt: Date, feedLbsAtStart: number, method: string } | null}
 */
async function findSeparationActualStart(openTime, historian, opts = {}) {
  if (!historian?._queryProcessValues) return null
  const since = new Date(openTime.getTime() - (opts.lookbackMs ?? SEPARATION_LOOKBACK_MS))

  let estimatedStartAt = null
  try {
    const fpRows = await historian._queryProcessValues('SEPSTAT.FEEDPERMIT', since, openTime, { verbose: false })
    if (fpRows && fpRows.length >= 2) {
      const series = fpRows
        .map(r => ({ t: new Date(r.DateTime), v: parseFloat(r.Value) || 0 }))
        .filter(p => !isNaN(p.v))
        .sort((a, b) => a.t - b.t)
      // Walk backward to find the last 0→1 transition before openTime
      for (let i = series.length - 2; i >= 0; i--) {
        if (series[i].v < 0.5 && series[i + 1].v >= 0.5) {
          estimatedStartAt = series[i + 1].t
          break
        }
      }
    }
  } catch {}

  if (!estimatedStartAt) return null

  // Read SepFeedTotal at the actual start to provide a corrected baseline.
  // Query from estimatedStartAt to openTime and take the earliest sample —
  // the first reading after the permit rose is the baseline we should have set.
  let feedLbsAtStart = null
  try {
    const feedRows = await historian._queryProcessValues(
      'Product.SepFeedTotal', estimatedStartAt, openTime, { verbose: false }
    )
    if (feedRows && feedRows.length > 0) {
      const sorted = feedRows.sort((a, b) => new Date(a.DateTime) - new Date(b.DateTime))
      feedLbsAtStart = parseFloat(sorted[0].Value)
    }
  } catch {}

  if (feedLbsAtStart == null || !isFinite(feedLbsAtStart)) return null

  return { estimatedStartAt, feedLbsAtStart, method: 'feedpermit-rising-edge' }
}

module.exports = {
  findBlendTankActualStart,
  findSurgeTankActualStart,
  integrateFt1102BackfillGal,
  findSeparationActualStart,
}
