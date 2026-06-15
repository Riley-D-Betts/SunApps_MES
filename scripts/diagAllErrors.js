/**
 * Survey MesProcessingLog failures over the last ~8 days. Groups errors by a
 * normalized signature so we can see which bugs are recurring vs one-offs.
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

// Collapse volatile bits (ids, numbers, lots, timestamps) so similar errors
// group into one signature.
function signature(msg) {
  if (!msg) return '(null)'
  return msg
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, '<ts>')
    .replace(/\b\d{5,}\b/g, '<id>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/"[^"]*"/g, '"<str>"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300)
}

async function main() {
  await sequelize.authenticate()

  const since = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)

  const logs = await db.MesProcessingLog.findAll({
    where: { success: false, createdAt: { [Op.gte]: since } },
    order: [['createdAt', 'DESC']],
  })

  console.log(`\n=== ${logs.length} failed MesProcessingLog rows since ${since.toISOString()} ===\n`)

  const groups = new Map()
  for (const row of logs) {
    const sig = `${row.eventType} | ${row.nsTransactionType || '-'} | ${signature(row.errorMessage)}`
    if (!groups.has(sig)) {
      groups.set(sig, { count: 0, first: row.createdAt, last: row.createdAt, example: row })
    }
    const g = groups.get(sig)
    g.count++
    if (row.createdAt < g.first) g.first = row.createdAt
    if (row.createdAt > g.last) g.last = row.createdAt
  }

  const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count)
  console.log(`=== ${sorted.length} distinct error signatures (by count) ===\n`)
  let i = 0
  for (const [sig, g] of sorted) {
    i++
    console.log(`\n#${i}  [${g.count}x]  ${g.first.toISOString()} → ${g.last.toISOString()}`)
    console.log(`  sig: ${sig}`)
    const ex = g.example
    console.log(`  example id=${ex.id} eventType=${ex.eventType} sourceId=${ex.sourceId} nsTx=${ex.nsTransactionType}/${ex.nsTransactionId}`)
    console.log(`  errorMessage: ${(ex.errorMessage || '').slice(0, 800)}`)
  }

  await sequelize.close()
}

main().catch(err => {
  console.error('FAILED:', err)
  process.exit(1)
})
