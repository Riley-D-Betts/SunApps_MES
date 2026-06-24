/**
 * Export the full NS definition (item body + master-BOM recipe) of the items
 * that are missing in production, so they can be faithfully recreated there.
 *
 * RUN THIS WITH .env POINTED AT SANDBOX (where these items exist & are correct):
 *   node scripts/exportNsItemSpec.js            # writes ns-item-spec.json
 *
 * Then point .env at prod and run createMissingNsItems.js to import.
 *
 * Read-only against NS. Captures item type, GL accounts, units, tracking flags,
 * MES class, and the master BOM recipe (component item ids + quantities).
 */
const path = require('path')
const fs   = require('fs')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
const core = require('../clients/coreClient')

// Bucket 1: the 7 missing INPUT items (twin SOURCES + the Horizon H&H raw FG).
// The 13 lot twins are NOT here — they're created from these by
// rolloutBatchTwins.js once these sources exist in prod.
const IDS = [5401, 8366, 8367, 8368, 8369, 8370, 8812]

const OUT = path.resolve(__dirname, '../ns-item-spec.json')

// Mirror the field set the existing twin scripts carry over.
const REF_FIELDS = [
  'assetAccount', 'cogsAccount', 'incomeAccount', 'wipAcct', 'scrapAcct',
  'billPriceVarianceAcct', 'billQtyVarianceAcct', 'prodPriceVarianceAcct',
  'prodQtyVarianceAcct', 'purchasePriceVarianceAcct', 'custReturnVarianceAccount',
  'unbuildVarianceAccount', 'vendReturnVarianceAccount', 'taxSchedule',
  'costCategory', 'currency', 'unitsType', 'costEstimateType', 'atpMethod',
  'supplyReplenishmentMethod', 'weightUnit', 'customForm',
  'custitem_sun_mesclass', 'custitem6',
]
const SCALAR_FIELDS = [
  'baseUnit', 'stockUnit', 'purchaseUnit', 'saleUnit', 'consumptionUnit',
  'costEstimateUnits', 'transferPriceUnits', 'weightUnits', 'weight',
  'includeChildren', 'useBins', 'isLotItem',
]

async function sql(q) {
  const r = await core.netsuitePost('/query/v1/suiteql', { q })
  return r?.items || r?.body?.items || []
}
const refId = v => (v && v.id != null ? { id: String(v.id) } : undefined)

// Try assemblyItem first (has BOM); fall back to inventoryItem.
async function fetchItem(id) {
  try {
    const body = (await core.netsuiteGet(`/record/v1/assemblyItem/${id}?expandSubResources=true`))?.body
    if (body) return { type: 'assemblyItem', body }
  } catch (e) {
    if (!/404|not found|INVALID_KEY|NONEXISTENT/i.test(e.message)) throw e
  }
  const body = (await core.netsuiteGet(`/record/v1/inventoryItem/${id}?expandSubResources=true`))?.body
  return { type: 'inventoryItem', body }
}

async function recipeOf(body) {
  const bom = body?.billOfMaterials?.items || []
  const chosen = bom.find(r => r.masterDefault || r.bomDefault) || bom[0]
  if (!chosen) return []
  let revId = chosen?.currentRevision?.id
  if (!revId && chosen?.billOfMaterials?.id)
    revId = (await sql(`SELECT id FROM bomrevision WHERE billofmaterials = ${chosen.billOfMaterials.id} ORDER BY id DESC`))[0]?.id
  return revId
    ? sql(`SELECT item, quantity, bomquantity, componentyield FROM bomrevisioncomponent WHERE bomrevision = ${revId}`)
    : []
}

async function main() {
  console.log(`Exporting ${IDS.length} item specs from ${process.env.CORE_API_URL} (expect SANDBOX)\n`)
  const specs = []
  for (const id of IDS) {
    try {
      const { type, body } = await fetchItem(id)
      if (!body) { console.log(`  ✗ ${id} — not found`); continue }
      const fields = {}
      for (const f of REF_FIELDS) { const r = refId(body[f]); if (r) fields[f] = r }
      const scalars = {}
      for (const f of SCALAR_FIELDS) if (body[f] != null) scalars[f] = body[f]
      const recipe = type === 'assemblyItem' ? await recipeOf(body) : []
      specs.push({
        sandboxId: id,
        type,
        itemId: body.itemId,
        displayName: body.displayName || null,
        description: body.description || `${body.itemId}`,
        costingMethod: body.costingMethod?.id ? { id: body.costingMethod.id } : undefined,
        fields,
        scalars,
        recipe: recipe.map(c => ({
          item: Number(c.item),
          quantity: Number(c.quantity),
          bomQuantity: Number(c.bomquantity ?? c.quantity),
          componentYield: Number(c.componentyield ?? 100),
        })),
      })
      console.log(`  ✓ ${id} "${body.itemId}" [${type}] lot=${body.isLotItem} bins=${body.useBins} recipe=${recipe.length} comp(s)`)
    } catch (e) {
      console.log(`  ✗ ${id} — ${e.message.slice(0, 120)}`)
    }
  }
  fs.writeFileSync(OUT, JSON.stringify(specs, null, 2))
  console.log(`\nWrote ${specs.length} specs → ${OUT}`)
  console.log('Next: point .env at PROD, then `node scripts/createMissingNsItems.js` (dry run) → review → `--commit`.')
}

main().then(() => process.exit(0)).catch(e => { console.error('FAILED:', e.message); process.exit(1) })
