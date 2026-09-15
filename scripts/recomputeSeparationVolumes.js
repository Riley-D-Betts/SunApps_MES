/**
 * Rebuild separation batch volumes from the historian with the SD-722
 * reset-aware totalizer logic, and print before/after per batch.
 *
 * Why: the separator totalizers (feed lb, cream/skim gal) are per-transfer
 * counters that SCADA zeroes 5 s – 9 min AFTER the feed-permit edge MES opens
 * on. The old baseline (taken at the edge = the previous transfer's final
 * totals) under-counted whenever the new transfer out-ran the previous one —
 * e.g. batch 61: cream 9,710 / skim 82,545 lb recorded vs 28,503 / 318,367
 * real, i.e. +253k lb of phantom "waste". See services/separatorTotalizer.js.
 *
 * For each completed / pending_ns / error batch whose batchEnd falls in the
 * plant-day range it replays what the fixed state machine would have computed:
 *   1. baselines via batchStartFinder._resetAwareBaselineAt over
 *      [stored batchStart (the back-found edge), MES open time] — the same call
 *      the live back-finder makes — with the same "finder value above the live
 *      open reading ⇒ reset in between ⇒ 0" guard;
 *   2. per-tick readings from AnalogSummary (batchStartFinder.analogSummaryPoints:
 *      First/Min/Max/Last per 30 s bucket) from open to batchEnd,
 *      stepped through separatorTotalizer.advanceTotalizer.
 *
 * Dry run by default. --confirm updates ONLY inputVolume, creamVolume,
 * skimVolume, wasteVolume, wastePercent on the MES table (status is not
 * touched — pending_ns batches stay held for review). It NEVER talks to
 * NetSuite: assembly unbuilds already posted with the wrong quantities are NOT
 * corrected by this script.
 *
 * Historian reads are sequential (one request at a time). Table set follows
 * ENVIRONMENT (dev_/prod_).
 *
 * Usage:
 *   ENVIRONMENT=prod node scripts/recomputeSeparationVolumes.js --from 2026-06-15 --to 2026-09-14
 *   ENVIRONMENT=prod node scripts/recomputeSeparationVolumes.js --from 2026-06-15 --ids 61,175
 *   ENVIRONMENT=prod node scripts/recomputeSeparationVolumes.js --from 2026-06-15 --to 2026-09-14 --confirm
 */
const config = require('../config')
const db = require('../models')
const { Op } = require('sequelize')
const plantTime = require('../utils/plantTime')
const { createProvider } = require('../historian')
const { _resetAwareBaselineAt, analogSummaryPoints } = require('../services/batchStartFinder')
const { newTotalizerState, advanceTotalizer, RESET_MIN_DROP } = require('../services/separatorTotalizer')

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
const fromDay = arg('from')
const toDay = arg('to', plantTime.addPlantDays(plantTime.plantDateString(), -1))
const ids = (arg('ids', '') || '').split(',').map(Number).filter(Boolean)
const confirm = process.argv.includes('--confirm')
if (!fromDay || !/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay) || toDay < fromDay) {
  console.error('usage: node scripts/recomputeSeparationVolumes.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--ids 1,2] [--confirm]')
  process.exit(2)
}

// Mirror historian/providers/restProvider.js + services/separatorStateMachine.js
const TAGS = [
  ['feed', 'Product.SepFeedTotal', 1],
  ['cream', 'Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized', 8.3],
  ['skim', 'Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized', 8.63],
]
const MASS_BALANCE_TOLERANCE = 0.02         // separatorStateMachine
const MIN_INPUT_FOR_PERCENT_LBS = 10         // milkMesService
const WASTE_PCT_CLAMP = 999999.99
const RESOLUTION_MS = 30 * 1000

const num = v => (v != null && isFinite(Number(v)) ? Number(v) : null)
const r0 = v => (v == null ? '' : Math.round(v).toLocaleString('en-US'))

