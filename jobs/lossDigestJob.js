const config = require('../config')
const core = require('../clients/coreClient')
const lossReportService = require('../services/lossReportService')
const statusStore = require('../services/statusStore')
const plantTime = require('../utils/plantTime')

let lastPollTime = new Date()

const fmtUsd = v => `$${Math.round(Number(v) || 0).toLocaleString('en-US')}`
const fmtLbs = v => `${Math.round(Number(v) || 0).toLocaleString('en-US')} lb`
const isoDay = v => (v == null ? null : (v instanceof Date ? v : new Date(v)).toISOString().slice(0, 10))

/**
 * Weekly Milk Loss digest (SD-729): Monday 06:00 plant time, the previous
 * ISO week (Mon→Sun) as a Teams Adaptive Card via the Gateway's
 * POST /internal/notify/teams (channel 'loss'). The card is a handful of
 * facts + the report's own insight sentences + a link to the SunApps page.
 *
 * Posting is gated THREE ways so a dev/local instance can never write to the
 * executive channel: ENVIRONMENT === 'prod', LOSS_DIGEST_ENABLED === true,
 * and MES_DRY_RUN off. Everything else only logs the card and pushes a
 * lossDigest.dryRun event — the digest-preview endpoint shows the same card.
 */
function buildCard(report, { fromDay, toDay }) {
  const h = report.headline
  // Two $ bases, as peers: raw-milk cost and forgone FG revenue (never added).
  const facts = [
    { title: 'Milk lost', value: `${fmtLbs(h.lossLbs)}${h.lossPct != null ? ` · ${h.lossPct.toFixed(1)}%` : ''} · ${h.batches} batches` },
    { title: 'Loss · raw milk cost', value: `${fmtUsd(h.lossUsd)} (measured ${fmtUsd(h.lossUsdMeasured)}, upper-bound ${fmtUsd(h.lossUsdUpperBound)})` },
    { title: 'Loss · revenue', value: `${fmtUsd(h.lostRevenueUsd)} (measured ${fmtUsd(h.lostRevenueUsdMeasured)}, upper-bound ${fmtUsd(h.lostRevenueUsdUpperBound)})` },
  ]
  if (h.delta) {
    const arrow = v => (v >= 0 ? '▲' : '▼')
    const pct = v => (v != null ? ` (${v >= 0 ? '+' : ''}${v.toFixed(0)}%)` : '')
    facts.push({ title: 'vs prior week', value: `cost ${arrow(h.delta.lossUsd)} ${fmtUsd(Math.abs(h.delta.lossUsd))}${pct(h.delta.lossUsdPct)} · revenue ${arrow(h.delta.lostRevenueUsd)} ${fmtUsd(Math.abs(h.delta.lostRevenueUsd))}${pct(h.delta.lostRevenueUsdPct)}` })
  }
  const worst = report.byEquipment[0]
  if (worst) facts.push({ title: 'Worst equipment', value: `${worst.equipment}${worst.group ? ` (${worst.group})` : ''} · cost ${fmtUsd(worst.wasteUsd)}${worst.lostRevenueUsd != null ? ` · revenue ${fmtUsd(worst.lostRevenueUsd)}` : ''}` })
  const stageLine = report.stages.filter(s => s.wasteUsd > 0 || s.wasteLbs > 0).map(s => `${s.label} ${fmtUsd(s.wasteUsd)}${s.lostRevenueUsd != null ? ` / ${fmtUsd(s.lostRevenueUsd)}` : ''}`).join(' · ')
  if (stageLine) facts.push({ title: 'By stage (cost / revenue)', value: stageLine })
  if (report.unaccounted.zeroIssuedCount > 0) {
    const est = report.unaccounted.zeroIssuedEstimatedLbs
    facts.push({ title: 'Unaccounted batches', value: `${report.unaccounted.zeroIssuedCount}${est > 0 ? ` (~${fmtLbs(est)} by the UHT totalizer)` : ''}` })
  }
  if (h.unpricedLbs > 0) facts.push({ title: 'Unpriced', value: fmtLbs(h.unpricedLbs) })
  const blind = (report.chain || []).filter(c => c.status === 'not-measured').map(c => c.label)
  if (blind.length) facts.push({ title: 'Not measured yet', value: blind.join(' · ') })
  return {
    channel: 'loss',
    title: `Milk loss · week of ${fromDay}`,
    subtitle: `${fromDay} → ${toDay} (plant time) · prices as of ${isoDay(report.pricing.ratesAsOf) || 'n/a'}`,
    facts,
    lines: report.insights.slice(0, 4).map(i => i.text),
    link: config.LOSS_REPORT_URL || null,
  }
}

function wouldPost() {
  return config.ENVIRONMENT === 'prod' && config.LOSS_DIGEST_ENABLED && !config.MES_DRY_RUN
}

async function preview({ from, to, fromDay, toDay } = {}) {
  let win
  if (from && to) {
    const f = new Date(from), t = new Date(to)
    win = { from: f, to: t, fromDay: fromDay || plantTime.plantDateString(f), toDay: toDay || plantTime.plantDateString(new Date(t.getTime() - 1)) }
  } else {
    win = plantTime.lastIsoWeek()
  }
  const report = await lossReportService.getLossReport({ from: win.from.toISOString(), to: win.to.toISOString(), groupBy: 'day', compare: true })
  return { card: buildCard(report, win), wouldPost: wouldPost(), period: report.period }
}

async function run() {
  const win = plantTime.lastIsoWeek()
  try {
    const { card } = await preview(win)
    if (wouldPost()) {
      await core.sendTeamsCard(card)
      console.log(`[LossDigestJob] posted "${card.title}"`)
      statusStore.pushEvent('lossDigest.sent', card.title, { fromDay: win.fromDay, toDay: win.toDay })
    } else {
      console.log(`[LossDigestJob] dry run (env=${config.ENVIRONMENT}, enabled=${config.LOSS_DIGEST_ENABLED}, dryRun=${config.MES_DRY_RUN}):\n${JSON.stringify(card, null, 2)}`)
      statusStore.pushEvent('lossDigest.dryRun', card.title, card)
    }
    lastPollTime = new Date()
    return card
  } catch (err) {
    console.error('[LossDigestJob] error:', err.message)
    statusStore.pushEvent('lossDigest.error', 'Weekly loss digest failed', { error: err.message })
    throw err
  }
}

function getLastPollTime() {
  return lastPollTime
}

function reset() {
  lastPollTime = new Date()
}

module.exports = { run, preview, buildCard, wouldPost, getLastPollTime, reset }
