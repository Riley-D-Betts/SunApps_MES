'use strict'

/**
 * Milk Loss executive report (SD-729).
 *
 * One question, answered in order: how much milk (and money) did we lose,
 * where, on what, and how sure are we. Built from the three closed-batch
 * tables ONLY — never from MesInventoryAdjustments (the sweep↔shortfall loop
 * makes NetSuite's adjustment history meaningless as a shrink signal).
 *
 * Honesty rules (Andrew, 2026-09-14):
 *  - Surge waste = issued − arrived is an UPPER BOUND whenever the tank filled
 *    and drained at once, unless every concurrent tick was metered by the
 *    Filler 1 inlet meter (SD-708). We split every figure into a MEASURED
 *    part and an UPPER-BOUND-ONLY part and never blend them silently:
 *      wasteLbs = wasteMeasuredLbs + wasteUpperBoundLbs   (best estimate)
 *    The measured figure is correct in both MES_METERED_DRAIN regimes: it
 *    uses issued − max(output, outputWithDrainLbs), which is the with-credit
 *    output whether the credit was applied to NS or only shadowed. The max()
 *    guards stale shadow values below output (seen on early dev rows) so the
 *    credit can never make measured loss exceed the upper bound.
 *  - Closed batches with < 100 lb issued are UNACCOUNTED production (item
 *    mis-pin / layer skip), never "zero loss". They are excluded from every
 *    sum and listed under `unaccounted`.
 *  - Families with no price row are reported as UNPRICED lb, not priced at a
 *    global fallback (the analytics page may fall back; an exec number must
 *    not).
 *  - Loss $ is measured TWO ways, as peers (Andrew, 2026-09-14): raw-milk
 *    COST (wasteUsd, per-family $/lb) and forgone finished-goods REVENUE
 *    (lostRevenueUsd, per-item $/lb from packaging + invoices). Both carry
 *    the same measured / upper-bound split. They are never added together.
 *    Separation has no revenue figure (too far upstream, SD-717 rule).
 *  - Pounds are canonical; `units.lbsPerGal` lets the UIs show gallons.
 *
 * Chain: `chain[]` always lists all seven steps of the product path
 * (separation → blend → UHT → surge → fillers → packaging → shipped vs
 * produced) with a status of measured / combined / partial / not-measured,
 * so the report shows where we are blind as clearly as where we lose milk.
 * Each step also carries a `reliability` (see RELIABILITY) and the fillers
 * step is Filler 1 only (fillerLossService, never added to the totals).
 * `plantBalance` (plantBalanceService) is received → cased from NetSuite.
 *
 * Time: every batch is attributed to the plant-local (America/Boise) date it
 * CLOSED (completedAt → createdAt fallback; separation batchEnd). Weeks start
 * Monday. Windows are half-open UTC instants [from, to).
 *
 * Persisted history: rollupDaily() writes the same per-day rows this report
 * computes into MesLossDaily (jobs/lossRollupJob.js, scripts/backfill…), with
 * the $/lb frozen at rollup time. The live report always prices at CURRENT
 * prices so a page's headline and its own trend agree; the long-range trend
 * endpoint (getLossHistory) reads the frozen table.
 */

const { QueryTypes } = require('sequelize')
const db = require('../models')
const config = require('../config')
const rawMilkPriceService = require('./rawMilkPriceService')
const fgRevenueRateService = require('./fgRevenueRateService')
const itemConfig = require('./mesItemConfig')
const plantTime = require('../utils/plantTime')
const fgShipmentService = require('./fgShipmentService')
const fillerLossService = require('./fillerLossService')
const plantBalanceService = require('./plantBalanceService')

const P = config.TABLE_PREFIX
const T = {
  surge: `[${P}MesSurgeTankBatches]`,
  blend: `[${P}MesBlendTankBatches]`,
  sep:   `[${P}MesSeparationBatches]`,
  issue: `[${P}MesSurgeTankIssueStates]`,
  daily: `[${P}MesLossDaily]`,
  inflow: `[${P}MesBlendTankInflows]`,
}

// Windows tz id for America/Boise; DST-correct via AT TIME ZONE (SQL 2016+).
const SQL_TZ = 'Mountain Standard Time'
const MAX_WINDOW_DAYS = 400
const ZERO_ISSUED_LBS = 100          // below this a "completed" batch never really issued
const UNMETERED_INSIGHT_SHARE = 0.25 // upper-bound share of $ that earns a callout
const STAGES = ['separation', 'blend', 'surge', 'shipping']
const STAGE_LABEL = { separation: 'Separation', blend: 'Blend tanks', surge: 'UHT → Surge tanks', shipping: 'Produced → shipped' }

// The whole product path, raw milk to shipped cases (Andrew, 2026-09-14).
// Every step is ALWAYS present in the response so the report tells the full
// story even where we cannot measure yet — an unmeasured step is shown with a
// warning, never as zero loss.
//   measured     — a measured-stage figure exists (may still be partly upper bound)
//   combined     — physically a separate step, but its loss is inside another
//                  step's single measurement (`combinedWith`)
//   not-measured — no loss figure today; `howToMeasure` says what it would take
const CHAIN = [
  { key: 'separation', label: 'Separation', stage: 'separation', status: 'measured',
    what: 'Raw milk fed to the separator minus the cream and skim that came out.' },
  { key: 'blend', label: 'Blend tanks', stage: 'blend', status: 'measured',
    what: 'Milk issued into a blend tank minus what its load cells show arriving. Upper bound when a UHT was pulling from the tank while it filled.' },
  { key: 'uht', label: 'UHT', stage: null, status: 'combined', combinedWith: 'surge',
    what: 'Loss inside the UHT (start-up, divert, product changeover).',
    howToMeasure: 'Measured together with the surge tanks today: we meter milk into the UHT and see it arrive in the surge tank, but nothing meters what leaves the UHT. A UHT outlet meter would split the two.' },
  { key: 'surge', label: 'Surge tanks', stage: 'surge', status: 'measured',
    what: 'Milk metered into the UHT minus what reached the surge tank (plus metered drain to Filler 1). Includes UHT loss.' },
  { key: 'filler', label: 'Fillers', stage: null, status: 'partial',
    what: 'Milk sent to a filler that did not end up in a good carton (start-up, flush, rejects). Line 1 only: metered Filler 1 inlet while running minus good cartons × carton volume.',
    howToMeasure: 'Filler 1 is measured (inlet meter, good-carton counters, carton size of the SKU on line 1). Fillers 2–6 need inlet meters.' },
  { key: 'packaging', label: 'Packaging', stage: null, status: 'not-measured',
    what: 'Good cartons that did not become cases on a pallet (damage, case packer rejects).',
    howToMeasure: 'Compare filler good-carton counts with case-packer and palletizer counts (the historian already has most of these counters).' },
  { key: 'shipping', label: 'Produced → shipped', stage: 'shipping', status: 'measured',
    what: 'Product made in the window, followed to today: pallets destroyed and cases written off are loss; failed pallets awaiting a decision are at risk; the rest has shipped or is still in QC hold or inventory.' },
]

// How far each step's figure can be trusted (Andrew's audits, 2026-09-15).
// Kept here, not in SQL, so a fix that restores a step is a one-line change.
//   reliable   — the figure is a real loss measurement
//   partial    — part real, part artifact / estimate
//   unreliable — known to be mostly measurement artifact (or not measured)
// `sinceConfig` names a config date after which the step becomes reliable.
// headline.reliableLoss* sums the reliable + partial measured stages only.
const RELIABILITY = {
  separation: { level: 'unreliable', sinceConfig: 'LOSS_SEPARATION_RELIABLE_FROM',
    reason: 'Volumes were computed from stale totalizer baselines before the SD-722 fix; batches closed before {since} are not trustworthy.' },
  blend: { level: 'unreliable',
    reason: 'Not trustworthy yet: most fills report 0 and the rest cluster around the tank start-of-fill gap (the load cell reads 0 for the first 1.5–4.5k lb of each fill from empty, ≈2–6 % of a batch). The tank reading is gallons × 8.3 while milk is ≈8.6 lb/gal, and plant engineering reports the tank instruments are set to 8.3 — until a physical check (known water into an empty tank) confirms the tank reading, treat blend loss as measurement, not milk.' },
  uht: { level: 'unreliable',
    reason: 'Inside the surge-tank figure, which surge-tank level readings under-count; matched runs show finished goods at 95 % or more of milk into the UHT.' },
  surge: { level: 'unreliable',
    reason: 'Surge-tank level readings under-count arrival; matched runs show finished goods at 95 % or more of milk into the UHT.' },
  filler: { level: 'partial',
    reason: 'Line 1 only: metered inlet while running against good-carton counts × carton size. Not in the totals; fillers 2–6 are not measured.' },
  packaging: { level: 'unreliable', reason: 'Not measured: no figure for this step.' },
  shipping: { level: 'reliable',
    reason: 'Destroyed pallets and write-offs recorded in NetSuite against product made in the window.' },
}

function parseSinceConfig(v) {
  if (!v) return null
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? plantTime.startOfPlantDay(String(v)) : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** { level, reason, since } for a chain/stage key over a window. */
function reliabilityFor(key, win) {
  const r = RELIABILITY[key]
  if (!r) return null
  if (!r.sinceConfig) return { level: r.level, reason: r.reason, since: null }
  const since = parseSinceConfig(config[r.sinceConfig])
  if (!since) return { level: 'unreliable', reason: r.reason.replace(/; batches closed before \{since\} are not trustworthy\./, `; no fix date is set yet (${r.sinceConfig}), so no window is trustworthy.`), since: null }
  const sinceIso = since.toISOString()
  const sinceDay = plantTime.plantDateString(since)
  if (win.from >= since) return { level: 'reliable', reason: `Batches closed on or after ${sinceDay} use the fixed totalizer baselines.`, since: sinceIso }
  if (win.to <= since) return { level: 'unreliable', reason: r.reason.replace('{since}', sinceDay), since: sinceIso }
  return { level: 'partial', reason: `${r.reason.replace('{since}', sinceDay)} Only batches closed from ${sinceDay} count toward reliable loss.`, since: sinceIso }
}

const num = v => (v == null ? 0 : Number(v))
const round2 = v => Math.round(num(v) * 100) / 100
const localDate = col => `CAST((${col} AT TIME ZONE 'UTC' AT TIME ZONE '${SQL_TZ}') AS date)`
const max0 = expr => `CASE WHEN (${expr}) < 0 THEN 0 ELSE (${expr}) END`

function bucketExpr(groupBy, dateCol) {
  if (groupBy === 'week') return `DATEADD(day, -(DATEDIFF(day, '19000101', ${dateCol}) % 7), ${dateCol})` // Monday start
  if (groupBy === 'month') return `DATEFROMPARTS(YEAR(${dateCol}), MONTH(${dateCol}), 1)`
  return dateCol
}
// Always SELECT buckets as 'YYYY-MM-DD' strings: tedious hands a `date`
// column back through a local-midnight JS Date, which the host's timezone
// then shifts by a day. GROUP BY still uses the raw expression.
const bucketStr = expr => `CONVERT(varchar(10), ${expr}, 23)`

// ── Window parsing ──────────────────────────────────────────────────────────

function truthyParam(v) {
  return v === true || v === 'true' || v === '1' || v === 1
}

function parseWindow({ from, to, groupBy = 'week' } = {}) {
  if (!['day', 'week'].includes(groupBy)) {
    const err = new Error(`groupBy must be day or week (got ${groupBy})`); err.status = 400; throw err
  }
  let fromD, toD
  if (!from && !to) {
    const w = plantTime.lastWholeDays(7)
    fromD = w.from; toD = w.to
  } else {
    fromD = from ? new Date(from) : null
    toD = to ? new Date(to) : new Date()
    if (!fromD || Number.isNaN(fromD.getTime()) || Number.isNaN(toD.getTime())) {
      const err = new Error('from/to must be ISO 8601 dates'); err.status = 400; throw err
    }
    // A bare date ('2026-09-07') means that plant day, not UTC midnight.
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(from))) fromD = plantTime.startOfPlantDay(String(from))
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(to))) toD = plantTime.startOfPlantDay(plantTime.addPlantDays(String(to), 1))
  }
  if (toD <= fromD) { const err = new Error('to must be after from'); err.status = 400; throw err }
  const days = (toD - fromD) / 86400000
  if (days > MAX_WINDOW_DAYS) { const err = new Error(`window exceeds ${MAX_WINDOW_DAYS} days`); err.status = 400; throw err }
  return { from: fromD, to: toD, groupBy, days }
}

