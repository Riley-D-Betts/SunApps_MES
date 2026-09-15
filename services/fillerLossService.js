'use strict'

/**
 * Filler 1 loss (SD-722) — the "Fillers" step of the Milk Loss product path,
 * for line 1, the only filler with an inlet meter.
 *
 *   loss = milk into Filler 1 while RunMode = 1  −  good cartons × carton volume
 *
 * Milk in: TR11_FT1140 gallons during Filler1.CI_To_Proc.RunMode runtime,
 * straight from fillerFlowService (volume.byState.runtime — minutely
 * integration split by the same state segments Machine Efficiency uses; flush
 * and CIP flow are excluded).
 *
 * Cartons out: Filler1.L1_Carton_Count_Good + L2_Carton_Count_Good (the lane
 * counters packagingTags.js reads), hourly AnalogSummary. These counters DO
 * reset (unlike the lifetime *_Master counters), so each hour counts
 * First→Last plus the step from the previous hour's Last, and a drop (Minimum
 * below First, or First below the previous Last) is treated as a reset.
 *
 * Carton volume, two ways (both always computed; `join` says which is used):
 *   'netsuite-pallets' — the SKU on line 1 at that hour, from NetSuite pallet
 *     completions (WOCompl with custbody_woc_line = 1; createddate is plant
 *     time, ~1 h behind the cartons). An hour takes the SKU of the pallets
 *     completed in the two hours after it starts; with none, the nearest line-1
 *     pallet within 8 h. Volume per SKU from fgCartonVolumeService (labelled
 *     carton mL). Used when it covers ≥ MIN_COVERAGE of the good cartons.
 *   'historian-carton-size' — the filler's own per-lane fill setting,
 *     Filler1.L1/L2_Total_Fill_Volume (mL per carton, step-held; it drops to
 *     350 for a second at stops, so values under 500 are ignored). Verified
 *     2026-09-15: ~1790 mL while 59 oz Alexandre ran, 1893–1920 on 64 oz half &
 *     half, ~1950 on Aldi 64 oz. (L1/L2_Current_Carton_Size is only the 64 oz
 *     carton code and the per-station *_Operating_Volume values are servo
 *     doses — neither is the fill.) Used when the NetSuite join cannot cover the
 *     window (e.g. the sandbox account on dev).
 * Neither covering ≥ MIN_COVERAGE → available:false with the reason; never $0.
 *
 * Rejects: L1/L2_Carton_Count_Infeed − L1/L2_Carton_Count_Good per lane
 * (same reset handling). L1/L2_Bad_Carton_At_Discharge is a deadbanded pulse
 * in the historian (no usable count). rejectGal = rejects × fill setting — an
 * upper bound, since a carton rejected before filling holds no milk. It is
 * part of the loss, not added to it.
 *
 * Pricing, like the other steps: raw-milk family $/lb (family of the SKU's
 * bulk item on its packaging WorkOrds, else its name) and FG revenue $/lb for
 * that bulk item. Loss pounds are shared across SKUs by their carton gallons.
 *
 * Historian load: one plant day at a time, sequentially (fillerFlowService's
 * reads + four counter and two fill-setting reads per day); each day is cached (10 min for today,
 * 6 h for past days). History starts 2026-08-18T20:40Z.
 */

const RestProvider = require('../historian/providers/restProvider')
const { getFillerFlow } = require('./fillerFlowService')
const { suiteql, nsDate, familyFromName } = require('./fgShipmentService')
const cartonVolumes = require('./fgCartonVolumeService')
const rawMilkPriceService = require('./rawMilkPriceService')
const fgRevenueRateService = require('./fgRevenueRateService')
const surgeParser = require('./surgeTankProductParser')
const itemConfig = require('./mesItemConfig')
const plantTime = require('../utils/plantTime')

