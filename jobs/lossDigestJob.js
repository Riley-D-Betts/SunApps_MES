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
  const facts = [
    { title: 'Loss (best estimate)', value: `${fmtUsd(h.lossUsd)} · ${fmtLbs(h.lossLbs)}${h.lossPct != null ? ` · ${h.lossPct.toFixed(1)}%` : ''}` },
    { title: 'Of which measured', value: `${fmtUsd(h.lossUsdMeasured)} (${Math.round((h.measuredShare || 0) * 100)}%)` },
    { title: 'Upper-bound only', value: fmtUsd(h.lossUsdUpperBound) },
  ]
  if (h.delta) {
    const up = h.delta.lossUsd >= 0
    facts.push({ title: 'vs prior week', value: `${up ? '▲' : '▼'} ${fmtUsd(Math.abs(h.delta.lossUsd))}${h.delta.lossUsdPct != null ? ` (${up ? '+' : ''}${h.delta.lossUsdPct.toFixed(0)}%)` : ''}` })
  }
  const worst = report.byEquipment[0]
  if (worst) facts.push({ title: 'Worst equipment', value: `${worst.equipment}${worst.group ? ` (${worst.group})` : ''} · ${fmtUsd(worst.wasteUsd)}` })
  const stageLine = report.stages.filter(s => s.wasteUsd > 0 || s.wasteLbs > 0).map(s => `${s.label} ${fmtUsd(s.wasteUsd)}`).join(' · ')
  if (stageLine) facts.push({ title: 'By stage', value: stageLine })
  if (report.unaccounted.zeroIssuedCount > 0) {
    const est = report.unaccounted.zeroIssuedEstimatedLbs
    facts.push({ title: 'Unaccounted batches', value: `${report.unaccounted.zeroIssuedCount}${est > 0 ? ` (~${fmtLbs(est)} by the UHT totalizer)` : ''}` })
  }
  if (h.unpricedLbs > 0) facts.push({ title: 'Unpriced', value: fmtLbs(h.unpricedLbs) })
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
