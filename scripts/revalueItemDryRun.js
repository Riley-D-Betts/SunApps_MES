/**
 * Dry-run the cost-revaluation fallback for one item against a WO's BOM.
 * Prints eligibility, the rolled-up unit cost, and the exact NS POST body —
 * WITHOUT posting anything. Forces MES_DRY_RUN regardless of .env.
 *
 *   node scripts/revalueItemDryRun.js <assemblyItemId>
 *   node scripts/revalueItemDryRun.js 8370
 */
process.env.MES_DRY_RUN = 'true'
const reval = require('../services/costRevaluationService')

const assemblyItemId = process.argv[2] || '8370'

async function main() {
  console.log(`\n=== cost-basis dry run: item ${assemblyItemId} (master BOM roll-up) ===\n`)

  const elig = await reval.needsCostBasis(assemblyItemId)
  console.log('needsCostBasis:', JSON.stringify(elig))
  if (!elig.eligible) {
    console.log('\n→ Not eligible for auto-revaluation; would alert a human instead.')
    return
  }

  const earliest = await reval.earliestTransactionDate(assemblyItemId)
  console.log('earliest transaction date:', earliest)

  const rollup = await reval.rollupCostFromMasterBom(assemblyItemId)
  console.log(`\nmaster BOM roll-up (bom=${rollup.bomId} rev=${rollup.revisionId}):`)
  for (const c of rollup.components) {
    console.log(`  component ${c.itemId}: cost=${c.cost} x qty=${c.quantity} = ${(c.cost * c.quantity).toFixed(4)}`)
  }
  console.log(`  => rolled-up unitCost = ${rollup.unitCost.toFixed(5)}`)

  const result = await reval.ensureCostBasis({ assemblyItemId })
  console.log('\n=== exact POST body that WOULD be sent (dry run) ===')
  console.log(JSON.stringify(result.body, null, 2))
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