// ── Pricing context ─────────────────────────────────────────────────────────

async function pricingContext() {
  const [prices, rates] = await Promise.all([
    rawMilkPriceService.getCurrentPrices(),
    fgRevenueRateService.getCurrentRates(),
  ])
  const ratesAll = fgRevenueRateService.expandRatesWithRawFg(rates)
  return {
    prices,
    rates: ratesAll,
    fgRatesCount: Object.keys(rates).length,
    ratesAsOf: Object.values(prices).reduce((m, p) => (p.effectiveFrom && (!m || p.effectiveFrom > m) ? p.effectiveFrom : m), null),
    // No global fallback for the exec report — see header.
    priceCase: (cols) => rawMilkPriceService.pricePerLbCaseExpr(prices, null, { cols }) || 'NULL',
    familyCase: (cols) => rawMilkPriceService.familyCaseExpr({ cols }),
    // Separation rows carry the HMI product index in itemId, not an NS id.
    priceCaseIdx: (cols) => rawMilkPriceService.pricePerLbCaseExpr(prices, null, { cols: [], indexCols: cols }) || 'NULL',
    familyCaseIdx: (cols) => rawMilkPriceService.familyCaseExpr({ cols: [], indexCols: cols }),
    revCase: (col) => fgRevenueRateService.revenuePerLbCaseExpr(ratesAll, { col }) || 'NULL',
  }
}

// ── Stage queries (one GROUP BY per table) ──────────────────────────────────

function query(sql, replacements) {
  return db.sequelize.query(sql, { type: QueryTypes.SELECT, replacements })
}

async function querySurge({ from, to, groupBy }, ctx) {
  const cols = ['componentItemId', 'mesItem']
  const sql = `
    WITH b AS (
      SELECT ${localDate('COALESCE([completedAt],[createdAt])')} AS localDt,
             [tankId], [feedingUhtId], [productName], [mesItem], [componentItemId],
             CAST([cumulativeIssuedLbs] AS float) AS issued,
             CAST([cumulativeOutputLbs] AS float) AS output,
             CAST([outputWithDrainLbs] AS float) AS outputWD,
             CASE WHEN [concurrentFillDrain] = 0
                    OR ([concurrentTickCount] > 0 AND [meteredDrainTickCount] = [concurrentTickCount] AND [drainFillerLines] = '1')
                  THEN 1 ELSE 0 END AS measurable
      FROM ${T.surge}
      WHERE [status] = 'completed' AND [cumulativeIssuedLbs] >= ${ZERO_ISSUED_LBS}
        AND COALESCE([completedAt],[createdAt]) >= :from AND COALESCE([completedAt],[createdAt]) < :to
    ), c AS (
      SELECT *,
             ${max0('issued - output')} AS wasteUpper,
             CASE WHEN measurable = 1 THEN ${max0('issued - (CASE WHEN outputWD > output THEN outputWD ELSE output END)')} END AS wasteMeasured,
             ${ctx.familyCase(cols)} AS family,
             ${ctx.priceCase(cols)} AS price,
             ${ctx.revCase('mesItem')} AS revRate
      FROM b
    )
    SELECT ${bucketStr(bucketExpr(groupBy, 'localDt'))} AS bucket, [tankId] AS equipment, [feedingUhtId] AS grp, family, [productName], [mesItem], measurable,
           COUNT(*) AS batches, SUM(issued) AS lbsIn,
           SUM(COALESCE(wasteMeasured, wasteUpper)) AS wasteLbs,
           SUM(COALESCE(wasteMeasured, 0)) AS wasteMeasuredLbs,
           SUM(CASE WHEN measurable = 0 THEN wasteUpper ELSE 0 END) AS wasteUpperBoundLbs,
           SUM(CASE WHEN measurable = 0 THEN 1 ELSE 0 END) AS unmeasuredBatches,
           SUM(COALESCE(wasteMeasured, wasteUpper) * price) AS wasteUsd,
           SUM(COALESCE(wasteMeasured, 0) * price) AS wasteMeasuredUsd,
           SUM(CASE WHEN price IS NULL THEN COALESCE(wasteMeasured, wasteUpper) ELSE 0 END) AS unpricedLbs,
           SUM(COALESCE(wasteMeasured, wasteUpper) * revRate) AS lostRevenueUsd,
           SUM(COALESCE(wasteMeasured, 0) * revRate) AS lostRevenueMeasuredUsd,
           SUM(CASE WHEN revRate IS NULL THEN COALESCE(wasteMeasured, wasteUpper) ELSE 0 END) AS unpricedRevenueLbs,
           MAX(price) AS pricePerLb, MAX(revRate) AS revenuePerLb
    FROM c
    GROUP BY ${bucketExpr(groupBy, 'localDt')}, [tankId], [feedingUhtId], family, [productName], [mesItem], measurable
  `
  const rows = await query(sql, { from, to })
  return rows.map(r => ({ stage: 'surge', ...r }))
}

/**
 * Blend fill-while-draining (SD-722): a blend batch is upper bound when a UHT
 * pulled from the tank while it filled — stored per batch as
 * drainedWhileFilling by services/blendDrainCheckService.js from the outlet
 * valve history (null = not checked → treated as measured). Guarded by a
 * one-time column check so the report still runs against a table set that
 * has not booted this version yet.
 */
let _blendDrainColumn = null
async function hasBlendDrainColumn() {
  if (_blendDrainColumn !== null) return _blendDrainColumn
  const [r] = await query(`SELECT COUNT(*) AS n FROM sys.columns WHERE Name = N'drainedWhileFilling' AND Object_ID = Object_ID(N'${P}MesBlendTankBatches')`)
  _blendDrainColumn = num(r && r.n) > 0
  return _blendDrainColumn
}
function blendConcurrencySql(alias, hasColumn) {
  return {
    concurrent: hasColumn ? `CASE WHEN ${alias}.[drainedWhileFilling] = 1 THEN 1 ELSE 0 END` : '0',
    drainMinutes: hasColumn ? `${alias}.[drainOverlapMinutes]` : 'NULL',
  }
}

async function queryBlend({ from, to, groupBy }, ctx) {
  const cols = ['mesItem']
  const cc = blendConcurrencySql('bt', await hasBlendDrainColumn())
  const sql = `
    WITH b AS (
      SELECT ${localDate('COALESCE(bt.[completedAt],bt.[createdAt])')} AS localDt,
             bt.[tankId], bt.[productName], bt.[mesItem],
             CAST(bt.[cumulativeIssuedLbs] AS float) AS issued,
             CAST(bt.[cumulativeOutputLbs] AS float) AS output,
             1 - ${cc.concurrent} AS measurable
      FROM ${T.blend} bt
      WHERE bt.[status] = 'completed' AND bt.[cumulativeIssuedLbs] >= ${ZERO_ISSUED_LBS}
        AND COALESCE(bt.[completedAt],bt.[createdAt]) >= :from AND COALESCE(bt.[completedAt],bt.[createdAt]) < :to
    ), c AS (
      SELECT *, ${max0('issued - output')} AS waste,
             ${ctx.familyCase(cols)} AS family,
             ${ctx.priceCase(cols)} AS price,
             ${ctx.revCase('mesItem')} AS revRate
      FROM b
    )
    SELECT ${bucketStr(bucketExpr(groupBy, 'localDt'))} AS bucket, [tankId] AS equipment, NULL AS grp, family, [productName], [mesItem], measurable,
           COUNT(*) AS batches, SUM(issued) AS lbsIn,
           SUM(waste) AS wasteLbs,
           SUM(CASE WHEN measurable = 1 THEN waste ELSE 0 END) AS wasteMeasuredLbs,
           SUM(CASE WHEN measurable = 0 THEN waste ELSE 0 END) AS wasteUpperBoundLbs,
           SUM(CASE WHEN measurable = 0 THEN 1 ELSE 0 END) AS unmeasuredBatches,
           SUM(waste * price) AS wasteUsd,
           SUM(CASE WHEN measurable = 1 THEN waste * price ELSE 0 END) AS wasteMeasuredUsd,
           SUM(CASE WHEN price IS NULL THEN waste ELSE 0 END) AS unpricedLbs,
           SUM(waste * revRate) AS lostRevenueUsd,
           SUM(CASE WHEN measurable = 1 THEN waste * revRate ELSE 0 END) AS lostRevenueMeasuredUsd,
           SUM(CASE WHEN revRate IS NULL THEN waste ELSE 0 END) AS unpricedRevenueLbs,
           MAX(price) AS pricePerLb, MAX(revRate) AS revenuePerLb
    FROM c
    GROUP BY ${bucketExpr(groupBy, 'localDt')}, [tankId], family, [productName], [mesItem], measurable
  `
  const rows = await query(sql, { from, to })
  return rows.map(r => ({ stage: 'blend', ...r }))
}

