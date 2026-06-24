/**
 * Context for the revaluation failures: (1) successful blend issues in the same
 * window (is the break global or item-specific?), (2) the product/line/silo each
 * failing WO was issuing, pulled from the failure payloads.
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

const BAD_WOS = ['4890346', '4891735', '4892144', '4897436']

async function main() {
  await sequelize.authenticate()
  const since = new Date('2026-06-21T00:00:00Z')

  // 1) Successful blend_tank issues since the failures began
  const okBlend = await db.MesProcessingLog.findAll({
    where: {
      success: true,
      eventType: { [Op.like]: 'blend_tank%' },
      nsTransactionType: 'workOrderIssue',
      createdAt: { [Op.gte]: since },
    },
    order: [['createdAt', 'ASC']],
  })
  console.log(`\n=== ${okBlend.length} SUCCESSFUL blend_tank workOrderIssues since ${since.toISOString()} ===`)
  for (const r of okBlend) {
    console.log(`  ok id=${r.id} ${r.createdAt.toISOString()} WO=${r.sourceId} ${r.eventType}`)
  }

  // 2) For each bad WO, show the product context from its failure payloads + the
  //    batch rows that reference it.
  console.log(`\n=== failing WO product context ===`)
  for (const wo of BAD_WOS) {
    const rows = await db.MesProcessingLog.findAll({
      where: { sourceId: wo, success: false },
      order: [['createdAt', 'ASC']],
      limit: 3,
    })
    const ctx = new Set()
    for (const r of rows) {
      try {
        const p = JSON.parse(r.payload || '{}')
        ctx.add(JSON.stringify({
          line: p.line, members: p.members, lineProductName: p.lineProductName,
          siloName: p.siloName, destination: p.destination, binId: p.binId,
        }))
      } catch {}
    }
    console.log(`\nWO ${wo}:`)
    for (const c of ctx) console.log(`   ${c}`)
  }

  // 3) Blend tank batch records for these WOs (item, product, dates)
  console.log(`\n=== MesBlendTankBatch rows for failing WOs ===`)
  const batches = await db.MesBlendTankBatch.findAll({
    where: { nsWorkOrderId: { [Op.in]: BAD_WOS } },
  })
  for (const b of batches) {
    console.log(`  batch id=${b.id} WO=${b.nsWorkOrderId} tank=${b.tankId} mesItem=${b.mesItem} product="${b.productName}" status=${b.status} fromEnt=${b.fromEntName} issued=${b.cumulativeIssuedLbs} created=${b.createdAt && b.createdAt.toISOString()}`)
  }

  await sequelize.close()
}
main().catch(e => { console.error(e); process.exit(1) })
