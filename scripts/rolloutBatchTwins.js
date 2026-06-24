/**
 * Roll out lot-tracked "(Batch)" twins for the type-2 standardized fat-level
 * milks (user-confirmed list). For each source item: clone → lot-tracked twin,
 * copy its master-BOM recipe, attach, and revalue the cost basis. Idempotent
 * (skips a source whose twin already exists) and resilient (per-item try/catch;
 * permission-blocked sources are reported, not fatal).
 *
 *   node scripts/rolloutBatchTwins.js            # dry run: show plan + per-item readiness
 *   node scripts/rolloutBatchTwins.js --commit   # create twins + BOMs + revals
 *
 * Prints the RAW_FG_ITEM_MAP / PRODUCT_CATALOG id changes to apply afterward.
 */
process.env.MES_DRY_RUN = 'false'
const core = require('../clients/coreClient')
const reval = require('../services/costRevaluationService')

const COMMIT = process.argv.includes('--commit')

// [sourceItemId, RAW_FG_ITEM_MAP key]. A2 4% (8370) piloted in SANDBOX only —
// prod has no twin yet, so it's included here for the prod rollout (idempotent).
const SOURCES = [
  [5415, 'Raw conventional 1%'], [5412, 'Raw conventional 2%'], [5413, 'Raw conventional 3.25%'], [5416, 'Raw conventional 3.5%'],
  [5409, 'Raw organic 1%'], [5410, 'Raw organic 2%'], [5411, 'Raw organic 3.25%'], [5401, 'Raw organic 3.5%'],
  [8366, 'Raw organic A2 1%'], [8367, 'Raw organic A2 2%'], [8368, 'Raw organic A2 3.25%'], [8369, 'Raw organic A2 3.5%'],
  [8370, 'Raw organic A2 4%'],
]

async function sql(q) { const r = await core.netsuitePost('/query/v1/suiteql', { q }); return r?.items || r?.body?.items || [] }
const refId = v => (v && v.id != null ? { id: String(v.id) } : undefined)
const REF_FIELDS = ['assetAccount','cogsAccount','incomeAccount','wipAcct','scrapAcct','billPriceVarianceAcct','billQtyVarianceAcct','prodPriceVarianceAcct','prodQtyVarianceAcct','purchasePriceVarianceAcct','custReturnVarianceAccount','unbuildVarianceAccount','vendReturnVarianceAccount','taxSchedule','costCategory','currency','unitsType','costEstimateType','atpMethod','supplyReplenishmentMethod','weightUnit','customForm','custitem6']
const SCALAR_FIELDS = ['baseUnit','stockUnit','purchaseUnit','saleUnit','consumptionUnit','costEstimateUnits','transferPriceUnits','weightUnits','weight','includeChildren','useBins']
const postId = res => res?.id || res?.body?.id || (res?.headers?.location && String(res.headers.location).match(/\/(\d+)$/)?.[1]) || null

async function sourceRecipe(src) {
  const bom = src?.billOfMaterials?.items || []
  const chosen = bom.find(r => r.masterDefault || r.bomDefault) || bom[0]
  if (!chosen) return []
  let revId = chosen?.currentRevision?.id
  if (!revId && chosen?.billOfMaterials?.id) revId = (await sql(`SELECT id FROM bomrevision WHERE billofmaterials = ${chosen.billOfMaterials.id} ORDER BY id DESC`))[0]?.id
  return revId ? sql(`SELECT item, quantity, bomquantity, componentyield FROM bomrevisioncomponent WHERE bomrevision = ${revId}`) : []
}

