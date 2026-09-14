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
 *    uses issued − COALESCE(outputWithDrainLbs, output), which is the
 *    with-credit output whether the credit was applied to NS or only shadowed.
 *  - Closed batches with < 100 lb issued are UNACCOUNTED production (item
 *    mis-pin / layer skip), never "zero loss". They are excluded from every
 *    sum and listed under `unaccounted`.
 *  - Families with no price row are reported as UNPRICED lb, not priced at a
 *    global fallback (the analytics page may fall back; an exec number must
 *    not).
 *  - Lost FG revenue is an opportunity figure; it is never added to loss $.
 *  - Pounds are canonical; `units.lbsPerGal` lets the UIs show gallons.
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

const P = config.TABLE_PREFIX
const T = {
  surge: `[${P}MesSurgeTankBatches]`,
  blend: `[${P}MesBlendTankBatches]`,
  sep:   `[${P}MesSeparationBatches]`,
  issue: `[${P}MesSurgeTankIssueStates]`,
  daily: `[${P}MesLossDaily]`,
}

// Windows tz id for America/Boise; DST-correct via AT TIME ZONE (SQL 2016+).
const SQL_TZ = 'Mountain Standard Time'
const MAX_WINDOW_DAYS = 400
const ZERO_ISSUED_LBS = 100          // below this a "completed" batch never really issued
const UNMETERED_INSIGHT_SHARE = 0.25 // upper-bound share of $ that earns a callout
const STAGES = ['separation', 'blend', 'surge']
const STAGE_LABEL = { separation: 'Separation', blend: 'Blend tanks', surge: 'Surge tanks' }

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
             CASE WHEN measurable = 1 THEN ${max0('issued - COALESCE(outputWD, output)')} END AS wasteMeasured,
             ${ctx.familyCase(cols)} AS family,
             ${ctx.priceCase(cols)} AS price,
             ${ctx.revCase('mesItem')} AS revRate
      FROM b
    )
    SELECT ${bucketStr(bucketExpr(groupBy, 'localDt'))} AS bucket, [tankId] AS equipment, [feedingUhtId] AS grp, family, [productName], [mesItem],
           COUNT(*) AS batches, SUM(issued) AS lbsIn,
           SUM(COALESCE(wasteMeasured, wasteUpper)) AS wasteLbs,
           SUM(COALESCE(wasteMeasured, 0)) AS wasteMeasuredLbs,
           SUM(CASE WHEN measurable = 0 THEN wasteUpper ELSE 0 END) AS wasteUpperBoundLbs,
           SUM(CASE WHEN measurable = 0 THEN 1 ELSE 0 END) AS unmeasuredBatches,
           SUM(COALESCE(wasteMeasured, wasteUpper) * price) AS wasteUsd,
           SUM(COALESCE(wasteMeasured, 0) * price) AS wasteMeasuredUsd,
           SUM(CASE WHEN price IS NULL THEN COALESCE(wasteMeasured, wasteUpper) ELSE 0 END) AS unpricedLbs,
           SUM(COALESCE(wasteMeasured, wasteUpper) * revRate) AS lostRevenueUsd,
           MAX(price) AS pricePerLb
    FROM c
    GROUP BY ${bucketExpr(groupBy, 'localDt')}, [tankId], [feedingUhtId], family, [productName], [mesItem]
  `
  const rows = await query(sql, { from, to })
  return rows.map(r => ({ stage: 'surge', ...r }))
}

async function queryBlend({ from, to, groupBy }, ctx) {
  const cols = ['mesItem']
  const sql = `
    WITH b AS (
      SELECT ${localDate('COALESCE([completedAt],[createdAt])')} AS localDt,
             [tankId], [productName], [mesItem],
             CAST([cumulativeIssuedLbs] AS float) AS issued,
             CAST([cumulativeOutputLbs] AS float) AS output
      FROM ${T.blend}
      WHERE [status] = 'completed' AND [cumulativeIssuedLbs] >= ${ZERO_ISSUED_LBS}
        AND COALESCE([completedAt],[createdAt]) >= :from AND COALESCE([completedAt],[createdAt]) < :to
    ), c AS (
      SELECT *, ${max0('issued - output')} AS waste,
             ${ctx.familyCase(cols)} AS family,
             ${ctx.priceCase(cols)} AS price,
             ${ctx.revCase('mesItem')} AS revRate
      FROM b
    )
    SELECT ${bucketStr(bucketExpr(groupBy, 'localDt'))} AS bucket, [tankId] AS equipment, NULL AS grp, family, [productName], [mesItem],
           COUNT(*) AS batches, SUM(issued) AS lbsIn,
           SUM(waste) AS wasteLbs, SUM(waste) AS wasteMeasuredLbs, 0 AS wasteUpperBoundLbs, 0 AS unmeasuredBatches,
           SUM(waste * price) AS wasteUsd, SUM(waste * price) AS wasteMeasuredUsd,
           SUM(CASE WHEN price IS NULL THEN waste ELSE 0 END) AS unpricedLbs,
           SUM(waste * revRate) AS lostRevenueUsd,
           MAX(price) AS pricePerLb
    FROM c
    GROUP BY ${bucketExpr(groupBy, 'localDt')}, [tankId], family, [productName], [mesItem]
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
    SELECT ${bucketStr(bucketExpr(groupBy, 'localDt'))} AS bucket, [sourceSilo] AS equipment, NULL AS grp, family, NULL AS productName, [itemId] AS mesItem,
           SUM(CASE WHEN held = 0 THEN 1 ELSE 0 END) AS batches,
           SUM(CASE WHEN held = 0 THEN feed ELSE 0 END) AS lbsIn,
           SUM(CASE WHEN held = 0 THEN ${max0('waste')} ELSE 0 END) AS wasteLbs,
           SUM(CASE WHEN held = 0 THEN ${max0('waste')} ELSE 0 END) AS wasteMeasuredLbs,
           0 AS wasteUpperBoundLbs, 0 AS unmeasuredBatches,
           SUM(CASE WHEN held = 0 THEN ${max0('waste')} * price END) AS wasteUsd,
           SUM(CASE WHEN held = 0 THEN ${max0('waste')} * price END) AS wasteMeasuredUsd,
           SUM(CASE WHEN held = 0 AND price IS NULL THEN ${max0('waste')} ELSE 0 END) AS unpricedLbs,
           NULL AS lostRevenueUsd,
           MAX(price) AS pricePerLb,
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
    pricePerLb: r.pricePerLb != null ? Number(r.pricePerLb) : null,
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
  return { batches: 0, lbsIn: 0, wasteLbs: 0, wasteMeasuredLbs: 0, wasteUpperBoundLbs: 0, unmeasuredBatches: 0,
    wasteUsd: 0, wasteMeasuredUsd: 0, unpricedLbs: 0, lostRevenueUsd: 0, heldCount: 0, heldLbs: 0, negativeBalanceCount: 0 }
}
function addInto(agg, r) {
  agg.batches += r.batches; agg.lbsIn += r.lbsIn
  agg.wasteLbs += r.wasteLbs; agg.wasteMeasuredLbs += r.wasteMeasuredLbs; agg.wasteUpperBoundLbs += r.wasteUpperBoundLbs
  agg.unmeasuredBatches += r.unmeasuredBatches
  agg.wasteUsd += num(r.wasteUsd); agg.wasteMeasuredUsd += num(r.wasteMeasuredUsd)
  agg.unpricedLbs += r.unpricedLbs; agg.lostRevenueUsd += num(r.lostRevenueUsd)
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
    lostRevenueUsd: round2(a.lostRevenueUsd),
    pct: a.lbsIn > 0 ? round2((a.wasteLbs / a.lbsIn) * 100) : null,
    measuredShare: a.wasteLbs > 0 ? round2(a.wasteMeasuredLbs / a.wasteLbs) : 1,
    confidence: confidenceOf(a),
  }
}

