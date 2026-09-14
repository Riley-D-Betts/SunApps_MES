/**
 * Read-only probe of the Milk Loss report (SD-729) against whichever table
 * set ENVIRONMENT selects — the way to see prod-shaped numbers without going
 * through the app (dev tables are thin). Runs lossReportService.getLossReport
 * AND an independent T-SQL cross-check of the surge/blend/separation totals,
 * then exits non-zero if they disagree. Never writes: require('../models')
 * does not sync, and nothing here calls rollupDaily.
 *
 * Usage:  ENVIRONMENT=prod node scripts/probeLossReport.js 2026-09-07 2026-09-14 [--json]
 *         (dates are plant days; `to` is exclusive — the second arg is the
 *          first day NOT included)
 */
const { QueryTypes } = require('sequelize')
const config = require('../config')
const db = require('../models')
const svc = require('../services/lossReportService')
const plantTime = require('../utils/plantTime')

const fromDay = process.argv[2]
const toDayExcl = process.argv[3]
const asJson = process.argv.includes('--json')
if (!fromDay || !toDayExcl) {
  console.error('usage: node scripts/probeLossReport.js <fromDay> <toDayExclusive> [--json]')
  process.exit(2)
}
const P = config.TABLE_PREFIX
const n = v => (v == null ? 0 : Number(v))
const lbs = v => Math.round(n(v)).toLocaleString('en-US')
const usd = v => (v == null ? '—' : `$${Math.round(n(v)).toLocaleString('en-US')}`)

