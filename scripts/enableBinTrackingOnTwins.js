/**
 * Set useBins=true on all 13 lot-tracked batch-twin assembly items (8928-8940).
 *
 * These were created via scripts/rolloutBatchTwins.js 2026-06-22. The source
 * standardization-milk items don't have useBins enabled in NS, so the twins
 * inherited useBins=false. Without it the blend-tank sweep posts adjustments
 * without a binnumber, NS lands inventory in the default slot, and getBinQtyOnHand
 * always returns 0 — causing an infinite +76k adjustment loop every 5 minutes.
 *
 * Usage:
 *   node scripts/enableBinTrackingOnTwins.js          # dry run: show current state
 *   node scripts/enableBinTrackingOnTwins.js --commit  # patch useBins=true on all
 */

const core = require('../clients/coreClient')

const COMMIT = process.argv.includes('--commit')

// All 13 batch twins from the 2026-06-22 rollout. Source → twin:
//   A2 4%:       8370 → 8928    Conv 1%:   5415 → 8929    Conv 2%:   5412 → 8930
//   Conv 3.25%:  5413 → 8931    Conv 3.5%: 5416 → 8932    Org 1%:    5409 → 8933
//   Org 2%:      5410 → 8934    Org 3.25%: 5411 → 8935    Org 3.5%:  5401 → 8936
//   A2 1%:       8366 → 8937    A2 2%:     8367 → 8938    A2 3.25%:  8368 → 8939
//   A2 3.5%:     8369 → 8940
const TWIN_IDS = [8928, 8929, 8930, 8931, 8932, 8933, 8934, 8935, 8936, 8937, 8938, 8939, 8940]

async function main() {
  console.log(`Mode: ${COMMIT ? 'COMMIT (will patch NS)' : 'DRY RUN (read-only)'}\n`)

  const results = []
  for (const id of TWIN_IDS) {
    try {
      const item = (await core.netsuiteGet(`/record/v1/assemblyItem/${id}`))?.body
      if (!item) {
        results.push({ id, status: 'NOT_FOUND' })
        continue
      }
      const current = { useBins: item.useBins, isLotItem: item.isLotItem, itemId: item.itemId }
      results.push({ id, ...current, status: current.useBins ? 'already-set' : 'needs-patch' })
    } catch (err) {
      results.push({ id, status: 'error', error: err.message.slice(0, 120) })
    }
  }

  console.log('Current state:')
  for (const r of results) {
    const flag = r.useBins ? '✓' : r.status === 'needs-patch' ? '✗' : '?'
    console.log(`  ${flag} ${r.id}  useBins=${r.useBins ?? '?'}  isLotItem=${r.isLotItem ?? '?'}  "${r.itemId || r.status}"${r.error ? '  ERR: ' + r.error : ''}`)
  }

  const needsPatch = results.filter(r => r.status === 'needs-patch')
  console.log(`\n${needsPatch.length} of ${TWIN_IDS.length} items need patching.`)

  if (!COMMIT) {
    console.log('\nDRY RUN — pass --commit to apply useBins=true to all items above.')
    return
  }

  if (needsPatch.length === 0) {
    console.log('Nothing to do.')
    return
  }

  console.log('\nPatching...')
  for (const r of needsPatch) {
    try {
      await core.netsuitePatch(`/record/v1/assemblyItem/${r.id}`, { useBins: true })
      console.log(`  ✓ ${r.id} "${r.itemId}" → useBins=true`)
    } catch (err) {
      console.error(`  ✗ ${r.id} "${r.itemId}" FAILED: ${err.message.slice(0, 200)}`)
    }
  }

  console.log('\nDone. Restart the MES service so getItemTracking() cache clears and the sweep picks up the new tracking config.')
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
