/**
 * Move the "(batch tank milk)" label off the non-lot standardization milks and
 * onto the lot-tracked batch twins.
 *   - NON-LOT (standardization milk inputs): strip the suffix.
 *   - LOT twins (batch-tank products): set "<product> (Batch Tank Milk)".
 *
 * Explicit ID lists (no broad sweep). Standardizes on "(Batch Tank Milk)" to
 * match the 32 existing lot items. Legacy "_LN" items are intentionally NOT
 * touched. Dry run by default; --commit to PATCH.
 *
 *   node scripts/fixTankMilkDescriptions.js
 *   node scripts/fixTankMilkDescriptions.js --commit
 */
const core = require('../clients/coreClient')
const COMMIT = process.argv.includes('--commit')

// Non-lot standardization milks that currently carry the suffix → strip it.
const STRIP = ['8366', '8367', '8368', '8369', '8370']
// Lot-tracked batch twins → set "<product> (Batch Tank Milk)".
const SET = ['8928', '8929', '8930', '8931', '8932', '8933', '8934', '8935', '8936', '8937', '8938', '8939', '8940']

const SUFFIX = ' (Batch Tank Milk)'
const stripSuffix = d => String(d || '').replace(/\s*\((?:batch|blend) tank milk\)\s*$/i, '').trim()
const baseFromItemId = id => String(id || '').replace(/\s*\(Batch\)\s*$/i, '').trim()

async function main() {
  console.log(`\n=== tank-milk description swap (${COMMIT ? 'COMMIT' : 'DRY RUN'}) ===\n`)

  for (const id of STRIP) {
    const it = (await core.netsuiteGet(`/record/v1/assemblyItem/${id}?fields=itemId,description`))?.body
    const next = stripSuffix(it?.description)
    console.log(`STRIP ${id}: "${it?.description}" → "${next}"`)
    if (COMMIT && next !== it?.description) await core.netsuitePatch(`/record/v1/assemblyItem/${id}`, { description: next })
  }

  console.log('')
  for (const id of SET) {
    const it = (await core.netsuiteGet(`/record/v1/assemblyItem/${id}?fields=itemId,description`))?.body
    const next = baseFromItemId(it?.itemId) + SUFFIX
    console.log(`SET   ${id}: "${it?.description}" → "${next}"`)
    if (COMMIT && next !== it?.description) await core.netsuitePatch(`/record/v1/assemblyItem/${id}`, { description: next })
  }

  console.log(COMMIT ? '\n✓ committed.' : '\nDRY RUN — pass --commit to apply.')
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
