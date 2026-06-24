/**
 * Diagnose why surge tank batches show 0 lb issued/completed.
 *
 * Shows:
 *  1. All surge batches from the last 72h with key fields
 *  2. MesSurgeTankIssueState rows — lastTotalizerGal tells us whether
 *     the UHT software totalizer is accumulating at all
 *  3. Recent MesProcessingLog entries for surge tick issues (success + fail)
 *     — if the totalizer is non-zero but nothing issues, errors will show here
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

async function main() {
  await sequelize.authenticate()

  const since72h = new Date(Date.now() - 72 * 60 * 60 * 1000)
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)

  // ── 1. Recent surge batches ────────────────────────────────────────────────
  console.log(`\n=== MesSurgeTankBatches (last 72h) ===`)
  const batches = await db.MesSurgeTankBatch.findAll({
    where: { detectedAt: { [Op.gte]: since72h } },
    order: [['detectedAt', 'DESC']],
    limit: 30,
  })
  console.log(`(${batches.length} rows)`)
  for (const b of batches) {
    console.log(`\n  id=${b.id}  ${b.tankId}  "${b.productName}"  status=${b.status}`)
    console.log(`  WO=${b.nsWorkOrderNumber || '-'}(id=${b.nsWorkOrderId || 'null'})  mesItem=${b.mesItem || '-'}`)
    console.log(`  feedingUhtId=${b.feedingUhtId || 'null'}  feedingFromEntName=${b.feedingFromEntName || 'null'}`)
    console.log(`  componentItemId=${b.componentItemId || 'null'}  componentBinId=${b.componentBinId || 'null'}  resolvedFrom=${b.componentResolvedFrom || 'null'}`)
    console.log(`  cumIssued=${b.cumulativeIssuedLbs}  cumCompleted=${b.cumulativeCompletedLbs}`)
    console.log(`  detectedAt=${b.detectedAt?.toISOString()}  lastIssueAt=${b.lastIssueAt?.toISOString() || '-'}`)
    if (b.errorMessage) console.log(`  ERROR: ${b.errorMessage}`)
  }

  // ── 2. Issue states — key indicator: is lastTotalizerGal > 0? ─────────────
  console.log(`\n\n=== MesSurgeTankIssueStates (all) ===`)
  const states = await db.MesSurgeTankIssueState.findAll({
    order: [['createdAt', 'DESC']],
    limit: 30,
  })
  console.log(`(${states.length} rows)`)
  for (const s of states) {
    console.log(`  batchId=${s.surgeTankBatchId}  uht=${s.uhtId}  lastIssuedUhtGal=${s.lastIssuedUhtGal}  lastTotalizerGal=${s.lastTotalizerGal}  lastObservedAt=${s.lastObservedAt?.toISOString() || '-'}`)
    console.log(`    lastFromEnt=${s.lastFromEntName || '-'}  lastProduct=${s.lastProductName || '-'}`)
  }

  // ── 3. MesProcessingLog for surge tick issues (24h, success + failure) ─────
  console.log(`\n\n=== MesProcessingLog — surge tick issues (last 24h) ===`)
  const logs = await db.MesProcessingLog.findAll({
    where: {
      eventType: { [Op.in]: ['surge_tank_tick_issue', 'surge_tank_tick_completion', 'surge_tank_wo_create'] },
      createdAt: { [Op.gte]: since24h },
    },
    order: [['createdAt', 'DESC']],
    limit: 50,
  })
  console.log(`(${logs.length} rows)`)
  for (const r of logs) {
    const ok = r.success ? 'OK' : 'FAIL'
    console.log(`\n  ${ok}  id=${r.id}  ${r.createdAt.toISOString()}  type=${r.eventType}  src=${r.sourceId}`)
    if (r.errorMessage) console.log(`    error: ${r.errorMessage}`)
    if (r.payload) {
      let p
      try { p = JSON.parse(r.payload) } catch { p = r.payload }
      if (typeof p === 'object') {
        const { batchId, uhtId, deltaGal, deltaLbs, currentGal } = p
        if (deltaGal != null) console.log(`    deltaGal=${deltaGal?.toFixed(1)}  deltaLbs=${deltaLbs?.toFixed(1)}  currentGal=${currentGal?.toFixed(1)}`)
        if (batchId) console.log(`    batchId=${batchId}  uhtId=${uhtId}`)
      }
    }
  }

  await sequelize.close()
}

main().catch(err => { console.error('FAILED:', err); process.exit(1) })
