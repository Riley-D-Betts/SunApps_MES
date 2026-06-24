/**
 * Probe: discover the NetSuite SuiteQL schema for a work order's child
 * transactions (WO issues / completions), an assembly unbuild, and an inventory
 * adjustment — so the batch-adjustments NS pull can be built on real columns.
 * Read-only. Requires the Core API (NS proxy) reachable.
 *
 * Usage: node scripts/probeNsWoTransactions.js [woId] [unbuildId] [adjId]
 */
const core = require('../clients/coreClient')

const woId = process.argv[2] || '4898045'
const unbuildId = process.argv[3] || '4899037'
const adjId = process.argv[4] || '4899043'

async function q(label, sql) {
  console.log(`\n=== ${label} ===\n${sql.trim()}`)
  try {
    const res = await core.netsuitePost('/query/v1/suiteql', { q: sql })
    const rows = res?.body?.items || res?.items || []
    console.log(`rows: ${rows.length}`)
    for (const r of rows.slice(0, 30)) console.log('  ' + JSON.stringify(r))
    return rows
  } catch (err) {
    console.log('ERROR:', String(err.message).slice(0, 300))
    return null
  }
}

async function main() {
  // 1. The WO itself + its child transactions (issues/completions are createdfrom the WO).
  await q('WO record', `SELECT id, type, trandate, tranid, BUILTIN.DF(status) AS status, createdfrom FROM transaction WHERE id = ${woId}`)
  const kids = await q('child transactions (createdfrom = WO)',
    `SELECT id, type, trandate, tranid, BUILTIN.DF(status) AS status FROM transaction WHERE createdfrom = ${woId} ORDER BY trandate`)

  // 2. Per-type counts so we learn the `type` codes for issue/completion.
  await q('child transaction types',
    `SELECT type, COUNT(*) AS n FROM transaction WHERE createdfrom = ${woId} GROUP BY type`)

  // 3. Line quantities for one child (learn how qty is stored).
  if (kids && kids.length) {
    const kid = kids[0].id
    await q(`lines for child txn ${kid}`,
      `SELECT tl.transaction, tl.item, tl.quantity, tl.quantityuom, BUILTIN.DF(tl.item) AS itemname FROM transactionline tl WHERE tl.transaction = ${kid}`)
  }

  // 4. Aggregate qty per child transaction (the shape the pull will use).
  await q('qty per child txn',
    `SELECT t.id, t.type, SUM(tl.quantity) AS qty FROM transaction t JOIN transactionline tl ON tl.transaction = t.id WHERE t.createdfrom = ${woId} GROUP BY t.id, t.type`)

  // 5. The assembly unbuild (separation) — standalone, by id.
  await q('assembly unbuild record', `SELECT id, type, trandate, tranid, BUILTIN.DF(status) AS status, createdfrom FROM transaction WHERE id = ${unbuildId}`)
  await q('unbuild lines', `SELECT tl.item, tl.quantity, BUILTIN.DF(tl.item) AS itemname FROM transactionline tl WHERE tl.transaction = ${unbuildId}`)

  // 6. The inventory adjustment, by id.
  await q('inventory adjustment record', `SELECT id, type, trandate, tranid, BUILTIN.DF(status) AS status FROM transaction WHERE id = ${adjId}`)
  await q('inventory adjustment lines', `SELECT tl.item, tl.quantity, BUILTIN.DF(tl.item) AS itemname FROM transactionline tl WHERE tl.transaction = ${adjId}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
