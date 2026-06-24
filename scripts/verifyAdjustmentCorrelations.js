/**
 * Verify the adjustment↔WO/unbuild correlation against the real DB.
 * Read-only. Prints the match-quality breakdown and a few samples per matchType.
 *
 * Usage:  node scripts/verifyAdjustmentCorrelations.js [days] [limit]
 */
const { sequelize } = require('../config')
const svc = require('../services/adjustmentCorrelationService')

const DAYS = Number(process.argv[2]) || 30
const LIMIT = Number(process.argv[3]) || 500
const from = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString()

async function main() {
  await sequelize.authenticate()
  const { total, adjustments, correlationStats } = await svc.getInventoryAdjustmentCorrelations({
    from, limit: LIMIT, sortBy: 'createdAt', sortDir: 'DESC',
  })

  console.log(`\nCorrelating ${adjustments.length} of ${total} adjustments (last ${DAYS}d)\n`)
  console.log('Match-quality breakdown:')
  console.log(JSON.stringify(correlationStats, null, 2))

  const bySource = {}
  for (const r of adjustments) {
    const k = `${r.source} → ${r.correlation.matchType}`
    bySource[k] = (bySource[k] || 0) + 1
  }
  console.log('\nsource → matchType:')
  for (const [k, v] of Object.entries(bySource).sort()) console.log(`  ${k}: ${v}`)

  const sample = (type, k = 3) => {
    const rows = adjustments.filter(r => r.correlation.matchType === type).slice(0, k)
    console.log(`\n=== ${type} (${rows.length} shown) ===`)
    for (const r of rows) {
      const c = r.correlation
      const b = c.batch
      console.log(
        `  adj id=${r.id} src=${r.source} item=${r.itemId} tank=${r.tankName} Δ=${r.qtyDelta}\n` +
        `    memo: ${String(r.memo || '').slice(0, 100)}\n` +
        `    → ${c.matchType}/${c.confidence}` +
        (b ? ` batch=${b.kind}#${b.id} WO=${b.nsWorkOrderId || '-'} item=${b.item} "${b.productName || ''}"` : ' (no batch)') +
        (c.candidates != null ? ` candidates=${c.candidates}` : '') +
        (c.note ? `\n    note: ${c.note}` : '')
      )
    }
  }
  sample('exact-wo')
  sample('exact-sep-batch')
  sample('fuzzy-tank-time')
  sample('none')

  await sequelize.close()
}
main().catch(e => { console.error('FAILED:', e); process.exit(1) })