const HISTORY_START = new Date('2026-08-18T20:40:00Z')
const LANE_TAGS = ['Filler1.L1_Carton_Count_Good', 'Filler1.L2_Carton_Count_Good']
const INFEED_TAGS = ['Filler1.L1_Carton_Count_Infeed', 'Filler1.L2_Carton_Count_Infeed']
const FILL_TAGS = ['Filler1.L1_Total_Fill_Volume', 'Filler1.L2_Total_Fill_Volume']
const MIN_FILL_ML = 500
const ML_PER_GAL = 3785.411784
const MIN_COVERAGE = 0.95
const HOUR_MS = 3600000
const MAX_DAYS = 62
const NEAREST_MS = 8 * HOUR_MS
const BULK_FG_IDS = surgeParser.PRODUCT_CATALOG.map(p => p.nsId)
const DAY_CACHE_PAST_MS = 6 * HOUR_MS
const DAY_CACHE_TODAY_MS = 10 * 60 * 1000
const _dayCache = new Map()
const _stepCache = new Map()

const num = v => (v != null && v !== '' && !isNaN(Number(v)) ? Number(v) : null)
const round1 = v => Math.round(Number(v || 0) * 10) / 10
const round2 = v => Math.round(Number(v || 0) * 100) / 100

const OTHER_FILLERS = [2, 3, 4, 5, 6].map(filler => ({
  filler, status: 'not-measured',
  reason: filler === 2 ? 'No inlet meter and no live filler tags.' : 'No inlet meter: product flow is not metered into this filler, so its loss cannot be separated from the surge tank figure.',
}))

function unavailable(reason, extra = {}) {
  return { available: false, reason, line: 1, otherFillers: OTHER_FILLERS, ...extra }
}

async function analogSummary(historian, fqn, since, until, resolution) {
  const filter = `FQN eq '${fqn}' and StartDateTime ge ${since.toISOString()} and EndDateTime le ${until.toISOString()}`
  let url = `${historian.baseUrl}/AnalogSummary?$filter=${encodeURIComponent(filter)}&Resolution=${resolution}`
  const rows = []
  while (url && rows.length < 10000) {
    const data = await historian._get(url, { verbose: false })
    rows.push(...(data?.value || []))
    url = data?.['@odata.nextLink'] || null
  }
  return rows
}

/** Hourly rows of a resettable counter → Map(hourStartMs → cartons). */
function counterByHour(rows) {
  const out = new Map()
  let prevLast = null
  let resets = 0
  for (const r of [...rows].sort((a, b) => Date.parse(a.StartDateTime) - Date.parse(b.StartDateTime))) {
    const first = num(r.First), last = num(r.Last)
    if (!(r.Count > 0) || first == null || last == null) continue
    const min = num(r.Minimum), max = num(r.Maximum)
    let n
    if (min != null && max != null && min < first) { n = (max - first) + (last - min); resets++ } else n = Math.max(0, last - first)
    if (prevLast != null) {
      if (first >= prevLast) n += first - prevLast
      else { n += first; resets++ }
    }
    prevLast = last
    const k = Date.parse(r.StartDateTime)
    out.set(k, (out.get(k) || 0) + n)
  }
  return { byHour: out, resets }
}

/**
 * Time-weighted fill setting (mL) per hour from a step-held ProcessValues
 * series; values under MIN_FILL_ML (the stop blip) keep the previous setting.
 * Hours before the first valid value take the first valid value.
 */
function fillByHour(points, since, until) {
  const pts = points.map(p => ({ t: Date.parse(p.DateTime), v: num(p.Value) })).filter(p => p.v != null && p.v >= MIN_FILL_ML).sort((a, b) => a.t - b.t)
  const out = new Map()
  if (!pts.length) return out
  const s0 = since.getTime(), u0 = until.getTime()
  for (let h = Math.floor(s0 / HOUR_MS) * HOUR_MS; h < u0; h += HOUR_MS) {
    const lo = Math.max(h, s0), hi = Math.min(h + HOUR_MS, u0)
    let cur = pts[0].v, wsum = 0, w = 0, t = lo
    for (const p of pts) { if (p.t <= lo) cur = p.v; else break }
    for (const p of pts) {
      if (p.t <= lo) continue
      if (p.t >= hi) break
      wsum += cur * (p.t - t); w += p.t - t; cur = p.v; t = p.t
    }
    wsum += cur * (hi - t); w += hi - t
    if (w > 0) out.set(h, wsum / w)
  }
  return out
}

