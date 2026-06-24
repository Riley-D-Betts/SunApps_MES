/**
 * Create the missing INPUT items in production from the spec exported by
 * exportNsItemSpec.js (run against sandbox first).
 *
 * RUN THIS WITH .env POINTED AT PROD:
 *   node scripts/createMissingNsItems.js            # DRY RUN: print bodies + checks
 *   node scripts/createMissingNsItems.js --commit   # create item + BOM in prod
 *
 * For each spec it:
 *   1. Skips if an item with the same itemId already exists in prod (idempotent).
 *   2. Verifies every BOM component id exists in prod (won't post a broken BOM).
 *   3. Creates the assembly/inventory item (subsidiary forced to 3 / Ida Milk).
 *   4. For assemblies: creates bom + revision, restricts it to the new item,
 *      attaches it as masterDefault, then seeds a cost basis.
 *   5. Prints sandboxId → new prod id so the code maps can be updated.
 *
 * Does NOT create the 13 lot twins — run rolloutBatchTwins.js --commit after
 * this (its sources will now exist), then enableBinTrackingOnTwins.js --commit.
 */
const path = require('path')
const fs   = require('fs')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
const core  = require('../clients/coreClient')
const reval = require('../services/costRevaluationService')

const SPEC   = path.resolve(__dirname, '../ns-item-spec.json')
const COMMIT = process.argv.includes('--commit')

async function sql(q) {
  const r = await core.netsuitePost('/query/v1/suiteql', { q })
  return r?.items || r?.body?.items || []
}
const postId = res =>
  res?.id || res?.body?.id ||
  (res?.headers?.location && String(res.headers.location).match(/\/(\d+)$/)?.[1]) || null

async function existingId(itemId) {
  const rows = await sql(`SELECT id FROM item WHERE itemid = '${String(itemId).replace(/'/g, "''")}'`)
  return rows[0]?.id || null
}

// Which BOM component ids are absent in prod (would make the BOM invalid).
async function missingComponents(recipe) {
  if (!recipe.length) return []
  const ids = [...new Set(recipe.map(c => c.item))]
  const rows = await sql(`SELECT id FROM item WHERE id IN (${ids.join(',')})`)
  const present = new Set(rows.map(r => Number(r.id)))
  return ids.filter(id => !present.has(Number(id)))
}

async function processOne(spec) {
  const existing = await existingId(spec.itemId)
  if (existing) return { ...res(spec), prodId: existing, status: 'exists (skipped)' }

  const missing = await missingComponents(spec.recipe)
  if (missing.length) return { ...res(spec), status: `BLOCKED — BOM components missing in prod: ${missing.join(', ')}` }

  const endpoint = spec.type === 'inventoryItem' ? 'inventoryItem' : 'assemblyItem'
  const itemBody = {
    itemId: spec.itemId,
    description: spec.description,
    subsidiary: { items: [{ id: '3' }] }, // Ida Milk
    ...spec.fields,
    ...spec.scalars,
  }
  if (endpoint === 'assemblyItem') {
    itemBody.itemType = { id: 'Assembly' }
    if (spec.costingMethod) itemBody.costingMethod = spec.costingMethod
  }

  if (!COMMIT) {
    return { ...res(spec), status: 'ready', preview: itemBody, components: spec.recipe.length }
  }

  // 1) item
  const newId = postId(await core.netsuitePost(`/record/v1/${endpoint}`, itemBody))
  if (!newId) return { ...res(spec), status: 'ERROR — no id returned from item create' }

  // 2) BOM (assemblies with a recipe only)
  let bomId = null, revId = null, unitCost = null
  if (endpoint === 'assemblyItem' && spec.recipe.length) {
    bomId = postId(await core.netsuitePost('/record/v1/bom', {
      name: spec.itemId, availableForAllLocations: true, availableForAllAssemblies: false,
    }))
    const components = spec.recipe.map((c, i) => ({
      item: { id: String(c.item) },
      quantity: Number(c.quantity),
      bomQuantity: Number(c.bomQuantity ?? c.quantity),
      componentYield: Number(c.componentYield ?? 100),
      itemSource: { id: 'STOCK' },
      lineId: i + 1,
    }))
    revId = postId(await core.netsuitePost('/record/v1/bomRevision', {
      billOfMaterials: { id: String(bomId) }, name: 'Revision 1', component: { items: components },
    }))
    await core.netsuitePatch(`/record/v1/bom/${bomId}`, { restrictToAssemblies: { items: [{ id: String(newId) }] } })
    await core.netsuitePatch(`/record/v1/assemblyItem/${newId}`, {
      billOfMaterials: { items: [{ billOfMaterials: { id: String(bomId) }, currentRevision: { id: String(revId) }, masterDefault: true }] },
    })
    try { unitCost = (await reval.ensureCostBasis({ assemblyItemId: String(newId) }))?.unitCost ?? null }
    catch (e) { unitCost = `reval failed: ${e.message.slice(0, 60)}` }
  }

  return { ...res(spec), prodId: newId, bomId, revId, unitCost, status: 'CREATED' }
}

const res = spec => ({ sandboxId: spec.sandboxId, itemId: spec.itemId, type: spec.type })

async function main() {
  if (!fs.existsSync(SPEC)) { console.error(`Missing ${SPEC}. Run exportNsItemSpec.js against sandbox first.`); process.exit(1) }
  const specs = JSON.parse(fs.readFileSync(SPEC, 'utf8'))
  console.log(`\n=== create missing items (${COMMIT ? 'COMMIT' : 'DRY RUN'}) — ${specs.length} from spec — target ${process.env.CORE_API_URL} ===\n`)

  const out = []
  for (const spec of specs) {
    const r = await processOne(spec).catch(e => ({ ...res(spec), status: `EXCEPTION: ${e.message.slice(0, 120)}` }))
    out.push(r)
    console.log(`${String(r.sandboxId).padEnd(5)} ${String(r.itemId).padEnd(28)} ${String(r.type).padEnd(13)} → prod ${String(r.prodId || '-').padEnd(6)} ${r.status}${r.unitCost != null ? '  cost=' + r.unitCost : ''}`)
    if (!COMMIT && r.preview) console.log(`        body: ${JSON.stringify(r.preview)}  (+${r.components} BOM comp)`)
  }

  const created = out.filter(r => r.prodId)
  if (created.length) {
    console.log('\n=== sandboxId → prod id (apply these remaps in code) ===')
    for (const r of created) console.log(`  ${r.sandboxId} → ${r.prodId}   "${r.itemId}"`)
  }
  const blocked = out.filter(r => /BLOCKED|ERROR|EXCEPTION/.test(r.status))
  if (blocked.length) {
    console.log('\n=== needs attention ===')
    for (const r of blocked) console.log(`  ${r.sandboxId} "${r.itemId}": ${r.status}`)
  }
  if (COMMIT) console.log('\nNEXT: rolloutBatchTwins.js --commit (sources now exist) → update RAW_FG_ITEM_MAP → enableBinTrackingOnTwins.js --commit → verifyNsReferences.js (re-check).')
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1) })