async function querySeparation({ from, to, groupBy }, ctx) {
  const cols = ['itemId']
  const sql = `
    WITH b AS (
      SELECT ${localDate('COALESCE([batchEnd],[createdAt])')} AS localDt,
             [sourceSilo], [itemId], [status],
             CAST([inputVolume] AS float) AS feed,
             CAST([wasteVolume] AS float) AS waste
      FROM ${T.sep}
      WHERE [status] IN ('completed', 'error', 'pending_ns') AND [inputVolume] > 0
        AND COALESCE([batchEnd],[createdAt]) >= :from AND COALESCE([batchEnd],[createdAt]) < :to
    ), c AS (
      SELECT *, CASE WHEN [status] = 'pending_ns' THEN 1 ELSE 0 END AS held,
             ${ctx.familyCaseIdx(cols)} AS family,
             ${ctx.priceCaseIdx(cols)} AS price
      FROM b
    )
    SELECT ${bucketStr(bucketExpr(groupBy, 'localDt'))} AS bucket, [sourceSilo] AS equipment, NULL AS grp, family, NULL AS productName, [itemId] AS mesItem, 1 AS measurable,
           SUM(CASE WHEN held = 0 THEN 1 ELSE 0 END) AS batches,
           SUM(CASE WHEN held = 0 THEN feed ELSE 0 END) AS lbsIn,
           SUM(CASE WHEN held = 0 THEN ${max0('waste')} ELSE 0 END) AS wasteLbs,
           SUM(CASE WHEN held = 0 THEN ${max0('waste')} ELSE 0 END) AS wasteMeasuredLbs,
           0 AS wasteUpperBoundLbs, 0 AS unmeasuredBatches,
           SUM(CASE WHEN held = 0 THEN ${max0('waste')} * price END) AS wasteUsd,
           SUM(CASE WHEN held = 0 THEN ${max0('waste')} * price END) AS wasteMeasuredUsd,
           SUM(CASE WHEN held = 0 AND price IS NULL THEN ${max0('waste')} ELSE 0 END) AS unpricedLbs,
           NULL AS lostRevenueUsd, NULL AS lostRevenueMeasuredUsd, 0 AS unpricedRevenueLbs,
           MAX(price) AS pricePerLb, NULL AS revenuePerLb,
           SUM(held) AS heldCount, SUM(CASE WHEN held = 1 THEN feed ELSE 0 END) AS heldLbs,
           SUM(CASE WHEN held = 0 AND waste < 0 THEN 1 ELSE 0 END) AS negativeBalanceCount
    FROM c
    GROUP BY ${bucketExpr(groupBy, 'localDt')}, [sourceSilo], family, [itemId]
  `
  const rows = await query(sql, { from, to })
  return rows.map(r => ({ stage: 'separation', ...r, productName: rawItemName(r.mesItem, r.family) }))
}

function rawItemName(productIndex, family) {
  const item = itemConfig.PRODUCT_INDEX_ITEM_MAP[Number(productIndex)]
  return (item && item.name) || (family ? `Raw milk (${family})` : 'Raw milk')
}

/** All three stages' grouped rows for a window, normalised to numbers and ISO day strings. */
async function computeStages(win, ctx) {
  const [surge, blend, sep] = await Promise.all([querySurge(win, ctx), queryBlend(win, ctx), querySeparation(win, ctx)])
  return [...surge, ...blend, ...sep].map(r => ({
    stage: r.stage,
    // false = every batch in this group has only an upper-bound loss (concurrent
    // fill+drain not fully metered). Used by ignoreUpperBounds and lbsInMeasured.
    measurable: Number(r.measurable) === 1,
    bucket: toDayString(r.bucket),
    equipment: r.equipment || 'unknown',
    group: r.grp || null,
    family: r.family || 'unclassified',
    productName: r.productName || null,
    mesItem: r.mesItem != null ? String(r.mesItem) : null,
    batches: num(r.batches),
    lbsIn: num(r.lbsIn),
    wasteLbs: num(r.wasteLbs),
    wasteMeasuredLbs: num(r.wasteMeasuredLbs),
    wasteUpperBoundLbs: num(r.wasteUpperBoundLbs),
    unmeasuredBatches: num(r.unmeasuredBatches),
    wasteUsd: r.wasteUsd != null ? Number(r.wasteUsd) : null,
    wasteMeasuredUsd: r.wasteMeasuredUsd != null ? Number(r.wasteMeasuredUsd) : null,
    unpricedLbs: num(r.unpricedLbs),
    lostRevenueUsd: r.lostRevenueUsd != null ? Number(r.lostRevenueUsd) : null,
    lostRevenueMeasuredUsd: r.lostRevenueMeasuredUsd != null ? Number(r.lostRevenueMeasuredUsd) : null,
    unpricedRevenueLbs: num(r.unpricedRevenueLbs),
    pricePerLb: r.pricePerLb != null ? Number(r.pricePerLb) : null,
    revenuePerLb: r.revenuePerLb != null ? Number(r.revenuePerLb) : null,
    heldCount: num(r.heldCount),
    heldLbs: num(r.heldLbs),
    negativeBalanceCount: num(r.negativeBalanceCount),
  }))
}

function toDayString(v) {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  return String(v).slice(0, 10)
}

// ── Roll-ups ────────────────────────────────────────────────────────────────

function emptyAgg() {
  return { batches: 0, lbsIn: 0, lbsInMeasured: 0, batchesMeasured: 0, wasteLbs: 0, wasteMeasuredLbs: 0, wasteUpperBoundLbs: 0, unmeasuredBatches: 0,
    wasteUsd: 0, wasteMeasuredUsd: 0, unpricedLbs: 0, lostRevenueUsd: 0, lostRevenueMeasuredUsd: 0, unpricedRevenueLbs: 0, heldCount: 0, heldLbs: 0, negativeBalanceCount: 0 }
}
function addInto(agg, r) {
  agg.batches += r.batches; agg.lbsIn += r.lbsIn
  if (r.measurable) { agg.lbsInMeasured += r.lbsIn; agg.batchesMeasured += r.batches }
  agg.wasteLbs += r.wasteLbs; agg.wasteMeasuredLbs += r.wasteMeasuredLbs; agg.wasteUpperBoundLbs += r.wasteUpperBoundLbs
  agg.unmeasuredBatches += r.unmeasuredBatches
  agg.wasteUsd += num(r.wasteUsd); agg.wasteMeasuredUsd += num(r.wasteMeasuredUsd)
  agg.unpricedLbs += r.unpricedLbs; agg.lostRevenueUsd += num(r.lostRevenueUsd)
  agg.lostRevenueMeasuredUsd += num(r.lostRevenueMeasuredUsd); agg.unpricedRevenueLbs += num(r.unpricedRevenueLbs)
  agg.heldCount += r.heldCount; agg.heldLbs += r.heldLbs; agg.negativeBalanceCount += r.negativeBalanceCount
  return agg
}
function groupRows(rows, keyFn) {
  const map = new Map()
  for (const r of rows) {
    const k = keyFn(r)
    if (!map.has(k)) map.set(k, emptyAgg())
    addInto(map.get(k), r)
  }
  return map
}
function revenueRated(a) {
  return a.wasteLbs > 0 && a.wasteLbs - a.unpricedRevenueLbs > 0.005
}
function confidenceOf(a) {
  if (a.wasteLbs <= 0) return 'measured'
  if (a.wasteUpperBoundLbs <= 0) return 'measured'
  if (a.wasteMeasuredLbs <= 0) return 'upper-bound'
  return 'mixed'
}
function finish(a) {
  return {
    ...a,
    wasteLbs: round2(a.wasteLbs), wasteMeasuredLbs: round2(a.wasteMeasuredLbs), wasteUpperBoundLbs: round2(a.wasteUpperBoundLbs),
    lbsIn: round2(a.lbsIn), unpricedLbs: round2(a.unpricedLbs), heldLbs: round2(a.heldLbs),
    wasteUsd: round2(a.wasteUsd), wasteMeasuredUsd: round2(a.wasteMeasuredUsd),
    wasteUpperBoundUsd: round2(a.wasteUsd - a.wasteMeasuredUsd),
    // Revenue figures are null (not $0) when NONE of the lost pounds had an
    // FG rate — $0 would read as "no loss" where the truth is "unrated".
    lostRevenueUsd: revenueRated(a) ? round2(a.lostRevenueUsd) : null,
    lostRevenueMeasuredUsd: revenueRated(a) ? round2(a.lostRevenueMeasuredUsd) : null,
    lostRevenueUpperBoundUsd: revenueRated(a) ? round2(a.lostRevenueUsd - a.lostRevenueMeasuredUsd) : null,
    unpricedRevenueLbs: round2(a.unpricedRevenueLbs),
    pct: a.lbsIn > 0 ? round2((a.wasteLbs / a.lbsIn) * 100) : null,
    measuredShare: a.wasteLbs > 0 ? round2(a.wasteMeasuredLbs / a.wasteLbs) : 1,
    confidence: confidenceOf(a),
  }
}

/** Monday (plant date) of a 'YYYY-MM-DD' day. */
function mondayOf(day) {
  const [y, m, d] = day.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return plantTime.addPlantDays(day, -((dow + 6) % 7))
}

/** NetSuite write-offs → the same row shape computeStages returns (stage 'shipping'). */
function shippingRows(step, groupBy) {
  if (!step || !step.available) return []
  return step.lossRows.map(r => ({
    stage: 'shipping', measurable: true,
    bucket: groupBy === 'week' ? mondayOf(r.day) : r.day,
    equipment: 'Finished goods', group: null, family: r.family || 'unclassified',
    productName: r.name, mesItem: r.item,
    batches: 0, lbsIn: 0,
    wasteLbs: num(r.lbs), wasteMeasuredLbs: num(r.lbs), wasteUpperBoundLbs: 0, unmeasuredBatches: 0,
    wasteUsd: r.costUsd, wasteMeasuredUsd: r.costUsd,
    unpricedLbs: r.costUsd == null ? num(r.lbs) : 0,
    lostRevenueUsd: r.revenueUsd, lostRevenueMeasuredUsd: r.revenueUsd,
    unpricedRevenueLbs: r.revenueUsd == null ? num(r.lbs) : 0,
    pricePerLb: r.pricePerLb, revenuePerLb: r.revenuePerLb,
    heldCount: 0, heldLbs: 0, negativeBalanceCount: 0,
  }))
}

/** Plant-day span of a half-open UTC window. */
function windowDays(win) {
  return { fromDay: plantTime.plantDateString(win.from), toDay: plantTime.plantDateString(new Date(win.to.getTime() - 1)) }
}

/** The shipped-vs-produced cohort block carried on the chain's shipping step. */
function shippingDetail(step) {
  if (!step) return null
  if (!step.available) return { available: false, error: step.error }
  const { lossRows, ...rest } = step
  return { ...rest, byItem: step.byItem.slice(0, 15) }
}

/** What "Ignore upper bounds" leaves out: batches whose loss is upper-bound only. Always computed. */
function summariseExcluded(rows) {
  const out = rows.filter(r => !r.measurable)
  const a = out.reduce((acc, r) => addInto(acc, r), emptyAgg())
  return {
    batches: a.batches,
    lbsIn: round2(a.lbsIn),
    wasteLbsUpperBound: round2(a.wasteLbs),
    wasteUsdUpperBound: round2(a.wasteUsd),
    lostRevenueUsdUpperBound: round2(a.lostRevenueUsd),
    equipment: [...new Set(out.map(r => r.equipment))].sort(),
  }
}

/**
 * The seven-step product path with a figure where one exists. Figures are
 * copied from the measured stage; combined/unmeasured steps carry nulls and
 * a warning. `shareOfMeasured*` feed the donut (measured steps only).
 */
