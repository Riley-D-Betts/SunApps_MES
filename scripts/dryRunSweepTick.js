/**
 * One-off: run a SINGLE tank-at-rest sweep tick against the LIVE historian + NS
 * with MES_DRY_RUN forced on, so it reads real bin contents and prints the
 * inventoryAdjustment bodies it WOULD post — without posting anything.
 *
 *   node scripts/dryRunSweepTick.js
 */
const config = require('../config')
config.MES_DRY_RUN = true // hard safety: never POST, regardless of .env

const { createProvider } = require('../historian')
const sweep = require('../services/tankAtRestSweepService')

;(async () => {
  console.log(`[dryRunSweepTick] provider=${config.HISTORIAN_PROVIDER} env=${config.ENVIRONMENT} DRY_RUN=${config.MES_DRY_RUN}`)
  const provider = createProvider(config.HISTORIAN_PROVIDER) // 'rest' = live Atlas
  const result = await sweep.tick(provider)

  console.log('\n================ SWEEP RESULT ================')
  const tanks = [...(result.adjustments || []), ...(result.failures || [])]
  // tick() returns adjustments/failures as tank-level entries with .legs
  const reconciled = (result.adjustments || []).concat(result.failures || [])
  const seen = new Set()
  for (const r of reconciled) {
    if (seen.has(r.tankName)) continue
    seen.add(r.tankName)
    console.log(`\n${r.tankName}  (current item ${r.currentItemId || 'unidentified'})  ok=${r.adjustedCount} failed=${r.failedCount}`)
    for (const l of (r.legs || [])) {
      const tag = l.skipped ? `skip:${l.skipped}` : (l.ok ? 'WOULD-POST' : `FAIL:${(l.error || '').slice(0, 120)}`)
      console.log(`   item ${l.itemId}${l.lot ? ` lot ${l.lot}` : ''}  ${l.isCurrent ? '(current)' : '(clear) '}  Δ=${l.qtyDelta ?? '-'}  ${tag}`)
    }
  }
  console.log('\nSkipped tanks:')
  for (const s of (result.skipped || [])) console.log(`   ${s.tankName}: ${s.skipped}`)
  console.log(`\nTotals: ${result.legsAdjusted} legs would post, ${result.legsFailed} legs failed`)
  process.exit(0)
})().catch(err => {
  console.error('[dryRunSweepTick] threw:', err)
  process.exit(1)
})
