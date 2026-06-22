/**
 * Broad post-weekend health survey beyond the failure log:
 *  - item-8370 batches: physical lbs that flowed but never reached NS
 *  - blend/surge/separation batches stuck in non-terminal/error states
 *  - inflows stranded in pending_ns / error / unmatched
 */
const { Op, fn, col } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

async function main() {
  await sequelize.authenticate()
  const since = new Date('2026-06-20T00:00:00Z')

  // 1) item-8370 ("Raw organic A2 4%") batches — what physically flowed vs what NS got
  console.log('\n=== item-8370 batches: physical flow vs NS ===')
  const b8370 = await db.MesBlendTankBatch.findAll({ where: { mesItem: '8370' }, order: [['createdAt', 'ASC']] })
  for (const b of b8370) {
    const inflowSum = await db.MesBlendTankInflow.sum('totalLbs', { where: { blendTankBatchId: b.id } }) || 0
    const inflowByStatus = await db.MesBlendTankInflow.findAll({
      where: { blendTankBatchId: b.id },
      attributes: ['status', [fn('COUNT', col('id')), 'n'], [fn('SUM', col('totalLbs')), 'lbs']],
      group: ['status'], raw: true,
    })
    console.log(`  batch ${b.id} WO=${b.nsWorkOrderId} tank=${b.tankId} status=${b.status} issued=${b.cumulativeIssuedLbs} completed=${b.cumulativeCompletedLbs} | inflowRows=${inflowSum.toFixed(0)}lb ${JSON.stringify(inflowByStatus)}`)
  }

  // 2) Blend batches stuck active/error (excluding the known 8370 ones, but show all)
  console.log('\n=== blend batches NOT completed (status active/error/pending_ns) ===')
  const stuckBlend = await db.MesBlendTankBatch.findAll({
    where: { status: { [Op.ne]: 'completed' } }, order: [['createdAt', 'DESC']], limit: 30,
  })
  for (const b of stuckBlend) {
    console.log(`  id=${b.id} ${b.createdAt.toISOString()} tank=${b.tankId} status=${b.status} WO=${b.nsWorkOrderId} item=${b.mesItem} "${b.productName}" issued=${b.cumulativeIssuedLbs} err=${(b.errorMessage||'').slice(0,80)}`)
  }

  // 3) Inflows stranded
  console.log('\n=== inflow status tally (since 2026-06-20) ===')
  const inflowTally = await db.MesBlendTankInflow.findAll({
    where: { createdAt: { [Op.gte]: since } },
    attributes: ['status', [fn('COUNT', col('id')), 'n'], [fn('SUM', col('totalLbs')), 'lbs']],
    group: ['status'], raw: true,
  })
  console.log(inflowTally)

  // 4) Surge + separation batch state tallies
  for (const [name, model] of [['MesSurgeTankBatch', db.MesSurgeTankBatch], ['MesSeparationBatch', db.MesSeparationBatch]]) {
    if (!model) continue
    console.log(`\n=== ${name} status tally (since 2026-06-20) ===`)
    const t = await model.findAll({
      where: { createdAt: { [Op.gte]: since } },
      attributes: ['status', [fn('COUNT', col('id')), 'n']],
      group: ['status'], raw: true,
    }).catch(e => { console.log('  (query failed:', e.message, ')'); return [] })
    console.log(t)
  }

  // 5) overall success/fail rate of issues since 2026-06-20
  console.log('\n=== MesProcessingLog success/fail by eventType (since 2026-06-20) ===')
  const rate = await db.MesProcessingLog.findAll({
    where: { createdAt: { [Op.gte]: since } },
    attributes: ['eventType', 'success', [fn('COUNT', col('id')), 'n']],
    group: ['eventType', 'success'], raw: true, order: [['eventType', 'ASC']],
  })
  console.log(rate)

  await sequelize.close()
}
main().catch(e => { console.error(e); process.exit(1) })