function fillerFigures(filler) {
  if (!filler || !filler.available) {
    return { warning: 'unavailable', lbsIn: null, wasteLbs: null, wasteLbsMeasured: null, wasteLbsUpperBound: null, pct: null,
      wasteUsd: null, wasteUsdMeasured: null, wasteUsdUpperBound: null, lostRevenueUsd: null, lostRevenueUsdMeasured: null, lostRevenueUsdUpperBound: null,
      batches: null, confidence: null, shareOfMeasuredUsd: null, shareOfMeasuredRevenueUsd: null, shareOfMeasuredLbs: null }
  }
  // Measured, line 1 only; never part of the totals or the donut shares.
  return { warning: 'partial', lbsIn: filler.inletLbs, wasteLbs: filler.lossLbs, wasteLbsMeasured: filler.lossLbs, wasteLbsUpperBound: 0, pct: filler.lossPct,
    wasteUsd: filler.costUsd, wasteUsdMeasured: filler.costUsd, wasteUsdUpperBound: filler.costUsd != null ? 0 : null,
    lostRevenueUsd: filler.revenueUsd, lostRevenueUsdMeasured: filler.revenueUsd, lostRevenueUsdUpperBound: filler.revenueUsd != null ? 0 : null,
    batches: filler.runs, confidence: 'measured', shareOfMeasuredUsd: null, shareOfMeasuredRevenueUsd: null, shareOfMeasuredLbs: null }
}

function buildChain(stages, shipping, filler = null, win = null) {
  const byKey = Object.fromEntries(stages.map(s => [s.key, s]))
  const totalUsd = stages.reduce((t, s) => t + (s.wasteUsd || 0), 0)
  const totalRev = stages.reduce((t, s) => t + (s.lostRevenueUsd || 0), 0)
  const totalLbs = stages.reduce((t, s) => t + (s.wasteLbs || 0), 0)
  return CHAIN.map((c, i) => {
    const s = c.stage ? byKey[c.stage] : null
    const base = {
      key: c.key, order: i + 1, label: c.label, status: c.status,
      combinedWith: c.combinedWith || null,
      measured: c.status === 'measured',
      warning: c.status === 'measured' ? (s && s.confidence !== 'measured' ? 'partly-estimated' : null) : (c.status === 'combined' ? 'combined' : 'not-measured'),
      what: c.what, howToMeasure: c.howToMeasure || null,
      reliability: win ? reliabilityFor(c.key, win) : null,
    }
    if (c.key === 'filler') {
      base.filler = filler || null
      return { ...base, ...fillerFigures(filler) }
    }
    if (c.key === 'shipping') base.shipping = shippingDetail(shipping)
    if (c.key === 'shipping' && (!shipping || !shipping.available)) {
      return { ...base, warning: 'unavailable', lbsIn: null, wasteLbs: null, wasteLbsMeasured: null, wasteLbsUpperBound: null, pct: null,
        wasteUsd: null, wasteUsdMeasured: null, wasteUsdUpperBound: null, lostRevenueUsd: null, lostRevenueUsdMeasured: null, lostRevenueUsdUpperBound: null,
        batches: null, confidence: null, shareOfMeasuredUsd: null, shareOfMeasuredRevenueUsd: null, shareOfMeasuredLbs: null }
    }
    if (!s) {
      return { ...base, lbsIn: null, wasteLbs: null, wasteLbsMeasured: null, wasteLbsUpperBound: null, pct: null,
        wasteUsd: null, wasteUsdMeasured: null, wasteUsdUpperBound: null,
        lostRevenueUsd: null, lostRevenueUsdMeasured: null, lostRevenueUsdUpperBound: null,
        batches: null, confidence: null, shareOfMeasuredUsd: null, shareOfMeasuredRevenueUsd: null, shareOfMeasuredLbs: null }
    }
    return {
      ...base,
      lbsIn: s.lbsIn, wasteLbs: s.wasteLbs, wasteLbsMeasured: s.wasteLbsMeasured, wasteLbsUpperBound: s.wasteLbsUpperBoundOnly,
      pct: c.key === 'shipping' ? (base.shipping && base.shipping.loss ? base.shipping.loss.pctOfProduced : null) : s.pct,
      wasteUsd: s.wasteUsd, wasteUsdMeasured: s.wasteUsdMeasured, wasteUsdUpperBound: s.wasteUsdUpperBound,
      lostRevenueUsd: s.lostRevenueUsd, lostRevenueUsdMeasured: s.lostRevenueUsdMeasured, lostRevenueUsdUpperBound: s.lostRevenueUsdUpperBound,
      batches: s.batches, confidence: s.confidence,
      shareOfMeasuredUsd: totalUsd > 0 ? round2((s.wasteUsd / totalUsd) * 100) : null,
      shareOfMeasuredRevenueUsd: totalRev > 0 && s.lostRevenueUsd != null ? round2((s.lostRevenueUsd / totalRev) * 100) : null,
      shareOfMeasuredLbs: totalLbs > 0 ? round2((s.wasteLbs / totalLbs) * 100) : null,
    }
  })
}

function buildStages(rows) {
  const byStage = groupRows(rows, r => r.stage)
  const total = [...byStage.values()].reduce((s, a) => s + a.wasteUsd, 0)
  const totalRev = [...byStage.values()].reduce((s, a) => s + a.lostRevenueUsd, 0)
  return STAGES.map(key => {
    const a = finish(byStage.get(key) || emptyAgg())
    const rev = key !== 'separation'   // separation is too far upstream for a revenue figure (SD-717 rule)
    return {
      key, label: STAGE_LABEL[key],
      lbsIn: a.lbsIn, wasteLbs: a.wasteLbs, wasteLbsMeasured: a.wasteMeasuredLbs, wasteLbsUpperBoundOnly: a.wasteUpperBoundLbs,
      wasteUsd: a.wasteUsd, wasteUsdMeasured: a.wasteMeasuredUsd, wasteUsdUpperBound: a.wasteUpperBoundUsd,
      unpricedLbs: a.unpricedLbs,
      lostRevenueUsd: rev ? a.lostRevenueUsd : null,
      lostRevenueUsdMeasured: rev ? a.lostRevenueMeasuredUsd : null,
      lostRevenueUsdUpperBound: rev ? a.lostRevenueUpperBoundUsd : null,
      unpricedRevenueLbs: rev ? a.unpricedRevenueLbs : null,
      batches: a.batches, unmeasuredBatches: a.unmeasuredBatches, pct: a.pct,
      pctOfTotalUsd: total > 0 ? round2((a.wasteUsd / total) * 100) : null,
      pctOfTotalRevenueUsd: rev && totalRev > 0 ? round2((a.lostRevenueUsd / totalRev) * 100) : null,
      measuredShare: a.measuredShare, confidence: a.confidence,
    }
  })
}

function buildHeadline(rows, stages) {
  const all = finish(rows.reduce((a, r) => addInto(a, r), emptyAgg()))
  // Denominator: milk through the surge stage (pasteurised product) is the
  // closest thing to "milk processed" until v2 brings received lb from NS.
  const surge = stages.find(s => s.key === 'surge')
  const basis = surge && surge.lbsIn > 0 ? surge : stages.reduce((m, s) => (s.lbsIn > (m ? m.lbsIn : 0) ? s : m), null)
  const lbsProcessed = basis ? basis.lbsIn : 0
  return {
    lossUsd: all.wasteUsd,
    lossUsdMeasured: all.wasteMeasuredUsd,
    lossUsdUpperBound: all.wasteUpperBoundUsd,
    lossLbs: all.wasteLbs,
    lossLbsMeasured: all.wasteMeasuredLbs,
    lossLbsUpperBound: all.wasteUpperBoundLbs,
    lbsProcessed: round2(lbsProcessed),
    lbsProcessedBasis: basis ? basis.key : null,
    lossPct: lbsProcessed > 0 ? round2((all.wasteLbs / lbsProcessed) * 100) : null,
    unpricedLbs: all.unpricedLbs,
    // Second $ basis (Andrew, 2026-09-14): forgone finished-goods revenue on
    // the same lost pounds. Shown as a peer of the raw-milk cost, never added.
    lostRevenueUsd: all.lostRevenueUsd,            // null when nothing in the window had a rate
    lostRevenueUsdMeasured: all.lostRevenueMeasuredUsd,
    lostRevenueUsdUpperBound: all.lostRevenueUpperBoundUsd,
    unpricedRevenueLbs: all.unpricedRevenueLbs,
    measuredShare: all.measuredShare,
    batches: all.batches,
  }
}

function buildByEquipment(rows) {
  const m = groupRows(rows, r => `${r.stage}|${r.equipment}|${r.group || ''}`)
  const out = []
  for (const [k, a] of m) {
    const [stage, equipment, group] = k.split('|')
    const f = finish(a)
    const rev = stage !== 'separation'
    out.push({ stage, equipment, group: group || null, lbsIn: f.lbsIn, wasteLbs: f.wasteLbs, wasteLbsMeasured: f.wasteMeasuredLbs,
      wasteUsd: f.wasteUsd, wasteUsdMeasured: f.wasteMeasuredUsd,
      lostRevenueUsd: rev ? f.lostRevenueUsd : null, lostRevenueUsdMeasured: rev ? f.lostRevenueMeasuredUsd : null,
      pct: f.pct, measuredShare: f.measuredShare, batches: f.batches, confidence: f.confidence })
  }
  return out.sort((x, y) => y.wasteUsd - x.wasteUsd || y.wasteLbs - x.wasteLbs)
}

function buildByFamily(rows, ctx) {
  const m = groupRows(rows, r => r.family)
  const out = []
  for (const [family, a] of m) {
    const f = finish(a)
    const p = ctx.prices[family]
    out.push({ family, lbsIn: f.lbsIn, wasteLbs: f.wasteLbs, wasteLbsMeasured: f.wasteMeasuredLbs, wasteUsd: f.wasteUsd, wasteUsdMeasured: f.wasteMeasuredUsd,
      lostRevenueUsd: f.lostRevenueUsd, lostRevenueUsdMeasured: f.lostRevenueMeasuredUsd,
      pricePerLb: p ? p.pricePerLb : null, priceSource: p ? p.source : 'none', priced: !!p })
  }
  return out.sort((x, y) => y.wasteUsd - x.wasteUsd || y.wasteLbs - x.wasteLbs)
}

function buildByProduct(rows) {
  const m = groupRows(rows, r => `${r.stage}|${r.productName || ''}|${r.mesItem || ''}`)
  const out = []
  for (const [k, a] of m) {
    const [stage, productName, mesItem] = k.split('|')
    const f = finish(a)
    out.push({ stage, productName: productName || null, mesItem: mesItem || null, wasteLbs: f.wasteLbs, wasteUsd: f.wasteUsd, wasteUsdMeasured: f.wasteMeasuredUsd,
      lostRevenueUsd: stage === 'separation' ? null : f.lostRevenueUsd, lostRevenueUsdMeasured: stage === 'separation' ? null : f.lostRevenueMeasuredUsd,
      pct: f.pct, batches: f.batches, measuredShare: f.measuredShare })
  }
  return out.sort((x, y) => y.wasteUsd - x.wasteUsd || y.wasteLbs - x.wasteLbs).slice(0, 10)
}

