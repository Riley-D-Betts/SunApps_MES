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
 * Carton volume: the SKU on line 1 at that hour, from NetSuite pallet
 * completions (WOCompl with custbody_woc_line = 1; createddate is plant time,
 * ~1 h behind the cartons). An hour takes the SKU of the pallets completed in
 * the two hours after it starts; with none, the nearest line-1 pallet within
 * 8 h. Volume per SKU comes from fgCartonVolumeService (carton component mL ×
 * lb/gal). If more than JOIN_MAX_UNMATCHED of the cartons cannot be given a
 * SKU the step is unavailable with the reason — it never reports $0.
 *
 * Pricing, like the other steps: raw-milk family $/lb (family of the SKU's
 * bulk item on its packaging WorkOrds, else its name) and FG revenue $/lb for
 * that bulk item. Loss pounds are shared across SKUs by their carton gallons.
 *
 * Historian load: one plant day at a time, sequentially (fillerFlowService's
 * reads + two counter reads per day); each day is cached (10 min for today,
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
const HOUR_MS = 3600000
const MAX_DAYS = 62
const JOIN_MAX_UNMATCHED = 0.05
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

async function readDay(historian, since, until) {
  const key = `${since.toISOString()}|${until.toISOString()}`
  const hit = _dayCache.get(key)
  const ttl = until.getTime() < Date.now() - HOUR_MS ? DAY_CACHE_PAST_MS : DAY_CACHE_TODAY_MS
  if (hit && Date.now() - hit.at < ttl) return hit.value
  const flow = await getFillerFlow(historian, { filler: 1, since, until, resolution: HOUR_MS })
  const hours = new Map()
  let resets = 0
  for (const fqn of LANE_TAGS) {
    const c = counterByHour(await analogSummary(historian, fqn, since, until, HOUR_MS))
    resets += c.resets
    for (const [k, n] of c.byHour) hours.set(k, (hours.get(k) || 0) + n)
  }
  const value = {
    since: since.toISOString(), until: until.toISOString(),
    runtimeGal: flow.volume.byState.runtime, byState: flow.volume.byState,
    runs: flow.runs.length, runtimeMinutes: flow.runs.reduce((t, r) => t + r.minutes, 0),
    cartonsByHour: [...hours.entries()].filter(([, n]) => n > 0).map(([t, n]) => ({ t, n: Math.round(n) })),
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

  // 2. SKU per hour from line-1 pallet completions.
  const pallets = await linePallets(fromDay, toDayExcl)
  const names = {}
  for (const p of pallets) names[p.item] = p.name
  const skus = Object.keys(names)
  const [vols, bulkOf] = await Promise.all([cartonVolumes.getCartonVolumes(skus, names), bulkItems(skus, plantTime.addPlantDays(toDayExcl, -1))])

  const join = { matchedCartons: 0, nearestCartons: 0, mixedCartons: 0, unmatchedCartons: 0, noVolumeCartons: 0 }
  const bySku = {}
  const perDay = {}
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
    const pd = (perDay[h.day] ||= { cartons: 0, cartonGal: 0 })
    pd.cartons += h.n
    if (!cands.length) { join.unmatchedCartons += h.n; continue }
    const caseBy = {}
    for (const p of cands) caseBy[p.item] = (caseBy[p.item] || 0) + p.cases
    const items = Object.keys(caseBy)
    const withVol = items.filter(i => vols[i] && vols[i].galPerCarton != null)
    if (!withVol.length) { join.noVolumeCartons += h.n; continue }
    const mls = new Set(withVol.map(i => vols[i].mL))
    if (mls.size > 1) how = 'mixedCartons'
    join[how] += h.n
    const totalCases = withVol.reduce((t, i) => t + caseBy[i], 0) || withVol.length
    for (const i of withVol) {
      const share = totalCases > 0 ? (caseBy[i] || 1) / totalCases : 1 / withVol.length
      const n = h.n * share
      const gal = n * vols[i].galPerCarton
      const s = (bySku[i] ||= { item: i, name: names[i], mL: vols[i].mL, cartons: 0, cartonGal: 0 })
      s.cartons += n; s.cartonGal += gal
      pd.cartonGal += gal
    }
  }
  const unassigned = join.unmatchedCartons + join.noVolumeCartons
  const unassignedShare = cartonsTotal > 0 ? unassigned / cartonsTotal : 0
  const joinOut = { ...Object.fromEntries(Object.entries(join).map(([k, v]) => [k, Math.round(v)])), unassignedPct: round2(unassignedShare * 100), maxUnassignedPct: JOIN_MAX_UNMATCHED * 100 }
  if (cartonsTotal <= 0) {
    return unavailable(`Filler 1 took in ${Math.round(inletGal).toLocaleString('en-US')} gal while running but its good-carton counters recorded nothing.`, { from: start.toISOString(), to: end.toISOString(), inletGal: round1(inletGal), join: joinOut })
  }
  if (unassignedShare > JOIN_MAX_UNMATCHED) {
    return unavailable(`${round2(unassignedShare * 100)}% of Filler 1's good cartons could not be matched to a line-1 pallet completion with a known carton size, so their volume is unknown (limit ${JOIN_MAX_UNMATCHED * 100}%).`,
      { from: start.toISOString(), to: end.toISOString(), inletGal: round1(inletGal), goodCartons: Math.round(cartonsTotal), join: joinOut })
  }

  // Unassigned cartons (≤ limit) take the window's average carton volume.
  let cartonGal = Object.values(bySku).reduce((t, s) => t + s.cartonGal, 0)
  const assigned = cartonsTotal - unassigned
  const avgGalPerCarton = assigned > 0 ? cartonGal / assigned : null
  const scale = assigned > 0 ? cartonsTotal / assigned : 1
  cartonGal *= scale

  const lbsPerGal = itemConfig.LBS_PER_GAL
  const lossGal = inletGal - cartonGal
  const lossLbs = Math.max(0, lossGal) * lbsPerGal

  // 3. Price: share the loss by carton gallons.
  let costUsd = 0, revenueUsd = 0, unpricedLbs = 0, unpricedRevenueLbs = 0, anyCost = false, anyRev = false
  const skuRows = Object.values(bySku).map(s => {
    const gal = s.cartonGal * scale
    const share = cartonGal > 0 ? gal / cartonGal : 0
    const lbs = lossLbs * share
    const bulk = bulkOf[s.item] || null
    const family = (bulk && rawMilkPriceService.familyForBatch(null, bulk)) || familyFromName(s.name)
    const price = prices[family] ? prices[family].pricePerLb : null
    const rev = bulk ? fgRevenueRateService.rateForItem(bulk, rates) : null
    if (price != null) { costUsd += lbs * price; anyCost = true } else unpricedLbs += lbs
    if (rev != null) { revenueUsd += lbs * rev; anyRev = true } else unpricedRevenueLbs += lbs
    return { item: s.item, name: s.name, bulkItem: bulk, family, mL: s.mL, goodCartons: Math.round(s.cartons * scale), goodCartonGal: round1(gal),
      shareOfCartonGal: round2(share * 100), lossLbs: round2(lbs), costUsd: price != null ? round2(lbs * price) : null, revenueUsd: rev != null ? round2(lbs * rev) : null,
      pricePerLb: price, revenuePerLb: rev }
  }).sort((a, b) => b.goodCartonGal - a.goodCartonGal)

  const caveats = [
    'Line 1 only. Fillers 2–6 have no inlet meter, so their loss is still inside the surge-tank figure.',
    'The lane "good" counters matched the master counters on the days checked, so rejected cartons may be counted as good — if so this loss is understated.',
    'Carton volume is the labelled fill (e.g. 1893 mL, 59 oz); overfill is counted as loss.',
    'Not added to the report totals: the surge-tank figure already contains milk lost at the fillers.',
  ]
  if (from < HISTORY_START) caveats.push(`Filler 1 inlet meter history starts ${HISTORY_START.toISOString().slice(0, 16)}Z; the window before it is not covered.`)
  if (lossGal < 0) caveats.push('Good-carton volume exceeds the metered inlet volume for this window; loss is shown as 0.')
  if (unassigned > 0) caveats.push(`${Math.round(unassigned).toLocaleString('en-US')} carton(s) (${round2(unassignedShare * 100)}%) had no matching pallet completion and were given the window's average carton volume.`)
  const unknownGal = days.reduce((t, d) => t + (d.byState.unknown || 0), 0)
  if (unknownGal > 50) caveats.push(`${Math.round(unknownGal).toLocaleString('en-US')} gal flowed while Filler 1's state was unknown (historian gaps) and are not counted as milk in.`)

  return {
    available: true, line: 1, from: start.toISOString(), to: end.toISOString(),
    definition: 'Milk metered into Filler 1 (TR11_FT1140) while the filler was in RunMode, minus good cartons (lane 1 + lane 2 good counters) × the carton volume of the SKU on line 1 at that hour.',
    inletGal: round1(inletGal), inletLbs: round2(inletGal * lbsPerGal),
    goodCartons: Math.round(cartonsTotal), goodCartonGal: round1(cartonGal), goodCartonLbs: round2(cartonGal * lbsPerGal),
    avgGalPerCarton: avgGalPerCarton != null ? Math.round(avgGalPerCarton * 10000) / 10000 : null,
    lossGal: round1(lossGal), lossLbs: round2(lossLbs), lossPct: inletGal > 0 ? round2((Math.max(0, lossGal) / inletGal) * 100) : null,
    costUsd: anyCost ? round2(costUsd) : null, revenueUsd: anyRev ? round2(revenueUsd) : null,
    unpricedLbs: round2(unpricedLbs), unpricedRevenueLbs: round2(unpricedRevenueLbs),
    inletOutsideRunModeGal: { cip: round1(days.reduce((t, d) => t + (d.byState.cip || 0), 0)), idle: round1(days.reduce((t, d) => t + (d.byState.idle || 0), 0)), unknown: round1(unknownGal) },
    runs: days.reduce((t, d) => t + d.runs, 0), runtimeHours: round2(days.reduce((t, d) => t + d.runtimeMinutes, 0) / 60),
    counterResets: days.reduce((t, d) => t + d.counterResets, 0),
    join: joinOut,
    bySku: skuRows,
    byDay: days.map(d => {
      const pd = perDay[d.day] || { cartons: 0, cartonGal: 0 }
      const lg = d.runtimeGal - pd.cartonGal * scale
      return { day: d.day, inletGal: round1(d.runtimeGal), goodCartons: Math.round(pd.cartons), goodCartonGal: round1(pd.cartonGal * scale), lossGal: round1(lg),
        lossPct: d.runtimeGal > 0 ? round2((lg / d.runtimeGal) * 100) : null, historianHours: `${d.measuredHours}/${d.expectedHours}` }
    }),
    otherFillers: OTHER_FILLERS,
    sources: { inlet: RestProvider.TAGS.FILLER1_INLET_FLOW, runMode: RestProvider.TAGS.FILLER1_RUN_MODE, cartons: LANE_TAGS, sku: 'NetSuite WOCompl, custbody_woc_line = 1 (pallet completion time)', cartonVolume: 'Packaging WorkOrd carton component (mL) × lb/gal' },
    caveats,
  }
}

function clearCache() { _dayCache.clear(); _stepCache.clear() }

module.exports = { getFillerStep, counterByHour, clearCache, HISTORY_START, OTHER_FILLERS }
