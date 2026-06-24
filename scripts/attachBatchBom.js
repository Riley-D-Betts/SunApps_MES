/**
 * Create + attach a master BOM to a lot-tracked batch twin, copying the recipe
 * (raw blend components) from a source item's existing master BOM.
 *
 *   node scripts/attachBatchBom.js <newItemId> <sourceItemId> [--commit]
 *   node scripts/attachBatchBom.js 8928 8370 --commit
 */
const core = require('../clients/coreClient')

const NEW_ITEM = process.argv[2]
const SOURCE = process.argv[3]
const COMMIT = process.argv.includes('--commit')
if (!NEW_ITEM || !SOURCE) { console.error('usage: attachBatchBom.js <newItemId> <sourceItemId> [--commit]'); process.exit(1) }

async function sql(q) {
  const r = await core.netsuitePost('/query/v1/suiteql', { q })
  return r?.items || r?.body?.items || []
}

async function sourceRecipe(sourceItemId) {
  const bomRows = (await core.netsuiteGet(`/record/v1/assemblyItem/${sourceItemId}?expandSubResources=true`))
    ?.body?.billOfMaterials?.items || []
  const chosen = bomRows.find(r => r.masterDefault || r.bomDefault) || bomRows[0]
  let revId = chosen?.currentRevision?.id
  if (!revId && chosen?.billOfMaterials?.id) {
    revId = (await sql(`SELECT id FROM bomrevision WHERE billofmaterials = ${chosen.billOfMaterials.id} ORDER BY id DESC`))[0]?.id
  }
  return sql(`SELECT item, quantity, bomquantity, componentyield FROM bomrevisioncomponent WHERE bomrevision = ${revId}`)
}

async function main() {
  const itemName = (await core.netsuiteGet(`/record/v1/assemblyItem/${NEW_ITEM}?fields=itemId`))?.body?.itemId || `item ${NEW_ITEM}`
  const recipe = await sourceRecipe(SOURCE)
  console.log(`attaching BOM to ${NEW_ITEM} "${itemName}", recipe: ${recipe.map(c => `${c.item}×${c.quantity}`).join(' + ')}`)

  // The bom's `assembly` sublist is static (can't be set on create) — the
  // assembly↔BOM link is made from the item side (assemblyItem.billOfMaterials),
  // PATCHed in after the bom + revision exist.
  const bomBody = {
    name: `${itemName}`,
    availableForAllLocations: true,
    availableForAllAssemblies: false,
  }
  const revComponents = recipe.map((c, i) => ({
    item: { id: String(c.item) },
    quantity: Number(c.quantity),
    bomQuantity: Number(c.bomquantity ?? c.quantity),
    componentYield: Number(c.componentyield ?? 100),
    itemSource: { id: 'STOCK' },
    lineId: i + 1,
  }))

  console.log('\n--- bom POST body ---\n' + JSON.stringify(bomBody, null, 1))
  console.log('\n--- bomRevision.component items ---\n' + JSON.stringify(revComponents, null, 1))
  if (!COMMIT) { console.log('\nDRY RUN — pass --commit to create.'); return }

  // 1) bom
  const bomRes = await core.netsuitePost('/record/v1/bom', bomBody)
  let bomId = bomRes?.id || bomRes?.body?.id
  if (!bomId && bomRes?.headers?.location) { const m = String(bomRes.headers.location).match(/\/(\d+)$/); if (m) bomId = m[1] }
  console.log(`✓ bom ${bomId} (status ${bomRes?.status})`)

  // 2) bomRevision with components
  const revBody = { billOfMaterials: { id: String(bomId) }, name: 'Revision 1', component: { items: revComponents } }
  const revRes = await core.netsuitePost('/record/v1/bomRevision', revBody)
  let revId = revRes?.id || revRes?.body?.id
  if (!revId && revRes?.headers?.location) { const m = String(revRes.headers.location).match(/\/(\d+)$/); if (m) revId = m[1] }
  console.log(`✓ bomRevision ${revId} (status ${revRes?.status})`)

  // 3) associate the bom to the assembly item (item-side billOfMaterials sublist)
  const patchBody = {
    billOfMaterials: {
      items: [{ billOfMaterials: { id: String(bomId) }, currentRevision: { id: String(revId) }, masterDefault: true }],
    },
  }
  const patchRes = await core.netsuitePatch(`/record/v1/assemblyItem/${NEW_ITEM}`, patchBody)
  console.log(`✓ associated bom ${bomId} to item ${NEW_ITEM} (status ${patchRes?.status})`)

  // 4) verify the item now sees the BOM
  const check = (await core.netsuiteGet(`/record/v1/assemblyItem/${NEW_ITEM}?expandSubResources=true`))?.body?.billOfMaterials?.items || []
  console.log(`\nitem ${NEW_ITEM} billOfMaterials now: ${JSON.stringify(check.map(r => ({ bom: r.billOfMaterials?.id, rev: r.currentRevision?.id, masterDefault: r.masterDefault })))}`)
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