function buildTrend(rows) {
  const m = groupRows(rows, r => r.bucket)
  const perStage = new Map()
  for (const r of rows) {
    const key = `${r.bucket}|${r.stage}`
    if (!perStage.has(key)) perStage.set(key, emptyAgg())
    addInto(perStage.get(key), r)
  }
  return [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([bucket, a]) => {
    const f = finish(a)
    const stages = {}
    for (const s of STAGES) {
      const sa = perStage.get(`${bucket}|${s}`)
      stages[s] = sa
        ? { wasteUsd: round2(sa.wasteUsd), lostRevenueUsd: s === 'separation' ? null : round2(sa.lostRevenueUsd), wasteLbs: round2(sa.wasteLbs), lbsIn: round2(sa.lbsIn) }
        : { wasteUsd: 0, lostRevenueUsd: s === 'separation' ? null : 0, wasteLbs: 0, lbsIn: 0 }
    }
    const surgeIn = stages.surge.lbsIn
    return { bucket, wasteUsd: f.wasteUsd, wasteUsdMeasured: f.wasteMeasuredUsd,
      lostRevenueUsd: f.lostRevenueUsd, lostRevenueUsdMeasured: f.lostRevenueMeasuredUsd,
      wasteLbs: f.wasteLbs, wasteLbsMeasured: f.wasteMeasuredLbs,
      lbsIn: round2(surgeIn), pct: surgeIn > 0 ? round2((f.wasteLbs / surgeIn) * 100) : null, batches: f.batches, stages, source: 'live' }
  })
}

// ── Top events + unaccounted (per-batch queries) ────────────────────────────

async function queryTopEvents({ from, to }, ctx, { limit = 10, measuredOnly = false } = {}) {
  const bcc = blendConcurrencySql('bt', await hasBlendDrainColumn())
  const surgeCols = ['componentItemId', 'mesItem']
  const sql = `
    SELECT TOP ${limit} * FROM (
      SELECT 'surge' AS kind, [id], COALESCE([completedAt],[createdAt]) AS closeAt, [productName], [tankId] AS equipment, [feedingUhtId] AS grp,
             [nsWorkOrderNumber], [concurrentTickCount] AS cTicks, [meteredDrainTickCount] AS mTicks, [drainFillerLines] AS lines,
             ${ctx.familyCase(surgeCols)} AS family,
             CASE WHEN [concurrentFillDrain] = 0 OR ([concurrentTickCount] > 0 AND [meteredDrainTickCount] = [concurrentTickCount] AND [drainFillerLines] = '1') THEN 1 ELSE 0 END AS measured,
             CAST([cumulativeIssuedLbs] AS float) AS issued,
             CASE WHEN [concurrentFillDrain] = 0 OR ([concurrentTickCount] > 0 AND [meteredDrainTickCount] = [concurrentTickCount] AND [drainFillerLines] = '1')
                  THEN ${max0('CAST([cumulativeIssuedLbs] AS float) - (CASE WHEN CAST([outputWithDrainLbs] AS float) > CAST([cumulativeOutputLbs] AS float) THEN CAST([outputWithDrainLbs] AS float) ELSE CAST([cumulativeOutputLbs] AS float) END)')}
                  ELSE ${max0('CAST([cumulativeIssuedLbs] AS float) - CAST([cumulativeOutputLbs] AS float)')} END AS lbs,
             ${ctx.priceCase(surgeCols)} AS price,
             ${ctx.revCase('mesItem')} AS revRate
      FROM ${T.surge}
      WHERE [status] = 'completed' AND [cumulativeIssuedLbs] >= ${ZERO_ISSUED_LBS}
        AND COALESCE([completedAt],[createdAt]) >= :from AND COALESCE([completedAt],[createdAt]) < :to
      UNION ALL
      SELECT 'blend', bt.[id], COALESCE(bt.[completedAt],bt.[createdAt]), bt.[productName], bt.[tankId], NULL, bt.[nsWorkOrderNumber], NULL, ${bcc.drainMinutes}, NULL,
             ${ctx.familyCase(['mesItem']).replace(/\[mesItem\]/g, 'bt.[mesItem]')}, 1 - ${bcc.concurrent}, CAST(bt.[cumulativeIssuedLbs] AS float),
             ${max0('CAST(bt.[cumulativeIssuedLbs] AS float) - CAST(bt.[cumulativeOutputLbs] AS float)')},
             ${ctx.priceCase(['mesItem']).replace(/\[mesItem\]/g, 'bt.[mesItem]')},
             ${ctx.revCase('mesItem').replace(/\[mesItem\]/g, 'bt.[mesItem]')}
      FROM ${T.blend} bt
      WHERE bt.[status] = 'completed' AND bt.[cumulativeIssuedLbs] >= ${ZERO_ISSUED_LBS}
        AND COALESCE(bt.[completedAt],bt.[createdAt]) >= :from AND COALESCE(bt.[completedAt],bt.[createdAt]) < :to
      UNION ALL
      SELECT 'separation', [id], COALESCE([batchEnd],[createdAt]), CAST([itemId] AS nvarchar(32)), [sourceSilo], NULL, CAST([nsTransactionId] AS nvarchar(64)), NULL, NULL, NULL,
             ${ctx.familyCaseIdx(['itemId'])}, 1, CAST([inputVolume] AS float),
             ${max0('CAST([wasteVolume] AS float)')},
             ${ctx.priceCaseIdx(['itemId'])},
             NULL
      FROM ${T.sep}
      WHERE [status] IN ('completed', 'error') AND [inputVolume] > 0
        AND COALESCE([batchEnd],[createdAt]) >= :from AND COALESCE([batchEnd],[createdAt]) < :to
    ) x
    WHERE lbs > 0 ${measuredOnly ? 'AND measured = 1' : ''}
    ORDER BY lbs * COALESCE(price, 0) DESC, lbs DESC
  `
  const rows = await query(sql, { from, to })
  return rows.map(r => {
    const lbs = round2(r.lbs)
    const usd = r.price != null ? round2(lbs * Number(r.price)) : null
    const revenueUsd = r.revRate != null ? round2(lbs * Number(r.revRate)) : null
    const measured = Number(r.measured) === 1
    const issued = num(r.issued)
    const pct = issued > 0 ? round2((lbs / issued) * 100) : null
    return {
      kind: r.kind,
      id: r.id,
      date: r.closeAt instanceof Date ? r.closeAt.toISOString() : r.closeAt,
      day: plantTime.plantDateString(new Date(r.closeAt)),
      product: r.kind === 'separation' ? rawItemName(r.productName, r.family) : r.productName,
      equipment: r.equipment, group: r.grp || null, family: r.family || 'unclassified',
      issuedLbs: round2(issued), lbs, pct, usd, revenueUsd, priced: r.price != null, revenuePriced: r.revRate != null, measured,
      nsWorkOrderNumber: r.nsWorkOrderNumber || null,
      note: eventNote(r, measured),
    }
  })
}

function eventNote(r, measured) {
  if (r.kind === 'separation') return measured ? 'Measured: feed − cream − skim over the batch' : ''
  if (r.kind === 'blend') {
    return measured
      ? 'Measured: issued − load-cell arrival'
      : `Upper bound: a UHT outlet valve was open${r.mTicks != null ? ` for ${Math.round(Number(r.mTicks))} min` : ''} while this blend tank filled, so the load cell under-counts arrival`
  }
  if (measured) {
    return Number(r.cTicks) > 0
      ? `Measured: Filler 1 drain metered on all ${r.cTicks} concurrent tick(s)`
      : 'Measured: tank did not drain while filling'
  }
  const lines = r.lines ? String(r.lines).split(',').map(s => s.trim()).filter(Boolean) : []
  const which = lines.length ? `line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}` : 'an unmetered line'
  return `Upper bound: tank drained to ${which} while filling (${num(r.mTicks)} of ${num(r.cTicks)} tick(s) metered)`
}

async function countNoFlowBlendBatches({ from, to }) {
  const [r] = await query(`
    SELECT COUNT(*) AS n FROM ${T.blend} b
    WHERE b.[status] = 'completed' AND b.[cumulativeIssuedLbs] < ${ZERO_ISSUED_LBS}
      AND COALESCE(b.[completedAt], b.[createdAt]) >= :from AND COALESCE(b.[completedAt], b.[createdAt]) < :to
      AND (SELECT COALESCE(SUM(fi.[totalLbs]), 0) FROM ${T.inflow} fi WHERE fi.[blendTankBatchId] = b.[id]) < ${ZERO_ISSUED_LBS}`, { from, to })
  return num(r && r.n)
}

// The SD-722 surge breaker columns exist only once a table set has booted this
// version — probe once so the report still runs against older tables.
let _surgeBreakerColumns = null
async function hasSurgeBreakerColumns() {
  if (_surgeBreakerColumns !== null) return _surgeBreakerColumns
  const [r] = await query(`SELECT COUNT(*) AS n FROM sys.columns WHERE Name = N'issueBlockedReason' AND Object_ID = Object_ID(N'${P}MesSurgeTankBatches')`)
  _surgeBreakerColumns = num(r && r.n) > 0
  return _surgeBreakerColumns
}

async function queryUnaccounted({ from, to }, ctx) {
  const breaker = await hasSurgeBreakerColumns()
  const sql = `
    SELECT 'surge' AS kind, s.[id], s.[tankId] AS tank, s.[productName], COALESCE(s.[completedAt], s.[createdAt]) AS closeAt,
           s.[nsWorkOrderNumber], s.[lastIssueError], s.[consecutiveIssueFailures] AS fails, s.[layerSkipReason],
           ${breaker ? 's.[issueBlocked], s.[issueBlockedReason]' : 'CAST(0 AS bit) AS issueBlocked, CAST(NULL AS nvarchar(500)) AS issueBlockedReason'},
           ${ctx.familyCase(['componentItemId', 'mesItem']).replace(/\[(componentItemId|mesItem)\]/g, 's.[$1]')} AS family,
           (SELECT SUM(CASE WHEN i.[lastTotalizerGal] - i.[lastIssuedUhtGal] > 0 THEN i.[lastTotalizerGal] - i.[lastIssuedUhtGal] ELSE 0 END)
              FROM ${T.issue} i WHERE i.[surgeTankBatchId] = s.[id]) AS unIssuedGal
    FROM ${T.surge} s
    WHERE s.[status] = 'completed' AND s.[cumulativeIssuedLbs] < ${ZERO_ISSUED_LBS}
      AND COALESCE(s.[completedAt], s.[createdAt]) >= :from AND COALESCE(s.[completedAt], s.[createdAt]) < :to
    UNION ALL
    SELECT 'blend', b.[id], b.[tankId], b.[productName], COALESCE(b.[completedAt], b.[createdAt]), b.[nsWorkOrderNumber], b.[errorMessage], NULL, NULL, NULL, NULL,
           ${ctx.familyCase(['mesItem']).replace(/\[mesItem\]/g, 'b.[mesItem]')}, NULL
    FROM ${T.blend} b
    WHERE b.[status] = 'completed' AND b.[cumulativeIssuedLbs] < ${ZERO_ISSUED_LBS}
      AND COALESCE(b.[completedAt], b.[createdAt]) >= :from AND COALESCE(b.[completedAt], b.[createdAt]) < :to
      -- A product named on the HMI that never flowed is not missing production (SD-722).
      AND (SELECT COALESCE(SUM(fi.[totalLbs]), 0) FROM ${T.inflow} fi WHERE fi.[blendTankBatchId] = b.[id]) >= ${ZERO_ISSUED_LBS}
    ORDER BY closeAt DESC
  `
  const rows = await query(sql, { from, to })
  return rows.map(r => ({
    kind: r.kind, id: r.id, tank: r.tank, product: r.productName, family: r.family || 'unclassified',
    date: r.closeAt instanceof Date ? r.closeAt.toISOString() : r.closeAt,
    nsWorkOrderNumber: r.nsWorkOrderNumber || null,
    // SD-722: a tripped breaker / rejected pin explains the gap better than the raw layer-skip tag.
    reason: r.issueBlockedReason ? String(r.issueBlockedReason).slice(0, 160)
      : r.layerSkipReason ? `layer skip: ${r.layerSkipReason}` : (r.lastIssueError ? String(r.lastIssueError).slice(0, 160) : 'no issue posted'),
    issueBlocked: !!r.issueBlocked,
    issueFailures: num(r.fails),
    estimatedLbs: r.unIssuedGal != null ? round2(Number(r.unIssuedGal) * itemConfig.LBS_PER_GAL) : null,
  }))
}

