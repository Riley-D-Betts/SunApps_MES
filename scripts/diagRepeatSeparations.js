/**
 * Find separation batches that look like duplicates of one physical event:
 * same source silo, overlapping/adjacent time windows, often shrinking volumes
 * (totalizer not reset between stages → re-counts the residual).
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

async function main() {
  await sequelize.authenticate()
  const since = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
  const rows = await db.MesSeparationBatch.findAll({
    where: { batchStart: { [Op.gte]: since } },
    order: [['batchStart', 'ASC']],
  })
  console.log(`${rows.length} separation batches since ${since.toISOString()}\n`)

  // Group by source silo, then flag runs whose windows overlap or start within
  // 15 min of the previous one's end.
  const bySilo = new Map()
  for (const r of rows) {
    const k = r.sourceSilo || '?'
    if (!bySilo.has(k)) bySilo.set(k, [])
    bySilo.get(k).push(r)
  }

  for (const [silo, list] of bySilo) {
    for (let i = 0; i < list.length; i++) {
      const a = list[i]
      const cluster = [a]
      while (i + 1 < list.length) {
        const prev = cluster[cluster.length - 1]
        const next = list[i + 1]
        const gapMin = (new Date(next.batchStart) - new Date(prev.batchEnd)) / 60000
        if (gapMin <= 20) { cluster.push(next); i++ } else break
      }
      if (cluster.length > 1) {
        console.log(`\n### ${silo}: cluster of ${cluster.length} batches (possible repeat) ###`)
        for (const b of cluster) {
          console.log(`  id=${b.id} ${b.transferName || ''} start=${new Date(b.batchStart).toISOString()} end=${new Date(b.batchEnd).toISOString()} ` +
            `in=${Number(b.inputVolume).toFixed(0)} cream=${Number(b.creamVolume).toFixed(0)} skim=${Number(b.skimVolume).toFixed(0)} status=${b.status} reason=${b.endReason}`)
        }
      }
    }
  }
  await sequelize.close()
}
main().catch(e => { console.error(e); process.exit(1) })
