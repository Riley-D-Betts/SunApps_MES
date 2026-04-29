const db = require('../models')
const { Op } = require('sequelize')

async function main() {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const recent = await db.MesSeparationBatch.findAll({
    where: { createdAt: { [Op.gte]: since } },
    order: [['createdAt', 'DESC']],
    limit: 5,
    raw: true,
  })
  for (const r of recent) {
    let dests = {}
    try { dests = JSON.parse(r.destinations || '{}') } catch (e) {}
    console.log(`\n=== batch ${r.batchId} (${r.sourceSilo}) status=${r.status} ===`)
    console.log('  source:', dests.source)
    console.log('  resolved dests:')
    for (const d of dests.resolved || []) {
      console.log(`    - raw=${d.raw} silo=${d.silo} kind=${d.kind} idx=${d.productIndex} name="${d.productName}" nsItem=${d.item?.id} (${d.item?.name}) bin=${d.binId}`)
    }
    console.log('  err:', (r.errorMessage || '').slice(0, 200))
  }
  await db.sequelize.close()
}
main().catch(err => { console.error(err); process.exit(1) })