// ── Insights (plain sentences an executive can act on) ──────────────────────

const fmtLbs = v => `${Math.round(num(v)).toLocaleString('en-US')} lb`
const fmtUsd = v => `$${Math.round(num(v)).toLocaleString('en-US')}`
const fmtPct = v => (v == null ? 'n/a' : `${round2(v).toFixed(1)}%`)

function buildInsights({ headline, stages, byEquipment, byProduct, byFamily, trend, unaccounted, prior }) {
  const out = []
  if (headline.lossUsd > 0 && headline.lossUsdUpperBound / headline.lossUsd >= UNMETERED_INSIGHT_SHARE) {
    const share = Math.round((headline.lossUsdUpperBound / headline.lossUsd) * 100)
    const mostly = byEquipment.filter(e => e.stage === 'surge' && e.measuredShare < 0.5 && e.wasteLbs > 0).map(e => e.equipment)
    out.push({ kind: 'unmetered-share', usd: headline.lossUsdUpperBound,
      text: `${fmtUsd(headline.lossUsdUpperBound)} (${share}% of the total) is an upper bound, not a measurement: ${mostly.length ? mostly.join(', ') : 'the surge tanks'} drained to the fillers while still filling and the drain was not fully metered. Only Filler 1 (fed by ST81/ST82) has an inlet meter; lines 3 and 4 have none.` })
  }
  const worstEq = byEquipment[0]
  if (worstEq && worstEq.wasteUsd > 0) {
    out.push({ kind: 'worst-equipment', usd: worstEq.wasteUsd,
      text: `${worstEq.equipment}${worstEq.group ? ` (fed by ${worstEq.group})` : ''} lost the most: ${fmtUsd(worstEq.wasteUsd)} on ${fmtLbs(worstEq.wasteLbs)} (${fmtPct(worstEq.pct)} of what it received${worstEq.measuredShare < 1 ? ', partly estimated' : ''}).` })
  }
  const worstProd = byProduct[0]
  if (worstProd && worstProd.wasteUsd > 0) {
    out.push({ kind: 'worst-product', usd: worstProd.wasteUsd,
      text: `${worstProd.productName || 'Unnamed product'} carries the largest loss: ${fmtUsd(worstProd.wasteUsd)} across ${worstProd.batches} batch(es)${worstProd.pct != null ? ` at ${fmtPct(worstProd.pct)}` : ''}.` })
  }
  if (prior && prior.headline && prior.headline.lossUsd > 0 && headline.lossUsd >= 0) {
    const delta = headline.lossUsd - prior.headline.lossUsd
    const pct = round2((delta / prior.headline.lossUsd) * 100)
    out.push({ kind: 'trend-direction', usd: delta,
      text: `Loss ${delta >= 0 ? 'rose' : 'fell'} ${Math.abs(pct).toFixed(0)}% versus the prior period (${fmtUsd(prior.headline.lossUsd)} → ${fmtUsd(headline.lossUsd)}).` })
  } else if (trend.length >= 2) {
    const a = trend[trend.length - 2], b = trend[trend.length - 1]
    if (a.wasteUsd > 0) {
      const pct = round2(((b.wasteUsd - a.wasteUsd) / a.wasteUsd) * 100)
      out.push({ kind: 'trend-direction', usd: b.wasteUsd - a.wasteUsd,
        text: `Latest bucket ${pct >= 0 ? 'up' : 'down'} ${Math.abs(pct).toFixed(0)}% on the one before (${fmtUsd(a.wasteUsd)} → ${fmtUsd(b.wasteUsd)}).` })
    }
  }
  if (unaccounted.zeroIssuedCount > 0) {
    out.push({ kind: 'unaccounted', usd: null,
      text: `${unaccounted.zeroIssuedCount} batch(es) closed with no milk issued to NetSuite${unaccounted.zeroIssuedEstimatedLbs ? ` (~${fmtLbs(unaccounted.zeroIssuedEstimatedLbs)} of production)` : ''} — their loss is unknown and NOT in these totals.` })
  }
  if (unaccounted.separationHeld.count > 0) {
    out.push({ kind: 'held', usd: null,
      text: `${unaccounted.separationHeld.count} separation batch(es) (${fmtLbs(unaccounted.separationHeld.lbs)} of feed) are held for mass-balance review and not counted.` })
  }
  const unpriced = byFamily.filter(f => !f.priced && f.wasteLbs > 0)
  if (unpriced.length) {
    out.push({ kind: 'unpriced', usd: null,
      text: `${unpriced.map(f => `${f.family} (${fmtLbs(f.wasteLbs)})`).join(', ')} ${unpriced.length > 1 ? 'have' : 'has'} no raw-milk price — that loss is in pounds only. Add a price under MES Cost Settings.` })
  }
  return out
}

// ── Reliability roll-up ─────────────────────────────────────────────────────

/**
 * Loss from the steps that can be trusted: reliable + partial stages, using
 * the same (possibly ignoreUpperBounds-filtered) stage figures as the totals.
 * A separation window that straddles LOSS_SEPARATION_RELIABLE_FROM counts only
 * the batches closed from that date. Never changes the existing totals.
 */
async function reliableLoss(stages, win, ctx) {
  let lbs = 0, usd = 0, rev = 0
  const steps = []
  for (const st of stages) {
    const rel = st.reliability
    if (!rel || rel.level === 'unreliable') continue
    if (st.key === 'separation' && rel.level === 'partial' && rel.since) {
      const rows = await querySeparation({ from: new Date(rel.since), to: win.to, groupBy: 'day' }, ctx)
      lbs += rows.reduce((t, r) => t + num(r.wasteLbs), 0)
      usd += rows.reduce((t, r) => t + num(r.wasteUsd), 0)
      steps.push({ key: st.key, level: rel.level, fromSince: rel.since })
      continue
    }
    lbs += num(st.wasteLbs); usd += num(st.wasteUsd); rev += num(st.lostRevenueUsd)
    steps.push({ key: st.key, level: rel.level })
  }
  return { lbs: round2(lbs), usd: round2(usd), rev: round2(rev), steps }
}

/** Lazily-built REST historian for callers without one (digest job, scripts). */
let _defaultHistorian = null
function defaultHistorian() {
  if (config.HISTORIAN_PROVIDER !== 'rest') return null
  if (!_defaultHistorian) _defaultHistorian = require('../historian').createProvider('rest')
  return _defaultHistorian
}

// ── Public: the report ──────────────────────────────────────────────────────