async function readDay(historian, since, until) {
  const key = `${since.toISOString()}|${until.toISOString()}`
  const hit = _dayCache.get(key)
  const ttl = until.getTime() < Date.now() - HOUR_MS ? DAY_CACHE_PAST_MS : DAY_CACHE_TODAY_MS
  if (hit && Date.now() - hit.at < ttl) return hit.value
  const flow = await getFillerFlow(historian, { filler: 1, since, until, resolution: HOUR_MS })
  let resets = 0
  const lanes = []
  for (let l = 0; l < 2; l++) {
    const good = counterByHour(await analogSummary(historian, LANE_TAGS[l], since, until, HOUR_MS))
    const infeed = counterByHour(await analogSummary(historian, INFEED_TAGS[l], since, until, HOUR_MS))
    const fill = fillByHour(await historian._queryProcessValues(FILL_TAGS[l], since, until, { verbose: false }), since, until)
    resets += good.resets
    lanes.push({ good: good.byHour, infeed: infeed.byHour, fill })
  }
  const hourKeys = [...new Set(lanes.flatMap(x => [...x.good.keys()]))].sort((a, b) => a - b)
  const cartonsByHour = hourKeys.map(t => {
    const good = lanes.map(x => Math.round(x.good.get(t) || 0))
    const infeed = lanes.map(x => Math.round(x.infeed.get(t) || 0))
    const fillMl = lanes.map(x => (x.fill.has(t) ? Math.round(x.fill.get(t) * 10) / 10 : null))
    return { t, n: good[0] + good[1], good, rejects: infeed.map((v, k) => Math.max(0, v - good[k])), fillMl }
  }).filter(h => h.n > 0)
  const value = {
    since: since.toISOString(), until: until.toISOString(),
    runtimeGal: flow.volume.byState.runtime, byState: flow.volume.byState,
    runs: flow.runs.length, runtimeMinutes: flow.runs.reduce((t, r) => t + r.minutes, 0),
    cartonsByHour,
    counterResets: resets, measuredHours: flow.coverage.bucketsMeasured, expectedHours: flow.coverage.bucketsExpected,
  }
  _dayCache.set(key, { at: Date.now(), value })
  return value
}

/** Line-1 pallet completions around the window: [{ at: Date, item, name, cases }]. */
async function linePallets(fromDay, toDayExcl) {
  const rows = await suiteql(`
    SELECT tl.item, BUILTIN.DF(tl.item) AS name, tl.quantity AS cases, TO_CHAR(t.createddate, 'YYYY-MM-DD HH24:MI') AS ts
    FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' AND tl.isinventoryaffecting = 'T'
    JOIN item i ON i.id = tl.item AND i.custitem6 = 1
    WHERE t.type = 'WOCompl' AND t.custbody_woc_line = '1'
      AND t.createddate >= ${nsDate(plantTime.addPlantDays(fromDay, -1))} AND t.createddate < ${nsDate(plantTime.addPlantDays(toDayExcl, 1))}`)
  const { plantLocalToUtc } = require('./plantBalanceService')
  return rows.map(r => ({ at: plantLocalToUtc(r.ts), item: String(r.item), name: r.name, cases: Number(r.cases) || 0 })).sort((a, b) => a.at - b.at)
}

/** SKU → bulk FG item from packaging WorkOrds (for family + revenue rate). */
async function bulkItems(skus, toDay) {
  if (!skus.length) return {}
  const rows = await suiteql(`
    SELECT tl2.item AS sku, tl1.item AS bulk, SUM(tl2.quantity) AS cases
    FROM transactionline tl1 JOIN transaction t ON t.id = tl1.transaction
    JOIN transactionline tl2 ON tl2.transaction = t.id AND tl2.quantity > 0 AND tl2.item != tl1.item
    WHERE t.type = 'WorkOrd' AND tl1.quantity < 0 AND tl1.item IN (${BULK_FG_IDS.join(', ')})
      AND tl2.item IN (${skus.join(', ')}) AND t.trandate >= ${nsDate(plantTime.addPlantDays(toDay, -180))}
    GROUP BY tl2.item, tl1.item`)
  const best = {}
  for (const r of rows) {
    const sku = String(r.sku), cases = Number(r.cases) || 0
    if (!best[sku] || cases > best[sku].cases) best[sku] = { bulk: String(r.bulk), cases }
  }
  return Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.bulk]))
}