function buildStages(rows) {
  const byStage = groupRows(rows, r => r.stage)
  const total = [...byStage.values()].reduce((s, a) => s + a.wasteUsd, 0)
  return STAGES.map(key => {
    const a = finish(byStage.get(key) || emptyAgg())
    return {
      key, label: STAGE_LABEL[key],
      lbsIn: a.lbsIn, wasteLbs: a.wasteLbs, wasteLbsMeasured: a.wasteMeasuredLbs, wasteLbsUpperBoundOnly: a.wasteUpperBoundLbs,
      wasteUsd: a.wasteUsd, wasteUsdMeasured: a.wasteMeasuredUsd, wasteUsdUpperBound: a.wasteUpperBoundUsd,
      unpricedLbs: a.unpricedLbs, lostRevenueUsd: key === 'separation' ? null : a.lostRevenueUsd,
      batches: a.batches, unmeasuredBatches: a.unmeasuredBatches, pct: a.pct,
      pctOfTotalUsd: total > 0 ? round2((a.wasteUsd / total) * 100) : null,
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
    lostRevenueUsd: all.lostRevenueUsd,
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
    out.push({ stage, equipment, group: group || null, lbsIn: f.lbsIn, wasteLbs: f.wasteLbs, wasteLbsMeasured: f.wasteMeasuredLbs,
      wasteUsd: f.wasteUsd, wasteUsdMeasured: f.wasteMeasuredUsd, pct: f.pct, measuredShare: f.measuredShare, batches: f.batches, confidence: f.confidence })
  }
  return out.sort((x, y) => y.wasteUsd - x.wasteUsd || y.wasteLbs - x.wasteLbs)
}

function buildByFamily(rows, ctx) {
  const m = groupRows(rows, r => r.family)
  const out = []
  for (const [family, a] of m) {
    const f = finish(a)
    const p = ctx.prices[family]
    out.push({ family, lbsIn: f.lbsIn, wasteLbs: f.wasteLbs, wasteLbsMeasured: f.wasteMeasuredLbs, wasteUsd: f.wasteUsd,
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
    out.push({ stage, productName: productName || null, mesItem: mesItem || null, wasteLbs: f.wasteLbs, wasteUsd: f.wasteUsd,
      lostRevenueUsd: stage === 'separation' ? null : f.lostRevenueUsd, pct: f.pct, batches: f.batches, measuredShare: f.measuredShare })
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
      stages[s] = sa ? { wasteUsd: round2(sa.wasteUsd), wasteLbs: round2(sa.wasteLbs), lbsIn: round2(sa.lbsIn) } : { wasteUsd: 0, wasteLbs: 0, lbsIn: 0 }
    }
    const surgeIn = stages.surge.lbsIn
    return { bucket, wasteUsd: f.wasteUsd, wasteUsdMeasured: f.wasteMeasuredUsd, wasteLbs: f.wasteLbs, wasteLbsMeasured: f.wasteMeasuredLbs,
      lbsIn: round2(surgeIn), pct: surgeIn > 0 ? round2((f.wasteLbs / surgeIn) * 100) : null, batches: f.batches, stages, source: 'live' }
  })
}

// ── Top events + unaccounted (per-batch queries) ────────────────────────────

async function queryTopEvents({ from, to }, ctx, limit = 10) {
  const surgeCols = ['componentItemId', 'mesItem']
  const sql = `
    SELECT TOP ${limit} * FROM (
      SELECT 'surge' AS kind, [id], COALESCE([completedAt],[createdAt]) AS closeAt, [productName], [tankId] AS equipment, [feedingUhtId] AS grp,
             [nsWorkOrderNumber], [concurrentTickCount] AS cTicks, [meteredDrainTickCount] AS mTicks, [drainFillerLines] AS lines,
             ${ctx.familyCase(surgeCols)} AS family,
             CASE WHEN [concurrentFillDrain] = 0 OR ([concurrentTickCount] > 0 AND [meteredDrainTickCount] = [concurrentTickCount] AND [drainFillerLines] = '1') THEN 1 ELSE 0 END AS measured,
             CAST([cumulativeIssuedLbs] AS float) AS issued,
             CASE WHEN [concurrentFillDrain] = 0 OR ([concurrentTickCount] > 0 AND [meteredDrainTickCount] = [concurrentTickCount] AND [drainFillerLines] = '1')
                  THEN ${max0('CAST([cumulativeIssuedLbs] AS float) - COALESCE(CAST([outputWithDrainLbs] AS float), CAST([cumulativeOutputLbs] AS float))')}
                  ELSE ${max0('CAST([cumulativeIssuedLbs] AS float) - CAST([cumulativeOutputLbs] AS float)')} END AS lbs,
             ${ctx.priceCase(surgeCols)} AS price
      FROM ${T.surge}
      WHERE [status] = 'completed' AND [cumulativeIssuedLbs] >= ${ZERO_ISSUED_LBS}
        AND COALESCE([completedAt],[createdAt]) >= :from AND COALESCE([completedAt],[createdAt]) < :to
      UNION ALL
      SELECT 'blend', [id], COALESCE([completedAt],[createdAt]), [productName], [tankId], NULL, [nsWorkOrderNumber], NULL, NULL, NULL,
             ${ctx.familyCase(['mesItem'])}, 1, CAST([cumulativeIssuedLbs] AS float),
             ${max0('CAST([cumulativeIssuedLbs] AS float) - CAST([cumulativeOutputLbs] AS float)')},
             ${ctx.priceCase(['mesItem'])}
      FROM ${T.blend}
      WHERE [status] = 'completed' AND [cumulativeIssuedLbs] >= ${ZERO_ISSUED_LBS}
        AND COALESCE([completedAt],[createdAt]) >= :from AND COALESCE([completedAt],[createdAt]) < :to
      UNION ALL
      SELECT 'separation', [id], COALESCE([batchEnd],[createdAt]), CAST([itemId] AS nvarchar(32)), [sourceSilo], NULL, CAST([nsTransactionId] AS nvarchar(64)), NULL, NULL, NULL,
             ${ctx.familyCaseIdx(['itemId'])}, 1, CAST([inputVolume] AS float),
             ${max0('CAST([wasteVolume] AS float)')},
             ${ctx.priceCaseIdx(['itemId'])}
      FROM ${T.sep}
      WHERE [status] IN ('completed', 'error') AND [inputVolume] > 0
        AND COALESCE([batchEnd],[createdAt]) >= :from AND COALESCE([batchEnd],[createdAt]) < :to
    ) x
    WHERE lbs > 0
    ORDER BY lbs * COALESCE(price, 0) DESC, lbs DESC
  `
  const rows = await query(sql, { from, to })
  return rows.map(r => {
    const lbs = round2(r.lbs)
    const usd = r.price != null ? round2(lbs * Number(r.price)) : null
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
      issuedLbs: round2(issued), lbs, pct, usd, priced: r.price != null, measured,
      nsWorkOrderNumber: r.nsWorkOrderNumber || null,
      note: eventNote(r, measured),
    }
  })
}

function eventNote(r, measured) {
  if (r.kind === 'separation') return measured ? 'Measured: feed − cream − skim over the batch' : ''
  if (r.kind === 'blend') return 'Measured: issued − load-cell arrival'
  if (measured) {
    return Number(r.cTicks) > 0
      ? `Measured: Filler 1 drain metered on all ${r.cTicks} concurrent tick(s)`
      : 'Measured: tank did not drain while filling'
  }
  const lines = r.lines ? String(r.lines).split(',').map(s => s.trim()).filter(Boolean) : []
  const which = lines.length ? `line${lines.length > 1 ? 's' : ''} ${lines.join(', ')}` : 'an unmetered line'
  return `Upper bound: tank drained to ${which} while filling (${num(r.mTicks)} of ${num(r.cTicks)} tick(s) metered)`
}

async function queryUnaccounted({ from, to }, ctx) {
  const sql = `
    SELECT 'surge' AS kind, s.[id], s.[tankId] AS tank, s.[productName], COALESCE(s.[completedAt], s.[createdAt]) AS closeAt,
           s.[nsWorkOrderNumber], s.[lastIssueError], s.[consecutiveIssueFailures] AS fails, s.[layerSkipReason],
           ${ctx.familyCase(['componentItemId', 'mesItem']).replace(/\[(componentItemId|mesItem)\]/g, 's.[$1]')} AS family,
           (SELECT SUM(CASE WHEN i.[lastTotalizerGal] - i.[lastIssuedUhtGal] > 0 THEN i.[lastTotalizerGal] - i.[lastIssuedUhtGal] ELSE 0 END)
              FROM ${T.issue} i WHERE i.[surgeTankBatchId] = s.[id]) AS unIssuedGal
    FROM ${T.surge} s
    WHERE s.[status] = 'completed' AND s.[cumulativeIssuedLbs] < ${ZERO_ISSUED_LBS}
      AND COALESCE(s.[completedAt], s.[createdAt]) >= :from AND COALESCE(s.[completedAt], s.[createdAt]) < :to
    UNION ALL
    SELECT 'blend', b.[id], b.[tankId], b.[productName], COALESCE(b.[completedAt], b.[createdAt]), b.[nsWorkOrderNumber], b.[errorMessage], NULL, NULL,
           ${ctx.familyCase(['mesItem']).replace(/\[mesItem\]/g, 'b.[mesItem]')}, NULL
    FROM ${T.blend} b
    WHERE b.[status] = 'completed' AND b.[cumulativeIssuedLbs] < ${ZERO_ISSUED_LBS}
      AND COALESCE(b.[completedAt], b.[createdAt]) >= :from AND COALESCE(b.[completedAt], b.[createdAt]) < :to
    ORDER BY closeAt DESC
  `
  const rows = await query(sql, { from, to })
  return rows.map(r => ({
    kind: r.kind, id: r.id, tank: r.tank, product: r.productName, family: r.family || 'unclassified',
    date: r.closeAt instanceof Date ? r.closeAt.toISOString() : r.closeAt,
    nsWorkOrderNumber: r.nsWorkOrderNumber || null,
    reason: r.layerSkipReason ? `layer skip: ${r.layerSkipReason}` : (r.lastIssueError ? String(r.lastIssueError).slice(0, 160) : 'no issue posted'),
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

// ── Public: the report ──────────────────────────────────────────────────────

async function getLossReport(params = {}) {
  const win = parseWindow(params)
  const compare = params.compare === true || params.compare === 'true' || params.compare === '1'
  const ctx = await pricingContext()

  const rows = await computeStages({ from: win.from, to: win.to, groupBy: win.groupBy }, ctx)
  const stages = buildStages(rows)
  const headline = buildHeadline(rows, stages)
  const byEquipment = buildByEquipment(rows)
  const byFamily = buildByFamily(rows, ctx)
  const byProduct = buildByProduct(rows)
  const trend = buildTrend(rows)

  const [topEvents, zeroIssued] = await Promise.all([
    queryTopEvents(win, ctx),
    queryUnaccounted(win, ctx),
  ])
  const sepAgg = rows.filter(r => r.stage === 'separation').reduce((a, r) => addInto(a, r), emptyAgg())
  const unaccounted = {
    zeroIssuedBatches: zeroIssued,
    zeroIssuedCount: zeroIssued.length,
    zeroIssuedEstimatedLbs: round2(zeroIssued.reduce((s, z) => s + num(z.estimatedLbs), 0)),
    separationHeld: { count: sepAgg.heldCount, lbs: round2(sepAgg.heldLbs) },
    separationNegativeBalance: { count: sepAgg.negativeBalanceCount },
    unpricedFamilies: byFamily.filter(f => !f.priced && f.wasteLbs > 0).map(f => ({ family: f.family, lbs: f.wasteLbs })),
    unmeteredSurgeTanks: byEquipment.filter(e => e.stage === 'surge' && e.measuredShare < 1).map(e => e.equipment),
  }

  let prior = null
  if (compare) {
    const len = win.to - win.from
    const pw = { from: new Date(win.from.getTime() - len), to: win.from, groupBy: win.groupBy }
    const prows = await computeStages(pw, ctx)
    const pstages = buildStages(prows)
    const pheadline = buildHeadline(prows, pstages)
    prior = { period: { from: pw.from.toISOString(), to: pw.to.toISOString() }, headline: pheadline, stages: pstages }
    headline.delta = {
      lossUsd: round2(headline.lossUsd - pheadline.lossUsd),
      lossLbs: round2(headline.lossLbs - pheadline.lossLbs),
      lossPct: headline.lossPct != null && pheadline.lossPct != null ? round2(headline.lossPct - pheadline.lossPct) : null,
      lossUsdPct: pheadline.lossUsd > 0 ? round2(((headline.lossUsd - pheadline.lossUsd) / pheadline.lossUsd) * 100) : null,
    }
  }

  const insights = buildInsights({ headline, stages, byEquipment, byProduct, byFamily, trend, unaccounted, prior })

  return {
    period: { from: win.from.toISOString(), to: win.to.toISOString(), days: round2(win.days), groupBy: win.groupBy, tz: plantTime.PLANT_TZ },
    prior,
    headline,
    stages,
    byEquipment,
    byFamily,
    byProduct,
    topEvents,
    trend,
    unaccounted,
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
async function rollupDaily({ fromDay, toDay }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay) || toDay < fromDay) {
    const err = new Error('fromDay/toDay must be YYYY-MM-DD with toDay >= fromDay'); err.status = 400; throw err
  }
  const from = plantTime.startOfPlantDay(fromDay)
  const to = plantTime.startOfPlantDay(plantTime.addPlantDays(toDay, 1))
  const ctx = await pricingContext()
  const rows = await computeStages({ from, to, groupBy: 'day' }, ctx)
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
    lbsIn: round2(k.agg.lbsIn), wasteLbs: round2(k.agg.wasteLbs), wasteMeasuredLbs: round2(k.agg.wasteMeasuredLbs), wasteUpperBoundLbs: round2(k.agg.wasteUpperBoundLbs),
    wasteUsd: k.pricePerLb != null ? round2(k.agg.wasteUsd) : null,
    wasteMeasuredUsd: k.pricePerLb != null ? round2(k.agg.wasteMeasuredUsd) : null,
    lostRevenueUsd: k.stage === 'separation' ? null : round2(k.agg.lostRevenueUsd),
    pricePerLb: k.pricePerLb, batchCount: k.agg.batches, unmeasuredBatchCount: k.agg.unmeasuredBatches,
    zeroIssuedCount: k.zeroIssuedCount, heldLbs: round2(k.agg.heldLbs), computedAt,
  }))

  await db.sequelize.transaction(async (transaction) => {
    await db.MesLossDaily.destroy({ where: { day: { [db.Sequelize.Op.between]: [fromDay, toDay] } }, transaction })
    if (records.length) await db.MesLossDaily.bulkCreate(records, { transaction })
  })
  const days = new Set(records.map(r => r.day))
  return { fromDay, toDay, rows: records.length, daysWithData: days.size, computedAt: computedAt.toISOString() }
}

/** Frozen history from MesLossDaily, bucketed by day|week|month and split by stage|equipment|family. */
async function getLossHistory({ from, to, groupBy = 'week', by = 'stage' } = {}) {
  if (!['day', 'week', 'month'].includes(groupBy)) { const err = new Error('groupBy must be day, week or month'); err.status = 400; throw err }
  if (!['stage', 'equipment', 'family'].includes(by)) { const err = new Error('by must be stage, equipment or family'); err.status = 400; throw err }
  const fromDay = from ? String(from).slice(0, 10) : plantTime.addPlantDays(plantTime.plantDateString(), -182)
  const toDay = to ? String(to).slice(0, 10) : plantTime.addPlantDays(plantTime.plantDateString(), -1)
  const dim = by === 'stage' ? '[stage]' : by === 'equipment' ? "[stage] + '|' + [equipment]" : '[family]'
  const sql = `
    SELECT ${bucketStr(bucketExpr(groupBy, '[day]'))} AS bucket, ${dim} AS series,
           SUM([lbsIn]) AS lbsIn, SUM([wasteLbs]) AS wasteLbs, SUM([wasteMeasuredLbs]) AS wasteMeasuredLbs, SUM([wasteUpperBoundLbs]) AS wasteUpperBoundLbs,
           SUM([wasteUsd]) AS wasteUsd, SUM([wasteMeasuredUsd]) AS wasteMeasuredUsd, SUM([lostRevenueUsd]) AS lostRevenueUsd,
           SUM(CASE WHEN [pricePerLb] IS NULL THEN [wasteLbs] ELSE 0 END) AS unpricedLbs,
           SUM([batchCount]) AS batches, SUM([unmeasuredBatchCount]) AS unmeasuredBatches, SUM([zeroIssuedCount]) AS zeroIssued, SUM([heldLbs]) AS heldLbs,
           MAX([computedAt]) AS computedAt
    FROM ${T.daily}
    WHERE [day] >= :fromDay AND [day] <= :toDay
    GROUP BY ${bucketExpr(groupBy, '[day]')}, ${dim}
    ORDER BY ${bucketExpr(groupBy, '[day]')}, ${dim}
  `
  const rows = await query(sql, { fromDay, toDay })
  const points = rows.map(r => ({
    bucket: toDayString(r.bucket), series: r.series,
    lbsIn: round2(r.lbsIn), wasteLbs: round2(r.wasteLbs), wasteLbsMeasured: round2(r.wasteMeasuredLbs), wasteLbsUpperBound: round2(r.wasteUpperBoundLbs),
    wasteUsd: round2(r.wasteUsd), wasteUsdMeasured: round2(r.wasteMeasuredUsd), lostRevenueUsd: round2(r.lostRevenueUsd), unpricedLbs: round2(r.unpricedLbs),
    pct: num(r.lbsIn) > 0 ? round2((num(r.wasteLbs) / num(r.lbsIn)) * 100) : null,
    batches: num(r.batches), unmeasuredBatches: num(r.unmeasuredBatches), zeroIssued: num(r.zeroIssued), heldLbs: round2(r.heldLbs),
    computedAt: r.computedAt instanceof Date ? r.computedAt.toISOString() : r.computedAt,
  }))
  // Totals per bucket across series, for the headline line of a chart.
  const totals = new Map()
  for (const p of points) {
    if (!totals.has(p.bucket)) totals.set(p.bucket, { bucket: p.bucket, wasteUsd: 0, wasteUsdMeasured: 0, wasteLbs: 0, wasteLbsMeasured: 0, surgeLbsIn: 0 })
    const t = totals.get(p.bucket)
    t.wasteUsd = round2(t.wasteUsd + p.wasteUsd); t.wasteUsdMeasured = round2(t.wasteUsdMeasured + p.wasteUsdMeasured)
    t.wasteLbs = round2(t.wasteLbs + p.wasteLbs); t.wasteLbsMeasured = round2(t.wasteLbsMeasured + p.wasteLbsMeasured)
    if (p.series === 'surge' || String(p.series).startsWith('surge|')) t.surgeLbsIn = round2(t.surgeLbsIn + p.lbsIn)
  }
  return {
    period: { fromDay, toDay, groupBy, by, tz: plantTime.PLANT_TZ },
    points,
    totals: [...totals.values()].map(t => ({ ...t, pct: t.surgeLbsIn > 0 ? round2((t.wasteLbs / t.surgeLbsIn) * 100) : null })),
    units: { canonical: 'lb', lbsPerGal: itemConfig.LBS_PER_GAL },
    source: 'history',
  }
}

module.exports = {
  getLossReport,
  getLossHistory,
  rollupDaily,
  computeStages,
  parseWindow,
  STAGES,
  ZERO_ISSUED_LBS,
  _pricingContext: pricingContext,
}