async function recomputeBatch(h, b) {
  const openMs = Number(String(b.batchId).split('-')[1]) || new Date(b.batchStart).getTime()
  const open = new Date(openMs)
  const edge = b.batchStart ? new Date(b.batchStart) : open
  const endMs = new Date(b.batchEnd).getTime()
  const out = { resets: [] }
  for (const [k, tag, ppg] of TAGS) {
    const winStart = new Date(Math.floor(Math.min(edge.getTime(), openMs) / RESOLUTION_MS) * RESOLUTION_MS)
    const winEnd = new Date(Math.ceil(endMs / RESOLUTION_MS) * RESOLUTION_MS + RESOLUTION_MS)
    const pts = ((await analogSummaryPoints(h, tag, winStart, winEnd, RESOLUTION_MS)) || [])
      .filter(p => p.t >= openMs && p.t <= endMs + RESOLUTION_MS)
      .map(p => ({ t: p.t, v: p.v * ppg }))
    if (!pts.length) return { error: `no ${k} history` }
    // Open reading, then the back-finder baseline (only when the batch was
    // back-projected, i.e. edge != open; boundary re-opens use the open reading).
    const openReading = pts[0].v
    let st = newTotalizerState(openReading, openReading)
    if (edge.getTime() !== openMs) {
      const fr = await _resetAwareBaselineAt(tag, edge, open, h)
      if (fr != null && isFinite(fr.value)) {
        const fv = fr.value * ppg
        // same guard as separatorStateMachine's back-finder callback
        if (fr.resetSeen || fv > (st.last ?? 0) + RESET_MIN_DROP) { st.baseline = 0; st.resetSeen = true } else st.baseline = fv
      }
    }
    let vol = Math.max(0, (st.last ?? st.baseline) - st.baseline)
    for (const p of pts.slice(1)) {
      const prevLast = st.last
      const { volume, reset, ...next } = advanceTotalizer(st, p.v, p.t, openMs)
      st = next
      vol = volume
      if (reset) out.resets.push(`${k}@${Math.round((p.t - openMs) / 1000)}s${st.baseline < 0 ? '(KEPT ' + r0(prevLast - 0) + ' prior)' : ''}`)
    }
    out[k] = vol
  }
  const waste = out.feed - out.cream - out.skim
  out.waste = waste
  out.wastePercent = out.feed >= MIN_INPUT_FOR_PERCENT_LBS
    ? Math.max(-WASTE_PCT_CLAMP, Math.min(WASTE_PCT_CLAMP, (waste / out.feed) * 100))
    : null
  out.balances = out.feed >= 1 && out.cream + out.skim <= out.feed * (1 + MASS_BALANCE_TOLERANCE)
  return out
}