/**
 * The Filler 1 step for the half-open UTC window [from, to).
 * `historian` must be a REST-capable provider (baseUrl + _get).
 */
async function getFillerStep({ from, to, historian, prices = {}, rates = {} }) {
  if (!historian || !historian.baseUrl || typeof historian._get !== 'function') {
    return unavailable('The historian provider in use cannot read Filler 1 history (mock provider).')
  }
  const now = new Date()
  const start = new Date(Math.max(from.getTime(), HISTORY_START.getTime()))
  const end = new Date(Math.min(to.getTime(), now.getTime()))
  if (end <= start) return unavailable('The Filler 1 inlet meter has no history for this window (it starts 2026-08-18).')
  const fromDay = plantTime.plantDateString(start)
  const lastDay = plantTime.plantDateString(new Date(end.getTime() - 1))
  const toDayExcl = plantTime.addPlantDays(lastDay, 1)
  const dayCount = Math.round((plantTime.startOfPlantDay(toDayExcl) - plantTime.startOfPlantDay(fromDay)) / 86400000)
  if (dayCount > MAX_DAYS) return unavailable(`Filler 1 loss is computed for windows up to ${MAX_DAYS} days (this one spans ${dayCount}); the historian read would be too slow.`)

  const key = `${start.toISOString()}|${end.toISOString()}|${JSON.stringify(Object.entries(prices).map(([f, p]) => [f, p.pricePerLb]))}|${Object.keys(rates).length}`
  const hit = _stepCache.get(key)
  if (hit && Date.now() - hit.at < DAY_CACHE_TODAY_MS) return hit.value

  let value
  try {
    value = await compute({ from, start, end, fromDay, toDayExcl, historian, prices, rates })
  } catch (err) {
    console.warn(`[FillerLoss] ${String(err.message).slice(0, 200)}`)
    value = unavailable(`Filler 1 data could not be read: ${String(err.message).slice(0, 160)}`)
  }
  _stepCache.set(key, { at: Date.now(), value })
  return value
}

