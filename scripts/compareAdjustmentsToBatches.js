/**
 * Compare the inventory-adjustments log against the batches log and surface
 * where the two disagree.
 *
 * Linkage (see services/inventoryAdjustmentService.js):
 *   - source='shortfall' rows are bumps posted inline when a batch's WO issue /
 *     assembly unbuild hit insufficient NS on-hand. A shortfall row means the
 *     model believed it had issued/consumed more than NS actually had → stock
 *     was invented to cover it. Lots of shortfall = the model is over-issuing
 *     relative to NS (double-count, totalizer drift, or genuine shrinkage not
 *     yet reconciled).
 *   - source='sweep' rows are the 5-min tank-at-rest reconciliation. Net DOWN
 *     means NS was chronically OVER-stated for that item; net UP means under-stated.
 *   - status in ('error','skipped') means the adjustment never posted → drift
 *     was NOT corrected and keeps accumulating.
 *
 * Usage:  node scripts/compareAdjustmentsToBatches.js [days]   (default 7)
 */
const { Op, fn, col } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

const DAYS = Number(process.argv[2]) || 7
const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)

const n = v => (v == null ? 0 : Number(v))
const lbs = v => n(v).toLocaleString('en-US', { maximumFractionDigits: 0 })
const pad = (s, w) => String(s ?? '').padEnd(w)
const padL = (s, w) => String(s ?? '').padStart(w)