async function main() {
  await config.sequelize.authenticate()
  const from = plantTime.startOfPlantDay(fromDay)
  const to = plantTime.startOfPlantDay(plantTime.addPlantDays(toDay, 1))
  console.log(`${confirm ? 'WRITING (MES table volume/waste columns only)' : 'DRY RUN — nothing will be written'} · tables ${config.TABLE_PREFIX}* · batchEnd plant days ${fromDay}..${toDay}${ids.length ? ` · ids ${ids.join(',')}` : ''}`)
  console.log('NOTE: NetSuite is never contacted. Assembly unbuilds already posted from the old volumes are NOT corrected by this script.')

  const where = {
    status: { [Op.in]: ['completed', 'pending_ns', 'error'] },
    batchEnd: { [Op.gte]: from, [Op.lt]: to },
  }
  if (ids.length) where.id = { [Op.in]: ids }
  const batches = await db.MesSeparationBatch.findAll({ where, order: [['id', 'ASC']] })
  console.log(`${batches.length} batch(es)`)

  const h = createProvider('rest')
  const results = []
  for (const b of batches) {
    let r
    try { r = await recomputeBatch(h, b) } catch (err) { r = { error: err.message.slice(0, 160) } }
    const db0 = { feed: num(b.inputVolume) || 0, cream: num(b.creamVolume) || 0, skim: num(b.skimVolume) || 0 }
    const dbWaste = num(b.wasteVolume)
    const row = { b, r, db0, dbWaste }
    results.push(row)
    if (r.error) {
      console.log(`#${b.id} ${b.status} — SKIPPED: ${r.error}`)
      continue
    }
    const dbOut = db0.cream + db0.skim
    console.log(
      `#${b.id} ${b.sourceSilo} ${b.status}/${b.endReason || ''} ${new Date(b.batchEnd).toISOString().slice(0, 16)}  ` +
      `DB in ${r0(db0.feed)} c ${r0(db0.cream)} s ${r0(db0.skim)} waste ${dbWaste == null ? 'null' : r0(dbWaste)} (out/in ${db0.feed ? (dbOut / db0.feed).toFixed(3) : '-'})  →  ` +
      `NEW in ${r0(r.feed)} c ${r0(r.cream)} s ${r0(r.skim)} waste ${r0(r.waste)} (${r.wastePercent == null ? '-' : r.wastePercent.toFixed(1) + '%'}, out/in ${r.feed ? ((r.cream + r.skim) / r.feed).toFixed(3) : '-'}${r.balances ? '' : ' OUT>IN'})` +
      `${r.resets.length ? '  resets ' + r.resets.join(' ') : ''}`
    )
  }

  // Totals
  const ok = results.filter(x => !x.r.error)
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0)
  const notHeld = ok.filter(x => x.b.status !== 'pending_ns')
  const held = ok.filter(x => x.b.status === 'pending_ns')
  const mid = ok.filter(x => x.r.resets.some(s => s.includes('KEPT')))
  console.log('\n=== Totals (lb) ===')
  console.table([
    { set: 'all recomputed', batches: ok.length, dbWaste: Math.round(sum(ok, x => x.dbWaste)), dbWasteMax0: Math.round(sum(ok, x => Math.max(0, x.dbWaste || 0))), newSigned: Math.round(sum(ok, x => x.r.waste)), newMax0: Math.round(sum(ok, x => Math.max(0, x.r.waste))), dbFeed: Math.round(sum(ok, x => x.db0.feed)), newFeed: Math.round(sum(ok, x => x.r.feed)) },
    { set: 'not held (loss report set)', batches: notHeld.length, dbWaste: Math.round(sum(notHeld, x => x.dbWaste)), dbWasteMax0: Math.round(sum(notHeld, x => Math.max(0, x.dbWaste || 0))), newSigned: Math.round(sum(notHeld, x => x.r.waste)), newMax0: Math.round(sum(notHeld, x => Math.max(0, x.r.waste))), dbFeed: Math.round(sum(notHeld, x => x.db0.feed)), newFeed: Math.round(sum(notHeld, x => x.r.feed)) },
  ])
  console.log(`pending_ns: ${held.length} recomputed, ${held.filter(x => x.r.balances).length} would now pass the mass-balance guard (cream+skim ≤ input × ${1 + MASS_BALANCE_TOLERANCE})`)
  console.log(`not held: ${notHeld.filter(x => !x.r.balances).length} would now FAIL the mass-balance guard`)
  console.log(`batches with a later reset that kept prior volume (second transfer inside one batch): ${mid.length}${mid.length ? ' → ' + mid.map(x => '#' + x.b.id).join(', ') : ''}`)
  console.log(`skipped (no history / error): ${results.length - ok.length}`)

  if (!confirm) {
    console.log('\nDry run — nothing written. Re-run with --confirm to update the MES table (volume/waste columns only).')
  } else {
    let n = 0
    for (const x of ok) {
      await db.MesSeparationBatch.update({
        inputVolume: Number(x.r.feed.toFixed(2)),
        creamVolume: Number(x.r.cream.toFixed(2)),
        skimVolume: Number(x.r.skim.toFixed(2)),
        wasteVolume: Number(x.r.waste.toFixed(2)),
        wastePercent: x.r.wastePercent != null ? Number(x.r.wastePercent.toFixed(2)) : null,
      }, { where: { id: x.b.id } })
      n++
    }
    console.log(`\nUpdated ${n} row(s). NetSuite unbuilds were NOT changed — reconcile those separately.`)
  }
  await config.sequelize.close()
}

main().catch(err => { console.error('RECOMPUTE FAILED:', err.message); process.exit(1) })