async function compute({ from, start, end, fromDay, toDayExcl, historian, prices, rates }) {
  // 1. Historian, one plant day at a time (sequential — AVEVA concurrency).
  const days = []
  for (let d = fromDay; d < toDayExcl; d = plantTime.addPlantDays(d, 1)) {
    const since = new Date(Math.max(plantTime.startOfPlantDay(d).getTime(), start.getTime()))
    const until = new Date(Math.min(plantTime.startOfPlantDay(plantTime.addPlantDays(d, 1)).getTime(), end.getTime()))
    if (until > since) days.push({ day: d, ...(await readDay(historian, since, until)) })
  }
  const inletGal = days.reduce((t, d) => t + d.runtimeGal, 0)
  const hours = days.flatMap(d => d.cartonsByHour.map(h => ({ ...h, day: d.day })))
  const cartonsTotal = hours.reduce((t, h) => t + h.n, 0)
  if (inletGal <= 0 && cartonsTotal <= 0) return unavailable('Filler 1 did not run in this window.', { from: start.toISOString(), to: end.toISOString() })

  if (cartonsTotal <= 0) {
    return unavailable(`Filler 1 took in ${Math.round(inletGal).toLocaleString('en-US')} gal while running but its good-carton counters recorded nothing.`, { from: start.toISOString(), to: end.toISOString(), inletGal: round1(inletGal) })
  }

  // 2a. Carton volume from the filler's fill setting, per lane per hour.
  const fills = hours.flatMap(h => h.fillMl.map((ml, k) => (ml != null ? { ml, n: h.good[k] } : null)).filter(Boolean))
  const fillCartons = fills.reduce((t, f) => t + f.n, 0)
  const avgFillMl = fillCartons > 0 ? fills.reduce((t, f) => t + f.ml * f.n, 0) / fillCartons : null
  let histGal = 0, histCovered = 0, rejectCartons = 0, rejectGal = 0
  const histPerDay = {}
  for (const h of hours) {
    const pd = (histPerDay[h.day] ||= { cartons: 0, cartonGal: 0 })
    pd.cartons += h.n
    for (let k = 0; k < 2; k++) {
      const ml = h.fillMl[k] ?? h.fillMl[1 - k]   // the other lane's setting when one lane has none
      if (h.rejects[k] > 0) { rejectCartons += h.rejects[k]; rejectGal += h.rejects[k] * ((ml ?? avgFillMl) || 0) / ML_PER_GAL }
      if (!h.good[k]) continue
      if (ml == null) continue
      histGal += h.good[k] * ml / ML_PER_GAL
      pd.cartonGal += h.good[k] * ml / ML_PER_GAL
      histCovered += h.good[k]
    }
  }
  const histCoverage = histCovered / cartonsTotal

  // 2b. Carton volume from the SKU on line 1 (NetSuite pallet completions).
  let pallets = [], names = {}, vols = {}, bulkOf = {}, nsError = null
  try {
    pallets = await linePallets(fromDay, toDayExcl)
    for (const p of pallets) names[p.item] = p.name
    const skus = Object.keys(names)
    ;[vols, bulkOf] = await Promise.all([cartonVolumes.getCartonVolumes(skus, names), bulkItems(skus, plantTime.addPlantDays(toDayExcl, -1))])
  } catch (err) {
    nsError = String(err.message).slice(0, 160)
  }
  const join = { matchedCartons: 0, nearestCartons: 0, mixedCartons: 0, unmatchedCartons: 0, noVolumeCartons: 0 }
  const bySku = {}
  const nsPerDay = {}
  for (const h of hours) {
    let cands = pallets.filter(p => p.at >= h.t && p.at < h.t + 2 * HOUR_MS)
    let how = 'matchedCartons'
    if (!cands.length) {
      let best = null
      for (const p of pallets) {
        const dt = Math.abs(p.at - (h.t + HOUR_MS))
        if (dt <= NEAREST_MS && (!best || dt < best.dt)) best = { p, dt }
      }
      if (best) { cands = [best.p]; how = 'nearestCartons' }
    }
    const pd = (nsPerDay[h.day] ||= { cartons: 0, cartonGal: 0 })
    pd.cartons += h.n
    if (!cands.length) { join.unmatchedCartons += h.n; continue }
    const caseBy = {}
    for (const p of cands) caseBy[p.item] = (caseBy[p.item] || 0) + p.cases
    const withVol = Object.keys(caseBy).filter(i => vols[i] && vols[i].galPerCarton != null)
    if (!withVol.length) { join.noVolumeCartons += h.n; continue }
    if (new Set(withVol.map(i => vols[i].mL)).size > 1) how = 'mixedCartons'
    join[how] += h.n
    const totalCases = withVol.reduce((t, i) => t + caseBy[i], 0) || withVol.length
    for (const i of withVol) {
      const share = totalCases > 0 ? (caseBy[i] || 1) / totalCases : 1 / withVol.length
      const n = h.n * share
      const gal = n * vols[i].galPerCarton
      const sk = (bySku[i] ||= { item: i, name: names[i], mL: vols[i].mL, cartons: 0, cartonGal: 0 })
      sk.cartons += n; sk.cartonGal += gal
      pd.cartonGal += gal
    }
  }
  const nsAssigned = cartonsTotal - join.unmatchedCartons - join.noVolumeCartons
  const nsCoverage = nsAssigned / cartonsTotal
  const nsRawGal = Object.values(bySku).reduce((t, x) => t + x.cartonGal, 0)
  const nsScale = nsAssigned > 0 ? cartonsTotal / nsAssigned : 1
  const nsGal = nsAssigned > 0 ? nsRawGal * nsScale : null

  // 3. Pick the method.
  let method
  if (nsCoverage >= MIN_COVERAGE) method = 'netsuite-pallets'
  else if (histCoverage >= MIN_COVERAGE) method = 'historian-carton-size'
  else {
    return unavailable(`Carton volume is unknown for too many of Filler 1's good cartons: the NetSuite pallet join covers ${round2(nsCoverage * 100)}%${nsError ? ` (${nsError})` : ''} and the filler's fill setting covers ${round2(histCoverage * 100)}% (need ${MIN_COVERAGE * 100}%).`,
      { from: start.toISOString(), to: end.toISOString(), inletGal: round1(inletGal), goodCartons: Math.round(cartonsTotal) })
  }
  const useNs = method === 'netsuite-pallets'
  const histScale = histCovered > 0 ? cartonsTotal / histCovered : 1
  const cartonGal = useNs ? nsGal : histGal * histScale

  const lbsPerGal = itemConfig.LBS_PER_GAL
  const lossGal = inletGal - cartonGal
  const lossLbs = Math.max(0, lossGal) * lbsPerGal

  // 4. Price by the SKU mix NetSuite could see; with the historian method the
  // share of cartons NetSuite could not place stays unpriced.
  let costUsd = 0, revenueUsd = 0, unpricedLbs = 0, unpricedRevenueLbs = 0, anyCost = false, anyRev = false
  const pricedShareBase = useNs ? nsRawGal : (nsRawGal > 0 ? nsRawGal / Math.max(nsCoverage, 1e-9) : 0)
  const skuRows = Object.values(bySku).map(x => {
    const share = pricedShareBase > 0 ? x.cartonGal / pricedShareBase : 0
    const lbs = lossLbs * share
    const bulk = bulkOf[x.item] || null
    const family = (bulk && rawMilkPriceService.familyForBatch(null, bulk)) || familyFromName(x.name)
    const price = prices[family] ? prices[family].pricePerLb : null
    const rev = bulk ? fgRevenueRateService.rateForItem(bulk, rates) : null
    if (price != null) { costUsd += lbs * price; anyCost = true } else unpricedLbs += lbs
    if (rev != null) { revenueUsd += lbs * rev; anyRev = true } else unpricedRevenueLbs += lbs
    return { item: x.item, name: x.name, bulkItem: bulk, family, mL: x.mL, goodCartons: Math.round(x.cartons * (useNs ? nsScale : 1)), goodCartonGal: round1(x.cartonGal * (useNs ? nsScale : 1)),
      shareOfCartonGal: round2(share * 100), lossLbs: round2(lbs), costUsd: price != null ? round2(lbs * price) : null, revenueUsd: rev != null ? round2(lbs * rev) : null,
      pricePerLb: price, revenuePerLb: rev }
  }).sort((a, b) => b.goodCartonGal - a.goodCartonGal)
  const skuLbs = skuRows.reduce((t, r) => t + r.lossLbs, 0)
  if (lossLbs - skuLbs > 0.5) { unpricedLbs += lossLbs - skuLbs; unpricedRevenueLbs += lossLbs - skuLbs }

  const caveats = [
    'Line 1 only. Fillers 2–6 have no inlet meter, so their loss is still inside the surge-tank figure.',
    useNs
      ? 'Carton volume is the labelled fill of the SKU on line 1 (e.g. 1893 mL, 59 oz); overfill is counted as loss.'
      : 'Carton volume from the filler\'s size setting, not the SKU: the per-lane fill volume set on Filler 1 (mL per carton), so overfill above the label is not counted as loss.',
    `${Math.round(rejectCartons).toLocaleString('en-US')} carton(s) were counted at the infeed but not as good (rejects); up to ${Math.round(rejectGal).toLocaleString('en-US')} gal of the loss is in them (less if they were rejected before filling).`,
    'Not added to the report totals: the surge-tank figure already contains milk lost at the fillers.',
  ]
  if (!useNs) caveats.push(`The NetSuite pallet join covered only ${round2(nsCoverage * 100)}% of cartons${nsError ? ` (${nsError})` : ''}; ${round2(Math.max(0, 1 - nsCoverage) * 100)}% of the loss has no product family and is unpriced.`)
  if (from < HISTORY_START) caveats.push(`Filler 1 inlet meter history starts ${HISTORY_START.toISOString().slice(0, 16)}Z; the window before it is not covered.`)
  if (lossGal < 0) caveats.push('Good-carton volume exceeds the metered inlet volume for this window; loss is shown as 0.')
  const uncovered = useNs ? cartonsTotal - nsAssigned : cartonsTotal - histCovered
  if (uncovered > 0) caveats.push(`${Math.round(uncovered).toLocaleString('en-US')} carton(s) (${round2((uncovered / cartonsTotal) * 100)}%) had no carton volume and were given the window's average.`)
  const unknownGal = days.reduce((t, d) => t + (d.byState.unknown || 0), 0)
  if (unknownGal > 50) caveats.push(`${Math.round(unknownGal).toLocaleString('en-US')} gal flowed while Filler 1's state was unknown (historian gaps) and are not counted as milk in.`)
  const histFull = histCovered > 0 ? histGal * histScale : null

  return {
    available: true, line: 1, from: start.toISOString(), to: end.toISOString(),
    definition: `Milk metered into Filler 1 (TR11_FT1140) while the filler was in RunMode, minus good cartons (lane 1 + lane 2 good counters) × ${useNs ? 'the labelled carton volume of the SKU on line 1 at that hour' : 'the fill volume set on each lane at that hour'}.`,
    join: method,
    inletGal: round1(inletGal), inletLbs: round2(inletGal * lbsPerGal),
    goodCartons: Math.round(cartonsTotal), goodCartonGal: round1(cartonGal), goodCartonLbs: round2(cartonGal * lbsPerGal),
    avgGalPerCarton: Math.round((cartonGal / cartonsTotal) * 10000) / 10000,
    avgFillMl: avgFillMl != null ? Math.round(avgFillMl * 10) / 10 : null,
    lossGal: round1(lossGal), lossLbs: round2(lossLbs), lossPct: inletGal > 0 ? round2((Math.max(0, lossGal) / inletGal) * 100) : null,
    rejectCartons: Math.round(rejectCartons), rejectGal: round1(rejectGal),
    costUsd: anyCost ? round2(costUsd) : null, revenueUsd: anyRev ? round2(revenueUsd) : null,
    unpricedLbs: round2(unpricedLbs), unpricedRevenueLbs: round2(unpricedRevenueLbs),
    inletOutsideRunModeGal: { cip: round1(days.reduce((t, d) => t + (d.byState.cip || 0), 0)), idle: round1(days.reduce((t, d) => t + (d.byState.idle || 0), 0)), unknown: round1(unknownGal) },
    runs: days.reduce((t, d) => t + d.runs, 0), runtimeHours: round2(days.reduce((t, d) => t + d.runtimeMinutes, 0) / 60),
    counterResets: days.reduce((t, d) => t + d.counterResets, 0),
    joinStats: {
      ...Object.fromEntries(Object.entries(join).map(([k, v]) => [k, Math.round(v)])),
      netsuiteCoveragePct: round2(nsCoverage * 100), historianCoveragePct: round2(histCoverage * 100), minCoveragePct: MIN_COVERAGE * 100,
      netsuiteError: nsError,
    },
    cartonVolumeCheck: {
      netsuiteGal: nsGal != null ? round1(nsGal) : null, netsuiteCoveragePct: round2(nsCoverage * 100),
      historianGal: histFull != null ? round1(histFull) : null,
      diffPct: nsGal != null && histFull != null && nsGal > 0 ? round2(((histFull - nsGal) / nsGal) * 100) : null,
    },
    bySku: skuRows,
    byDay: days.map(d => {
      const pd = (useNs ? nsPerDay : histPerDay)[d.day] || { cartons: 0, cartonGal: 0 }
      const g = pd.cartonGal * (useNs ? nsScale : histScale)
      const lg = d.runtimeGal - g
      return { day: d.day, inletGal: round1(d.runtimeGal), goodCartons: Math.round(pd.cartons), goodCartonGal: round1(g), lossGal: round1(lg),
        lossPct: d.runtimeGal > 0 ? round2((lg / d.runtimeGal) * 100) : null, historianHours: `${d.measuredHours}/${d.expectedHours}` }
    }),
    otherFillers: OTHER_FILLERS,
    sources: { inlet: RestProvider.TAGS.FILLER1_INLET_FLOW, runMode: RestProvider.TAGS.FILLER1_RUN_MODE, cartons: LANE_TAGS, rejects: INFEED_TAGS, fillSetting: FILL_TAGS,
      sku: 'NetSuite WOCompl, custbody_woc_line = 1 (pallet completion time)', cartonVolume: useNs ? 'Packaging WorkOrd carton component (mL)' : 'Filler1.L1/L2_Total_Fill_Volume (mL per carton)' },
    caveats,
  }
}

function clearCache() { _dayCache.clear(); _stepCache.clear() }

module.exports = { getFillerStep, counterByHour, fillByHour, clearCache, HISTORY_START, OTHER_FILLERS }