function header(t) {
  console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`)
}

async function main() {
  await sequelize.authenticate()
  console.log(`Comparing inventory adjustments vs batches since ${since.toISOString()} (${DAYS}d)`)

  const [adj, blend, surge, sep] = await Promise.all([
    db.MesInventoryAdjustment.findAll({ where: { createdAt: { [Op.gte]: since } }, raw: true }),
    db.MesBlendTankBatch.findAll({ where: { createdAt: { [Op.gte]: since } }, raw: true }),
    db.MesSurgeTankBatch.findAll({ where: { createdAt: { [Op.gte]: since } }, raw: true }),
    db.MesSeparationBatch.findAll({ where: { createdAt: { [Op.gte]: since } }, raw: true }),
  ])

  // ---- 1. Adjustment overview --------------------------------------------
  header('1. INVENTORY ADJUSTMENTS OVERVIEW')
  const byStatus = {}
  const bySource = {}
  let netLbs = 0
  for (const a of adj) {
    byStatus[a.status] = (byStatus[a.status] || 0) + 1
    bySource[a.source] = (bySource[a.source] || 0) + 1
    if (a.status === 'submitted') netLbs += n(a.qtyDelta)
  }
  console.log(`Total rows: ${adj.length}`)
  console.log(`By status : ${JSON.stringify(byStatus)}`)
  console.log(`By source : ${JSON.stringify(bySource)}`)
  console.log(`Net lbs adjusted (submitted only): ${lbs(netLbs)}`)
  console.log(`Batches in window: blend=${blend.length} surge=${surge.length} separation=${sep.length}`)

  // ---- 2. Failed / skipped adjustments (drift NOT corrected) -------------
  header('2. FAILED / SKIPPED ADJUSTMENTS  (drift NOT corrected)')
  const broken = adj.filter(a => a.status === 'error' || a.status === 'skipped')
  if (!broken.length) {
    console.log('None — every adjustment in the window posted. Good.')
  } else {
    // Bucket by a normalized reason so repeated identical failures collapse.
    const buckets = {}
    for (const a of broken) {
      const reason = (a.errorMessage || '(no message)')
        .replace(/\d+/g, '#')
        .slice(0, 120)
      const key = `${a.status} :: ${reason}`
      ;(buckets[key] = buckets[key] || { count: 0, lbs: 0, tanks: new Set(), items: new Set() })
      buckets[key].count++
      buckets[key].lbs += Math.abs(n(a.qtyDelta))
      buckets[key].tanks.add(a.tankName || `bin${a.binId}`)
      buckets[key].items.add(a.itemId)
    }
    const sorted = Object.entries(buckets).sort((a, b) => b[1].count - a[1].count)
    for (const [key, v] of sorted) {
      console.log(`\n[${v.count}x, ${lbs(v.lbs)} lb blocked]  ${key}`)
      console.log(`   tanks: ${[...v.tanks].slice(0, 8).join(', ')}`)
      console.log(`   items: ${[...v.items].slice(0, 12).join(', ')}`)
    }
  }

  // ---- 3. Shortfall hotspots (model over-issued vs NS) -------------------
  header('3. SHORTFALL HOTSPOTS  (model issued more than NS had → stock invented)')
  const short = adj.filter(a => a.source === 'shortfall')
  if (!short.length) {
    console.log('No shortfall adjustments — no WO issue/unbuild hit insufficient on-hand.')
  } else {
    const key = a => `${a.tankName || `bin${a.binId}`} | item ${a.itemId}`
    const map = {}
    for (const a of short) {
      ;(map[key(a)] = map[key(a)] || { count: 0, lbs: 0, errs: 0 })
      map[key(a)].count++
      map[key(a)].lbs += Math.abs(n(a.qtyDelta))
      if (a.status !== 'submitted') map[key(a)].errs++
    }
    console.log(pad('TANK | ITEM', 40) + padL('#bumps', 8) + padL('total lb', 14) + padL('failed', 9))
    for (const [k, v] of Object.entries(map).sort((a, b) => b[1].lbs - a[1].lbs)) {
      console.log(pad(k, 40) + padL(v.count, 8) + padL(lbs(v.lbs), 14) + padL(v.errs, 9))
    }
  }

  // ---- 4. Sweep drift direction by tank+item -----------------------------
  header('4. SWEEP DRIFT  (net direction = how NS on-hand was wrong at rest)')
  const sweep = adj.filter(a => a.source === 'sweep' && a.status === 'submitted')
  if (!sweep.length) {
    console.log('No posted sweep adjustments in window.')
  } else {
    const key = a => `${a.tankName || `bin${a.binId}`} | item ${a.itemId}`
    const map = {}
    for (const a of sweep) {
      ;(map[key(a)] = map[key(a)] || { count: 0, net: 0, absSum: 0 })
      map[key(a)].count++
      map[key(a)].net += n(a.qtyDelta)
      map[key(a)].absSum += Math.abs(n(a.qtyDelta))
    }
    console.log(pad('TANK | ITEM', 40) + padL('#', 5) + padL('net lb', 14) + padL('|moves| lb', 14) + '  bias')
    for (const [k, v] of Object.entries(map).sort((a, b) => Math.abs(b[1].net) - Math.abs(a[1].net))) {
      const bias = v.net < -50 ? 'NS OVER-stated' : v.net > 50 ? 'NS UNDER-stated' : 'balanced'
      console.log(pad(k, 40) + padL(v.count, 5) + padL(lbs(v.net), 14) + padL(lbs(v.absSum), 14) + '  ' + bias)
    }
  }

  // ---- 5. Batches with errors + their adjustment activity ----------------
  header('5. BATCHES WITH ERRORS  (and whether adjustments tried to cover them)')
  const adjByTank = {}
  for (const a of adj) {
    const t = a.tankName
    if (!t) continue
    ;(adjByTank[t] = adjByTank[t] || []).push(a)
  }
  const errBatches = [
    ...blend.filter(b => b.errorMessage).map(b => ({ kind: 'blend', ...b })),
    ...surge.filter(b => b.errorMessage).map(b => ({ kind: 'surge', ...b })),
    ...sep.filter(b => b.errorMessage).map(b => ({ kind: 'sep', tankId: b.sourceSilo, mesItem: b.itemId, ...b })),
  ]
  if (!errBatches.length) {
    console.log('No batches carry an errorMessage in the window.')
  } else {
    for (const b of errBatches) {
      const acts = adjByTank[b.tankId] || []
      console.log(`\n[${b.kind}] ${b.tankId} "${b.productName || b.batchId}" id=${b.id} status=${b.status} WO=${b.nsWorkOrderNumber || b.nsTransactionId || '-'}`)
      console.log(`   error: ${String(b.errorMessage).slice(0, 200)}`)
      if (b.cumulativeIssuedLbs != null) {
        console.log(`   issued=${lbs(b.cumulativeIssuedLbs)} output=${lbs(b.cumulativeOutputLbs)} waste=${b.wasteLbs == null ? '-' : lbs(b.wasteLbs)} (${b.wastePercent ?? '-'}%)`)
      }
      console.log(`   adjustments tagged to this tank: ${acts.length}` +
        (acts.length ? ` (${acts.filter(a => a.status !== 'submitted').length} failed/skipped)` : ''))
    }
  }

  // ---- 6. Cross-check: shortfall as a fraction of what each batch issued --
  header('6. CROSS-CHECK: shortfall lbs vs batch issued  (high % = fabricated stock)')
  const allBatches = [
    ...blend.map(b => ({ kind: 'blend', tankId: b.tankId, item: b.mesItem, ...b })),
    ...surge.map(b => ({ kind: 'surge', tankId: b.tankId, item: b.componentItemId || b.mesItem, ...b })),
  ].filter(b => n(b.cumulativeIssuedLbs) > 0)

  const shortByTankItem = {}
  for (const a of short) {
    const k = `${a.tankName}|${a.itemId}`
    shortByTankItem[k] = (shortByTankItem[k] || 0) + Math.abs(n(a.qtyDelta))
  }
  const rows = allBatches.map(b => {
    const sLbs = shortByTankItem[`${b.tankId}|${b.item}`] || 0
    const issued = n(b.cumulativeIssuedLbs)
    return { ...b, sLbs, issued, pct: issued > 0 ? (sLbs / issued) * 100 : 0 }
  }).filter(b => b.sLbs > 0).sort((a, b) => b.pct - a.pct)

  if (!rows.length) {
    console.log('No batch had shortfall bumps matched to its (tank,item). Either clean, or')
    console.log('tankName/itemId on the adjustment rows do not match batch tankId/item — check §3.')
  } else {
    console.log(pad('KIND TANK', 22) + padL('issued lb', 14) + padL('shortfall lb', 16) + padL('% of issued', 14))
    for (const b of rows) {
      const flag = b.pct > 20 ? '  <-- HIGH' : ''
      console.log(pad(`${b.kind} ${b.tankId}`, 22) + padL(lbs(b.issued), 14) + padL(lbs(b.sLbs), 16) + padL(b.pct.toFixed(1) + '%', 14) + flag)
    }
  }

  await sequelize.close()
}

main().catch(err => {
  console.error('FAILED:', err)
  process.exit(1)
})