async function main() {
  await config.sequelize.authenticate()
  const from = plantTime.startOfPlantDay(fromDay)
  const to = plantTime.startOfPlantDay(toDayExcl)
  console.log(`Tables ${P}* · window [${from.toISOString()}, ${to.toISOString()})`)

  const t0 = Date.now()
  const rep = await svc.getLossReport({ from: from.toISOString(), to: to.toISOString(), groupBy: 'week', compare: true })
  const ms = Date.now() - t0
  if (asJson) { console.log(JSON.stringify(rep, null, 2)); }

  console.log(`\nHEADLINE (${ms} ms): loss ${usd(rep.headline.lossUsd)} = measured ${usd(rep.headline.lossUsdMeasured)} + upper-bound ${usd(rep.headline.lossUsdUpperBound)}; ${lbs(rep.headline.lossLbs)} lb of ${lbs(rep.headline.lbsProcessed)} lb (${rep.headline.lossPct}%), unpriced ${lbs(rep.headline.unpricedLbs)} lb, lost revenue ${usd(rep.headline.lostRevenueUsd)}`)
  if (rep.prior) console.log(`PRIOR: ${usd(rep.prior.headline.lossUsd)} · delta ${usd(rep.headline.delta.lossUsd)} (${rep.headline.delta.lossUsdPct}%)`)
  console.table(rep.stages.map(s => ({ stage: s.key, batches: s.batches, lbsIn: lbs(s.lbsIn), waste: lbs(s.wasteLbs), measured: lbs(s.wasteLbsMeasured), upper: lbs(s.wasteLbsUpperBoundOnly), pct: s.pct, usd: usd(s.wasteUsd), unpriced: lbs(s.unpricedLbs), conf: s.confidence })))
  console.table(rep.byEquipment.map(e => ({ stage: e.stage, eq: e.equipment, grp: e.group, waste: lbs(e.wasteLbs), usd: usd(e.wasteUsd), pct: e.pct, measured: e.measuredShare })))
  console.table(rep.byFamily.map(f => ({ family: f.family, waste: lbs(f.wasteLbs), usd: usd(f.wasteUsd), price: f.pricePerLb, src: f.priceSource })))
  console.table(rep.topEvents.map(e => ({ kind: e.kind, id: e.id, day: e.day, product: String(e.product || '').slice(0, 26), eq: e.equipment, lbs: lbs(e.lbs), usd: usd(e.usd), meas: e.measured, note: e.note.slice(0, 60) })))
  console.table(rep.trend.map(t => ({ bucket: t.bucket, usd: usd(t.wasteUsd), measUsd: usd(t.wasteUsdMeasured), lbs: lbs(t.wasteLbs), pct: t.pct, batches: t.batches })))
  console.log('UNACCOUNTED:', JSON.stringify({ ...rep.unaccounted, zeroIssuedBatches: rep.unaccounted.zeroIssuedBatches.map(z => `${z.kind}#${z.id} ${z.tank} ${z.product} ~${lbs(z.estimatedLbs)} lb`) }, null, 1))
  console.log('INSIGHTS:'); for (const i of rep.insights) console.log(` - [${i.kind}] ${i.text}`)

  // Independent cross-check, written without the service's helpers. One
  // query per figure so a failure names itself.
  const one = async (label, sql) => {
    try {
      const [r] = await config.sequelize.query(sql, { type: QueryTypes.SELECT, replacements: { from, to } })
      return Number(r.v) || 0
    } catch (err) {
      console.error(`cross-check "${label}" failed:`, err.message, err.original ? err.original.message : '')
      return NaN
    }
  }
  const surgeWhere = `status='completed' AND cumulativeIssuedLbs>=100 AND COALESCE(completedAt,createdAt)>= :from AND COALESCE(completedAt,createdAt)< :to`
  const blendWhere = surgeWhere
  const sepWhere = `inputVolume>0 AND COALESCE(batchEnd,createdAt)>= :from AND COALESCE(batchEnd,createdAt)< :to`
  const x = {
    surgeN: await one('surgeN', `SELECT COUNT(*) v FROM [${P}MesSurgeTankBatches] WHERE ${surgeWhere}`),
    surgeIn: await one('surgeIn', `SELECT SUM(cumulativeIssuedLbs) v FROM [${P}MesSurgeTankBatches] WHERE ${surgeWhere}`),
    surgeUpperAll: await one('surgeUpperAll', `SELECT SUM(CASE WHEN cumulativeIssuedLbs-cumulativeOutputLbs<0 THEN 0 ELSE cumulativeIssuedLbs-cumulativeOutputLbs END) v FROM [${P}MesSurgeTankBatches] WHERE ${surgeWhere}`),
    surgeUnmeasured: await one('surgeUnmeasured', `SELECT COUNT(*) v FROM [${P}MesSurgeTankBatches] WHERE ${surgeWhere} AND concurrentFillDrain=1 AND NOT (concurrentTickCount>0 AND meteredDrainTickCount=concurrentTickCount AND drainFillerLines='1')`),
    blendN: await one('blendN', `SELECT COUNT(*) v FROM [${P}MesBlendTankBatches] WHERE ${blendWhere}`),
    blendWaste: await one('blendWaste', `SELECT SUM(CASE WHEN cumulativeIssuedLbs-cumulativeOutputLbs<0 THEN 0 ELSE cumulativeIssuedLbs-cumulativeOutputLbs END) v FROM [${P}MesBlendTankBatches] WHERE ${blendWhere}`),
    sepN: await one('sepN', `SELECT COUNT(*) v FROM [${P}MesSeparationBatches] WHERE status IN ('completed','error') AND ${sepWhere}`),
    sepWaste: await one('sepWaste', `SELECT SUM(CASE WHEN wasteVolume<0 THEN 0 ELSE wasteVolume END) v FROM [${P}MesSeparationBatches] WHERE status IN ('completed','error') AND ${sepWhere}`),
    sepHeld: await one('sepHeld', `SELECT COUNT(*) v FROM [${P}MesSeparationBatches] WHERE status='pending_ns' AND ${sepWhere}`),
  }
  const S = rep.stages.find(s => s.key === 'surge'), B = rep.stages.find(s => s.key === 'blend'), E = rep.stages.find(s => s.key === 'separation')
  const checks = [
    ['surge batches', S.batches, n(x.surgeN)],
    ['surge lbsIn', Math.round(S.lbsIn), Math.round(n(x.surgeIn))],
    ['surge unmeasured batches', S.unmeasuredBatches, n(x.surgeUnmeasured)],
    ['surge waste ≤ upper bound of all', Math.round(S.wasteLbs) <= Math.round(n(x.surgeUpperAll)) + 1 ? 'ok' : 'VIOLATED', 'ok'],
    ['surge measured+upper = waste', Math.round(S.wasteLbsMeasured + S.wasteLbsUpperBoundOnly), Math.round(S.wasteLbs)],
    ['blend batches', B.batches, n(x.blendN)],
    ['blend waste', Math.round(B.wasteLbs), Math.round(n(x.blendWaste))],
    ['separation batches', E.batches, n(x.sepN)],
    ['separation waste', Math.round(E.wasteLbs), Math.round(n(x.sepWaste))],
    ['separation held', rep.unaccounted.separationHeld.count, n(x.sepHeld)],
  ]
  let bad = 0
  console.log('\nCROSS-CHECK')
  for (const [name, a, b] of checks) {
    const ok = a === b
    if (!ok) bad++
    console.log(` ${ok ? '✓' : '✗'} ${name}: report=${a} sql=${b}`)
  }
  await config.sequelize.close()
  process.exit(bad ? 1 : 0)
}

main().catch(err => { console.error('PROBE FAILED:', err.message); console.error(err.stack); process.exit(1) })
