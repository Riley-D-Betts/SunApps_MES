/**
 * Focused survey of the "Inventory Revaluation is no longer the first
 * transaction in the item's history" failures. Groups by WO (sourceId) and
 * shows, per WO, the failure window + whether any issue on that WO later
 * SUCCEEDED (i.e. the error is transient/self-healing) or stayed broken.
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

async function main() {
  await sequelize.authenticate()
  const since = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)

  const fails = await db.MesProcessingLog.findAll({
    where: {
      success: false,
      createdAt: { [Op.gte]: since },
      errorMessage: { [Op.like]: '%Inventory Revaluation is no longer the first%' },
    },
    order: [['createdAt', 'ASC']],
  })

  console.log(`\n=== ${fails.length} "Inventory Revaluation" failures ===\n`)

  const byWo = new Map()
  for (const r of fails) {
    const wo = r.sourceId
    if (!byWo.has(wo)) byWo.set(wo, [])
    byWo.get(wo).push(r)
  }

  for (const [wo, rows] of byWo) {
    const first = rows[0].createdAt
    const last = rows[rows.length - 1].createdAt
    const types = [...new Set(rows.map(r => r.eventType))].join(',')

    // Did ANY issue/completion on this WO ever succeed?
    const okIssues = await db.MesProcessingLog.count({
      where: { sourceId: wo, success: true, nsTransactionType: 'workOrderIssue' },
    })
    const okAny = await db.MesProcessingLog.count({
      where: { sourceId: wo, success: true },
    })
    console.log(
      `WO ${wo}: ${rows.length} fails [${types}]  ${first.toISOString()} → ${last.toISOString()}  | okIssues=${okIssues} okAny=${okAny}`
    )
  }

  await sequelize.close()
}
main().catch(e => { console.error(e); process.exit(1) })