async function getLossReport(params = {}) {
  const win = parseWindow(params)
  // The filler step reads the historian; the route passes the app's provider.
  const historian = params.historian || defaultHistorian()
  const compare = truthyParam(params.compare)
  // "Ignore upper bounds" (Andrew, 2026-09-14): drop every batch whose loss is
  // only an upper bound — its input pounds as well as its loss, so the loss %
  // is measured-over-measured rather than measured-over-everything. What was
  // dropped is always reported in `excluded`.
  const ignoreUpperBounds = truthyParam(params.ignoreUpperBounds)
  const ctx = await pricingContext()

  const len = win.to - win.from
  const priorWin = { from: new Date(win.from.getTime() - len), to: win.from, groupBy: win.groupBy }
  const [mesRows, shipping, priorShipping, filler] = await Promise.all([
    computeStages({ from: win.from, to: win.to, groupBy: win.groupBy }, ctx),
    fgShipmentService.getShippingStep({ ...windowDays(win), prices: ctx.prices }),
    compare ? fgShipmentService.getShippingStep({ ...windowDays(priorWin), prices: ctx.prices }) : Promise.resolve(null),
    fillerLossService.getFillerStep({ from: win.from, to: win.to, historian, prices: ctx.prices, rates: ctx.rates }),
  ])
  const plantBalance = await plantBalanceService.getPlantBalance({ ...windowDays(win), shipping })
  const allRows = [...mesRows, ...shippingRows(shipping, win.groupBy)]
  const excluded = summariseExcluded(allRows)
  const rows = ignoreUpperBounds ? allRows.filter(r => r.measurable) : allRows
  const stages = buildStages(rows)
  for (const st of stages) st.reliability = reliabilityFor(st.key, win)
  const headline = buildHeadline(rows, stages)
  const reliable = await reliableLoss(stages, win, ctx)
  // Loss from reliable + partial steps only (a subset of lossUsd / lossLbs).
  headline.reliableLossUsd = reliable.usd
  headline.reliableLossLbs = reliable.lbs
  headline.reliableLostRevenueUsd = reliable.rev
  headline.reliableLossSteps = reliable.steps
  const byEquipment = buildByEquipment(rows)
  const byFamily = buildByFamily(rows, ctx)
  const byProduct = buildByProduct(rows)
  const trend = buildTrend(rows)

  const [topEvents, zeroIssued, noFlowBlendBatches] = await Promise.all([
    queryTopEvents(win, ctx, { measuredOnly: ignoreUpperBounds }),
    queryUnaccounted(win, ctx),
    countNoFlowBlendBatches(win),
  ])
  const sepAgg = rows.filter(r => r.stage === 'separation').reduce((a, r) => addInto(a, r), emptyAgg())
  const unaccounted = {
    zeroIssuedBatches: zeroIssued,
    zeroIssuedCount: zeroIssued.length,
    // HMI-named blend batches that never received milk — not missing production, just noise.
    noFlowBlendBatches,
    zeroIssuedEstimatedLbs: round2(zeroIssued.reduce((s, z) => s + num(z.estimatedLbs), 0)),
    separationHeld: { count: sepAgg.heldCount, lbs: round2(sepAgg.heldLbs) },
    separationNegativeBalance: { count: sepAgg.negativeBalanceCount },
    unpricedFamilies: byFamily.filter(f => !f.priced && f.wasteLbs > 0).map(f => ({ family: f.family, lbs: f.wasteLbs })),
    // Products with no FG revenue rate (their lb are in the cost figure but not the revenue one).
    unpricedRevenueProducts: byProduct.filter(p => p.stage !== 'separation' && p.wasteLbs > 0 && p.lostRevenueUsd == null).map(p => ({ product: p.productName, stage: p.stage, lbs: p.wasteLbs })),
    unmeteredSurgeTanks: [...new Set(allRows.filter(r => r.stage === 'surge' && !r.measurable).map(r => r.equipment))],
    blendTanksDrainedWhileFilling: [...new Set(allRows.filter(r => r.stage === 'blend' && !r.measurable).map(r => r.equipment))],
  }

  let prior = null
  if (compare) {
    const pw = priorWin
    const prowsAll = [...await computeStages(pw, ctx), ...shippingRows(priorShipping, win.groupBy)]
    const prows = ignoreUpperBounds ? prowsAll.filter(r => r.measurable) : prowsAll
    const pstages = buildStages(prows)
    for (const st of pstages) st.reliability = reliabilityFor(st.key, pw)
    const pheadline = buildHeadline(prows, pstages)
    prior = { period: { from: pw.from.toISOString(), to: pw.to.toISOString() }, headline: pheadline, stages: pstages }
    headline.delta = {
      lossUsd: round2(headline.lossUsd - pheadline.lossUsd),
      lossLbs: round2(headline.lossLbs - pheadline.lossLbs),
      lossPct: headline.lossPct != null && pheadline.lossPct != null ? round2(headline.lossPct - pheadline.lossPct) : null,
      lossUsdPct: pheadline.lossUsd > 0 ? round2(((headline.lossUsd - pheadline.lossUsd) / pheadline.lossUsd) * 100) : null,
      lostRevenueUsd: headline.lostRevenueUsd != null && pheadline.lostRevenueUsd != null ? round2(headline.lostRevenueUsd - pheadline.lostRevenueUsd) : null,
      lostRevenueUsdPct: headline.lostRevenueUsd != null && pheadline.lostRevenueUsd > 0 ? round2(((headline.lostRevenueUsd - pheadline.lostRevenueUsd) / pheadline.lostRevenueUsd) * 100) : null,
    }
  }

  const insights = buildInsights({ headline, stages, byEquipment, byProduct, byFamily, trend, unaccounted, prior })
  if (ignoreUpperBounds && excluded.batches > 0) {
    insights.unshift({ kind: 'upper-bounds-excluded', usd: excluded.wasteUsdUpperBound,
      text: `Upper bounds ignored: ${excluded.batches} batch(es) whose loss could only be estimated are left out — ${fmtLbs(excluded.lbsIn)} of milk in and up to ${fmtUsd(excluded.wasteUsdUpperBound)} (cost) / ${fmtUsd(excluded.lostRevenueUsdUpperBound)} (revenue) of loss. Every figure on this page is measured.` })
  }
  const chain = buildChain(stages, shipping, filler, win)
  if (headline.lossLbs > 0) {
    const unreliable = stages.filter(x => x.reliability && x.reliability.level === 'unreliable' && x.wasteLbs > 0).map(x => x.label)
    const share = headline.lossUsd > 0 ? Math.round((headline.reliableLossUsd / headline.lossUsd) * 100) : null
    const trusted = reliable.steps.map(x => `${STAGE_LABEL[x.key]}${x.level === 'partial' ? ' (partly)' : ''}`)
    insights.unshift({ kind: 'reliable-loss', usd: headline.reliableLossUsd,
      text: `Of the ${fmtUsd(headline.lossUsd)} total, ${fmtUsd(headline.reliableLossUsd)}${share != null ? ` (${share}%)` : ''} and ${fmtLbs(headline.reliableLossLbs)} come from steps whose figures can be trusted${trusted.length ? `: ${trusted.join(', ')}` : ''}.${unreliable.length ? ` ${unreliable.join(' and ')} ${unreliable.length > 1 ? 'are' : 'is'} left out because ${unreliable.length > 1 ? 'those figures are' : 'that figure is'} mostly measurement artifact; each step's reliability says why.` : ''}` })
  }
  if (filler && filler.available) {
    const g = v => `${Math.round(v || 0).toLocaleString('en-US')} gal`
    insights.push({ kind: 'filler', usd: filler.costUsd,
      text: `Filler 1 took in ${g(filler.inletGal)} while running and filled ${Math.round(filler.goodCartons).toLocaleString('en-US')} good cartons (${g(filler.goodCartonGal)}): ${g(Math.max(0, filler.lossGal))} (${fmtPct(filler.lossPct)}) never reached a good carton${filler.costUsd != null ? `, ${fmtUsd(filler.costUsd)} of raw milk` : ''}. Not added to the totals (it is already inside the surge-tank figure); fillers 2–6 are not metered.` })
  } else if (filler) {
    insights.push({ kind: 'filler-unavailable', usd: null, text: `Filler 1 loss is not available for this window: ${filler.reason}` })
  }
  if (plantBalance && plantBalance.available) {
    const pb = plantBalance
    insights.push({ kind: 'plant-balance', usd: null,
      text: `Plant balance: ${fmtLbs(pb.received.lbs)} received on trucks${pb.inventory.drawdownLbs ? ` and ${fmtLbs(Math.abs(pb.inventory.drawdownLbs))} ${pb.inventory.drawdownLbs > 0 ? 'drawn down from' : 'added to'} the tanks` : ''}; ${fmtLbs(pb.cased.lbs)} (${fmtPct(pb.cased.pctOfReceived)}) went into cases and ${fmtLbs(pb.bulkShipped.lbs)} shipped in bulk, leaving ${fmtLbs(pb.lostBeforeCasing.lbs)} (${fmtPct(pb.lostBeforeCasing.pctOfReceived)} of receipts) that never reached a case.${pb.receiptsComplete ? '' : ' Receipts are not complete yet, so this can move.'}` })
  }
  if (shipping && shipping.available) {
    const fmtN = v => Math.round(v || 0).toLocaleString('en-US')
    const topReason = shipping.loss.byReason[0]
    insights.push({ kind: 'shipping', usd: shipping.loss.revenueUsd,
      text: `Of the ${fmtN(shipping.producedCases)} cases (${fmtN(shipping.producedPallets)} pallets) produced in this window, ${fmtN(shipping.shippedCases)} have shipped so far (${shipping.shippedPctOfProduced != null ? shipping.shippedPctOfProduced.toFixed(0) : '—'}%); ${fmtN(shipping.loss.cases)} cases were lost (${fmtN(shipping.loss.destroyedPallets)} pallets destroyed${topReason ? `; largest reason: ${topReason.label}` : ''}) and ${fmtN(shipping.atRisk.cases)} more are failed and awaiting a decision.` })
  } else if (shipping && !shipping.available) {
    insights.push({ kind: 'shipping-unavailable', usd: null, text: 'Shipped vs produced could not be loaded from NetSuite for this window; that step is missing from the totals.' })
  }
  const unmeasuredSteps = chain.filter(c => c.status === 'not-measured').map(c => c.label)
  if (unmeasuredSteps.length) {
    insights.push({ kind: 'not-measured', usd: null,
      text: `${unmeasuredSteps.join(' and ')} ${unmeasuredSteps.length > 1 ? 'are' : 'is'} not measured yet, so ${unmeasuredSteps.length > 1 ? 'their' : 'its'} loss is not in these totals. UHT loss is included in the surge-tank figure; fillers are measured on line 1 only.` })
  }

  return {
    period: { from: win.from.toISOString(), to: win.to.toISOString(), days: round2(win.days), groupBy: win.groupBy, tz: plantTime.PLANT_TZ, ignoreUpperBounds },
    excluded,
    prior,
    headline,
    stages,
    chain,
    byEquipment,
    byFamily,
    byProduct,
    topEvents,
    trend,
    unaccounted,
    plantBalance,
    insights,
    pricing: {
      families: Object.fromEntries(Object.entries(ctx.prices).map(([f, p]) => [f, { pricePerLb: p.pricePerLb, source: p.source, effectiveFrom: p.effectiveFrom }])),
      unpricedFamilies: rawMilkPriceService.FAMILIES.filter(f => !ctx.prices[f]),
      fgRatesCount: ctx.fgRatesCount,
      ratesAsOf: ctx.ratesAsOf,
      meteredDrainApplied: config.MES_METERED_DRAIN,
    },
    units: { canonical: 'lb', lbsPerGal: itemConfig.LBS_PER_GAL, note: 'whole/low-fat milk estimate; gallons are display only' },
    generatedAt: new Date().toISOString(),
  }
}

// ── Persisted history: rollup + read ────────────────────────────────────────

/**
 * Recompute MesLossDaily rows for every plant day in [fromDay, toDay]
 * (inclusive 'YYYY-MM-DD' strings). Idempotent: each day is deleted and
 * re-inserted inside one transaction. Prices used are the CURRENT ones —
 * re-running a window deliberately re-prices it.
 */
/**
 * Re-roll ONLY the shipping stage over a longer lookback: product made weeks
 * ago can still be destroyed or written off, and its loss is attributed to its
 * production day.
 */
async function rollupShipping({ fromDay, toDay }) {
  const ctx = await pricingContext()
  const step = await fgShipmentService.getShippingStep({ fromDay, toDay, prices: ctx.prices })
  if (!step.available) return { fromDay, toDay, rows: 0, shipping: 'unavailable (existing rows kept)' }
  const keyed = new Map()
  for (const r of shippingRows(step, 'day')) {
    const k = `${r.bucket}|${r.family}`
    if (!keyed.has(k)) keyed.set(k, { day: r.bucket, family: r.family, pricePerLb: r.pricePerLb, agg: emptyAgg() })
    addInto(keyed.get(k).agg, r)
  }
  const computedAt = new Date()
  const records = [...keyed.values()].map(k => ({
    day: k.day, stage: 'shipping', equipment: 'Finished goods', equipmentGroup: null, family: k.family,
    lbsIn: 0, lbsInMeasured: 0, wasteLbs: round2(k.agg.wasteLbs), wasteMeasuredLbs: round2(k.agg.wasteLbs), wasteUpperBoundLbs: 0,
    wasteUsd: k.agg.wasteUsd ? round2(k.agg.wasteUsd) : null, wasteMeasuredUsd: k.agg.wasteUsd ? round2(k.agg.wasteUsd) : null,
    lostRevenueUsd: k.agg.lostRevenueUsd ? round2(k.agg.lostRevenueUsd) : null, lostRevenueMeasuredUsd: k.agg.lostRevenueUsd ? round2(k.agg.lostRevenueUsd) : null,
    pricePerLb: k.pricePerLb, batchCount: 0, unmeasuredBatchCount: 0, zeroIssuedCount: 0, heldLbs: 0, computedAt,
  }))
  await db.sequelize.transaction(async (transaction) => {
    await db.MesLossDaily.destroy({ where: { stage: 'shipping', day: { [db.Sequelize.Op.between]: [fromDay, toDay] } }, transaction })
    if (records.length) await db.MesLossDaily.bulkCreate(records, { transaction })
  })
  return { fromDay, toDay, rows: records.length, shipping: 'included', computedAt: computedAt.toISOString() }
}

async function rollupDaily({ fromDay, toDay }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay) || toDay < fromDay) {
    const err = new Error('fromDay/toDay must be YYYY-MM-DD with toDay >= fromDay'); err.status = 400; throw err
  }
  const from = plantTime.startOfPlantDay(fromDay)
  const to = plantTime.startOfPlantDay(plantTime.addPlantDays(toDay, 1))
  const ctx = await pricingContext()
  const [mesRows, shipping] = await Promise.all([
    computeStages({ from, to, groupBy: 'day' }, ctx),
    fgShipmentService.getShippingStep({ fromDay, toDay, prices: ctx.prices }),
  ])
  const rows = [...mesRows, ...shippingRows(shipping, 'day')]
  const zero = await queryUnaccounted({ from, to }, ctx)

  // Collapse products: key = day|stage|equipment|family.
  const keyed = new Map()
  const keyOf = (day, stage, equipment, family) => `${day}|${stage}|${equipment}|${family}`
  for (const r of rows) {
    const k = keyOf(r.bucket, r.stage, r.equipment, r.family)
    if (!keyed.has(k)) keyed.set(k, { day: r.bucket, stage: r.stage, equipment: r.equipment, equipmentGroup: r.group, family: r.family, pricePerLb: r.pricePerLb, zeroIssuedCount: 0, agg: emptyAgg() })
    addInto(keyed.get(k).agg, r)
  }
  for (const z of zero) {
    const localDay = plantTime.plantDateString(new Date(z.date))
    const k = keyOf(localDay, z.kind, z.tank || 'unknown', z.family)
    if (!keyed.has(k)) keyed.set(k, { day: localDay, stage: z.kind, equipment: z.tank || 'unknown', equipmentGroup: null, family: z.family, pricePerLb: null, zeroIssuedCount: 0, agg: emptyAgg() })
    keyed.get(k).zeroIssuedCount += 1
  }
  const computedAt = new Date()
  const records = [...keyed.values()].map(k => ({
    day: k.day, stage: k.stage, equipment: k.equipment, equipmentGroup: k.equipmentGroup || null, family: k.family,
    lbsIn: round2(k.agg.lbsIn), lbsInMeasured: round2(k.agg.lbsInMeasured), wasteLbs: round2(k.agg.wasteLbs), wasteMeasuredLbs: round2(k.agg.wasteMeasuredLbs), wasteUpperBoundLbs: round2(k.agg.wasteUpperBoundLbs),
    wasteUsd: k.pricePerLb != null ? round2(k.agg.wasteUsd) : null,
    wasteMeasuredUsd: k.pricePerLb != null ? round2(k.agg.wasteMeasuredUsd) : null,
    lostRevenueUsd: k.stage === 'separation' || !revenueRated(k.agg) ? null : round2(k.agg.lostRevenueUsd),
    lostRevenueMeasuredUsd: k.stage === 'separation' || !revenueRated(k.agg) ? null : round2(k.agg.lostRevenueMeasuredUsd),
    pricePerLb: k.pricePerLb, batchCount: k.agg.batches, unmeasuredBatchCount: k.agg.unmeasuredBatches,
    zeroIssuedCount: k.zeroIssuedCount, heldLbs: round2(k.agg.heldLbs), computedAt,
  }))

  await db.sequelize.transaction(async (transaction) => {
    // NetSuite down → keep the shipping rows already stored rather than wiping them.
    const where = { day: { [db.Sequelize.Op.between]: [fromDay, toDay] } }
    if (!shipping.available) where.stage = { [db.Sequelize.Op.ne]: 'shipping' }
    await db.MesLossDaily.destroy({ where, transaction })
    if (records.length) await db.MesLossDaily.bulkCreate(records, { transaction })
  })
  const days = new Set(records.map(r => r.day))
  return { fromDay, toDay, rows: records.length, daysWithData: days.size, shipping: shipping.available ? 'included' : 'unavailable (existing rows kept)', computedAt: computedAt.toISOString() }
}

