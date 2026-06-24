/**
 * LIVE: post the cost-basis revaluation for one item (sandbox). Forces
 * MES_DRY_RUN=false for this single call, posts the BOM-rollup
 * inventoryCostRevaluation, then re-reads the item to confirm cost + InvReval.
 *
 *   node scripts/revalueItemCommit.js 8370
 */
process.env.MES_DRY_RUN = 'false'
const core = require('../clients/coreClient')
const reval = require('../services/costRevaluationService')

const assemblyItemId = process.argv[2] || '8370'

async function sql(q) {
  const r = await core.netsuitePost('/query/v1/suiteql', { q })
  return r?.items || r?.body?.items || []
}

async function main() {
  console.log(`\n=== LIVE revaluation: item ${assemblyItemId} (sandbox) ===\n`)

  const before = (await sql(`SELECT id, cost FROM item WHERE id = ${assemblyItemId}`))[0]
  console.log('before:', JSON.stringify(before))

  const result = await reval.ensureCostBasis({ assemblyItemId })
  console.log('\nensureCostBasis result:', JSON.stringify({
    revalued: result.revalued, reason: result.reason, unitCost: result.unitCost, tranDate: result.tranDate,
    nsStatus: result.nsResult?.status, nsId: result.nsResult?.id || result.nsResult?.body?.id,
  }))

  // Confirm the revaluation landed.
  const after = (await sql(`SELECT id, cost FROM item WHERE id = ${assemblyItemId}`))[0]
  console.log('after:', JSON.stringify(after))
  const revals = await sql(
    `SELECT t.id, t.trandate, t.type FROM transaction t JOIN transactionline tl ON tl.transaction = t.id
     WHERE tl.item = ${assemblyItemId} AND t.type = 'InvReval' ORDER BY t.trandate ASC`
  )
  console.log('InvReval rows now:', JSON.stringify(revals))
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