async function processOne(sourceId, key) {
  // 1) read source (catches permission blocks)
  let src
  try { src = (await core.netsuiteGet(`/record/v1/assemblyItem/${sourceId}?expandSubResources=true`))?.body }
  catch (e) {
    const perm = /Permission Violation/i.test(e.message)
    return { sourceId, key, status: perm ? 'BLOCKED (role permission)' : `ERROR reading source: ${e.message.slice(0, 80)}` }
  }
  const twinName = `${src.itemId} (Batch)`

  // 2) idempotency: existing twin?
  const existing = (await sql(`SELECT id FROM item WHERE itemid = '${twinName.replace(/'/g, "''")}'`))[0]
  if (existing) return { sourceId, key, twinId: existing.id, status: 'exists (skipped)' }

  const recipe = await sourceRecipe(src)
  if (!recipe.length) return { sourceId, key, status: 'NO RECIPE on source BOM — needs manual setup' }

  if (!COMMIT) return { sourceId, key, status: 'ready', twinName, recipe: recipe.map(c => `${c.item}×${c.quantity}`).join(' + ') }

  // 3) create twin item
  const itemBody = { itemId: twinName, description: `${src.itemId} — lot-tracked batch-tank version`, itemType: { id: 'Assembly' }, costingMethod: { id: 'STANDARD' }, isLotItem: true, subsidiary: { items: [{ id: '3' }] }, custitem_sun_mesclass: { id: '1' } }
  for (const f of REF_FIELDS) { const r = refId(src[f]); if (r) itemBody[f] = r }
  for (const f of SCALAR_FIELDS) { if (src[f] != null) itemBody[f] = src[f] }
  const twinId = postId(await core.netsuitePost('/record/v1/assemblyItem', itemBody))

  // 4) bom + revision + attach
  const bomId = postId(await core.netsuitePost('/record/v1/bom', { name: twinName, availableForAllLocations: true, availableForAllAssemblies: false }))
  const components = recipe.map((c, i) => ({ item: { id: String(c.item) }, quantity: Number(c.quantity), bomQuantity: Number(c.bomquantity ?? c.quantity), componentYield: Number(c.componentyield ?? 100), itemSource: { id: 'STOCK' }, lineId: i + 1 }))
  const revId = postId(await core.netsuitePost('/record/v1/bomRevision', { billOfMaterials: { id: String(bomId) }, name: 'Revision 1', component: { items: components } }))
  await core.netsuitePatch(`/record/v1/bom/${bomId}`, { restrictToAssemblies: { items: [{ id: String(twinId) }] } })
  await core.netsuitePatch(`/record/v1/assemblyItem/${twinId}`, { billOfMaterials: { items: [{ billOfMaterials: { id: String(bomId) }, currentRevision: { id: String(revId) }, masterDefault: true }] } })

  // 5) cost basis
  const rb = await reval.ensureCostBasis({ assemblyItemId: String(twinId) })

  return { sourceId, key, twinId, bomId, revId, unitCost: rb.unitCost, status: 'CREATED' }
}

async function main() {
  console.log(`\n=== batch-twin rollout (${COMMIT ? 'COMMIT' : 'DRY RUN'}) — ${SOURCES.length} sources ===\n`)
  const results = []
  for (const [sourceId, key] of SOURCES) {
    const r = await processOne(sourceId, key).catch(e => ({ sourceId, key, status: `EXCEPTION: ${e.message.slice(0, 100)}` }))
    results.push(r)
    console.log(`${String(r.sourceId).padEnd(5)} ${key.padEnd(24)} → twin ${String(r.twinId || '-').padEnd(6)} ${r.status}${r.recipe ? '  [' + r.recipe + ']' : ''}${r.unitCost != null ? '  cost=' + r.unitCost : ''}`)
  }

  console.log('\n=== RAW_FG_ITEM_MAP changes to apply ===')
  for (const r of results) if (r.twinId) console.log(`  '${r.key}': ${r.twinId},   // was ${r.sourceId}`)
  const blocked = results.filter(r => /BLOCKED|NO RECIPE|ERROR|EXCEPTION/.test(r.status))
  if (blocked.length) {
    console.log('\n=== needs attention ===')
    for (const r of blocked) console.log(`  ${r.sourceId} ${r.key}: ${r.status}`)
  }
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