/** Frozen history from MesLossDaily, bucketed by day|week|month and split by stage|equipment|family. */
async function getLossHistory({ from, to, groupBy = 'week', by = 'stage', ignoreUpperBounds: ignoreParam } = {}) {
  const ignoreUpperBounds = truthyParam(ignoreParam)
  if (!['day', 'week', 'month'].includes(groupBy)) { const err = new Error('groupBy must be day, week or month'); err.status = 400; throw err }
  if (!['stage', 'equipment', 'family'].includes(by)) { const err = new Error('by must be stage, equipment or family'); err.status = 400; throw err }
  const fromDay = from ? String(from).slice(0, 10) : plantTime.addPlantDays(plantTime.plantDateString(), -182)
  const toDay = to ? String(to).slice(0, 10) : plantTime.addPlantDays(plantTime.plantDateString(), -1)
  const dim = by === 'stage' ? '[stage]' : by === 'equipment' ? "[stage] + '|' + [equipment]" : '[family]'
  const sql = `
    SELECT ${bucketStr(bucketExpr(groupBy, '[day]'))} AS bucket, ${dim} AS series,
           SUM([lbsIn]) AS lbsIn, SUM([lbsInMeasured]) AS lbsInMeasured, SUM([wasteLbs]) AS wasteLbs, SUM([wasteMeasuredLbs]) AS wasteMeasuredLbs, SUM([wasteUpperBoundLbs]) AS wasteUpperBoundLbs,
           SUM([wasteUsd]) AS wasteUsd, SUM([wasteMeasuredUsd]) AS wasteMeasuredUsd, SUM([lostRevenueUsd]) AS lostRevenueUsd, SUM([lostRevenueMeasuredUsd]) AS lostRevenueMeasuredUsd,
           SUM(CASE WHEN [pricePerLb] IS NULL THEN [wasteLbs] ELSE 0 END) AS unpricedLbs,
           SUM([batchCount]) AS batches, SUM([unmeasuredBatchCount]) AS unmeasuredBatches, SUM([zeroIssuedCount]) AS zeroIssued, SUM([heldLbs]) AS heldLbs,
           MAX([computedAt]) AS computedAt
    FROM ${T.daily}
    WHERE [day] >= :fromDay AND [day] <= :toDay
    GROUP BY ${bucketExpr(groupBy, '[day]')}, ${dim}
    ORDER BY ${bucketExpr(groupBy, '[day]')}, ${dim}
  `
  const rows = await query(sql, { fromDay, toDay })
  // ignoreUpperBounds: measured loss over measured input only. Rows rolled up
  // before lbsInMeasured existed have it NULL → those buckets get pct null.
  const points = rows.map(r => {
    const lbsIn = ignoreUpperBounds ? (r.lbsInMeasured != null ? round2(r.lbsInMeasured) : null) : round2(r.lbsIn)
    const wasteLbs = ignoreUpperBounds ? round2(r.wasteMeasuredLbs) : round2(r.wasteLbs)
    return {
      bucket: toDayString(r.bucket), series: r.series,
      lbsIn, wasteLbs, wasteLbsMeasured: round2(r.wasteMeasuredLbs), wasteLbsUpperBound: ignoreUpperBounds ? 0 : round2(r.wasteUpperBoundLbs),
      wasteUsd: ignoreUpperBounds ? round2(r.wasteMeasuredUsd) : round2(r.wasteUsd), wasteUsdMeasured: round2(r.wasteMeasuredUsd),
      lostRevenueUsd: ignoreUpperBounds ? round2(r.lostRevenueMeasuredUsd) : round2(r.lostRevenueUsd), lostRevenueUsdMeasured: round2(r.lostRevenueMeasuredUsd),
      unpricedLbs: round2(r.unpricedLbs),
      pct: lbsIn > 0 ? round2((wasteLbs / lbsIn) * 100) : null,
      batches: ignoreUpperBounds ? num(r.batches) - num(r.unmeasuredBatches) : num(r.batches),
      unmeasuredBatches: num(r.unmeasuredBatches), zeroIssued: num(r.zeroIssued), heldLbs: round2(r.heldLbs),
      computedAt: r.computedAt instanceof Date ? r.computedAt.toISOString() : r.computedAt,
    }
  })
  // Totals per bucket across series, for the headline line of a chart.
  const totals = new Map()
  for (const p of points) {
    if (!totals.has(p.bucket)) totals.set(p.bucket, { bucket: p.bucket, wasteUsd: 0, wasteUsdMeasured: 0, lostRevenueUsd: 0, lostRevenueUsdMeasured: 0, wasteLbs: 0, wasteLbsMeasured: 0, surgeLbsIn: 0 })
    const t = totals.get(p.bucket)
    t.wasteUsd = round2(t.wasteUsd + p.wasteUsd); t.wasteUsdMeasured = round2(t.wasteUsdMeasured + p.wasteUsdMeasured)
    t.lostRevenueUsd = round2(t.lostRevenueUsd + p.lostRevenueUsd); t.lostRevenueUsdMeasured = round2(t.lostRevenueUsdMeasured + p.lostRevenueUsdMeasured)
    t.wasteLbs = round2(t.wasteLbs + p.wasteLbs); t.wasteLbsMeasured = round2(t.wasteLbsMeasured + p.wasteLbsMeasured)
    if (p.series === 'surge' || String(p.series).startsWith('surge|')) t.surgeLbsIn = round2(t.surgeLbsIn + (p.lbsIn || 0))
  }
  // Every bucket in the range is present, so a daily chart has no collapsed gaps:
  // a bucket with no closed batches and no write-offs is zero loss, marked empty.
  const filled = []
  const startBucket = groupBy === 'week' ? mondayOf(fromDay) : groupBy === 'month' ? `${fromDay.slice(0, 7)}-01` : fromDay
  for (let b = startBucket; b <= toDay; ) {
    const t = totals.get(b)
    filled.push(t ? { ...t, empty: false } : { bucket: b, wasteUsd: 0, wasteUsdMeasured: 0, lostRevenueUsd: 0, lostRevenueUsdMeasured: 0, wasteLbs: 0, wasteLbsMeasured: 0, surgeLbsIn: 0, empty: true })
    if (groupBy === 'day') b = plantTime.addPlantDays(b, 1)
    else if (groupBy === 'week') b = plantTime.addPlantDays(b, 7)
    else { const [y, m] = b.split('-').map(Number); b = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01` }
  }
  return {
    period: { fromDay, toDay, groupBy, by, tz: plantTime.PLANT_TZ, ignoreUpperBounds },
    points,
    totals: filled.map(t => ({ ...t, pct: t.surgeLbsIn > 0 ? round2((t.wasteLbs / t.surgeLbsIn) * 100) : null })),
    units: { canonical: 'lb', lbsPerGal: itemConfig.LBS_PER_GAL },
    source: 'history',
  }
}

module.exports = {
  getLossReport,
  getLossHistory,
  rollupDaily,
  rollupShipping,
  computeStages,
  parseWindow,
  STAGES,
  ZERO_ISSUED_LBS,
  RELIABILITY,
  reliabilityFor,
  _pricingContext: pricingContext,
}
