/**
 * Create a LOT-TRACKED "batch" twin of a non-lot type-2 standardization milk,
 * so blend-tank WOs have a distinct lot-tracked assembly to complete into
 * (instead of issuing/completing the same non-lot item — the circular bug).
 *
 * Clones the source item's config (accounts, units, cost category, custom blend
 * fields, customForm) so the twin stays in the same product family, flips
 * isLotItem=true, names it "<source name> (Batch)", then copies the source's
 * master BOM recipe (raw blend components) onto a new BOM for the twin.
 *
 *   node scripts/createBatchTwin.js <sourceItemId> [--commit]
 *   node scripts/createBatchTwin.js 8370            # dry run: print bodies
 *   node scripts/createBatchTwin.js 8370 --commit   # actually create
 *
 * Dry run by default — prints the exact POST bodies and the resolved BOM
 * without writing anything.
 */
const core = require('../clients/coreClient')

const SOURCE = process.argv[2] || '8370'
const COMMIT = process.argv.includes('--commit')

async function sql(q) {
  const r = await core.netsuitePost('/query/v1/suiteql', { q })
  return r?.items || r?.body?.items || []
}
const refId = v => (v && v.id != null ? { id: String(v.id) } : undefined)

// Ref-type fields to carry over so the twin shares the source's GL accounts,
// cost category, units, form, and product classification.
const REF_FIELDS = [
  'assetAccount', 'cogsAccount', 'incomeAccount', 'wipAcct', 'scrapAcct',
  'billPriceVarianceAcct', 'billQtyVarianceAcct', 'prodPriceVarianceAcct',
  'prodQtyVarianceAcct', 'purchasePriceVarianceAcct', 'custReturnVarianceAccount',
  'unbuildVarianceAccount', 'vendReturnVarianceAccount', 'taxSchedule',
  'costCategory', 'currency', 'unitsType', 'costEstimateType', 'atpMethod',
  'supplyReplenishmentMethod', 'weightUnit', 'customForm', 'custitem_sun_mesclass',
  'custitem6',
]
const SCALAR_FIELDS = [
  'baseUnit', 'stockUnit', 'purchaseUnit', 'saleUnit', 'consumptionUnit',
  'costEstimateUnits', 'transferPriceUnits', 'weightUnits', 'weight',
  'includeChildren', 'useBins',
]

async function main() {
  const src = (await core.netsuiteGet(`/record/v1/assemblyItem/${SOURCE}`))?.body
  if (!src) throw new Error(`source item ${SOURCE} not found`)
  const newName = `${src.itemId} (Batch)`
  console.log(`source: ${SOURCE} "${src.itemId}" → twin "${newName}" (lot-tracked)`)

  // --- item body ---
  const itemBody = {
    itemId: newName,
    description: `${src.itemId} — lot-tracked batch-tank version`,
    itemType: { id: 'Assembly' },
    costingMethod: { id: 'STANDARD' },
    isLotItem: true,
    subsidiary: { items: [{ id: '3' }] }, // Ida Milk
  }
  for (const f of REF_FIELDS) { const r = refId(src[f]); if (r) itemBody[f] = r }
  for (const f of SCALAR_FIELDS) { if (src[f] != null) itemBody[f] = src[f] }

  // Override MES class to the batch-FG class (1), NOT the source's
  // standardization-milk class (16). Working batch FGs (8342/8346/8333) use 1.
  itemBody.custitem_sun_mesclass = { id: '1' }

  // --- BOM recipe (copy source's master BOM components) ---
  const bomRows = (await core.netsuiteGet(`/record/v1/assemblyItem/${SOURCE}?expandSubResources=true`))
    ?.body?.billOfMaterials?.items || []
  const chosen = bomRows.find(r => r.masterDefault || r.bomDefault) || bomRows[0]
  let recipe = []
  if (chosen?.currentRevision?.id || chosen?.billOfMaterials?.id) {
    let revId = chosen?.currentRevision?.id
    if (!revId) {
      const rev = (await sql(`SELECT id FROM bomrevision WHERE billofmaterials = ${chosen.billOfMaterials.id} ORDER BY id DESC`))[0]
      revId = rev?.id
    }
    if (revId) recipe = await sql(`SELECT item, quantity FROM bomrevisioncomponent WHERE bomrevision = ${revId}`)
  }
  console.log(`recipe (from source master BOM): ${recipe.map(c => `${c.item}×${c.quantity}`).join(' + ') || '(none found)'}`)

  console.log('\n--- assemblyItem POST body ---')
  console.log(JSON.stringify(itemBody, null, 1))

  if (!COMMIT) {
    console.log('\nDRY RUN — pass --commit to create the item + BOM. (BOM creation runs after the item exists.)')
    return
  }

  console.log('\ncreating item...')
  const created = await core.netsuitePost('/record/v1/assemblyItem', itemBody)
  let newId = created?.id || created?.body?.id
  if (!newId && created?.headers?.location) {
    const m = String(created.headers.location).match(/\/(\d+)$/); if (m) newId = m[1]
  }
  console.log(`✓ created item ${newId} (status ${created?.status})`)
  console.log(`\nNEXT: attach BOM with recipe [${recipe.map(c => `${c.item}×${c.quantity}`).join(', ')}] to item ${newId}.`)
  console.log(`(BOM attach handled in a follow-up step once we confirm the item looks right in NS.)`)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
