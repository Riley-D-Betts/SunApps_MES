/**
 * Test data: fire one tiny assemblyUnbuild for each of the 10 separation
 * BOM combos to confirm BOM + matching component item IDs land correctly.
 *
 * Sandbox only — uses 1000 lb source / 100 lb cream / 900 lb skim per call,
 * tagged with transferName so the test rows are easy to find in NS.
 *
 *   node scripts/testBomCombos.js          # dry-run, prints payloads
 *   node scripts/testBomCombos.js --confirm
 */

const core = require('../clients/coreClient')
const itemConfig = require('../services/mesItemConfig')

const confirm = process.argv.includes('--confirm')

const SOURCE_BIN_CONV = 1003   // MSilo3
const SOURCE_BIN_ORG  = 1005   // MSilo4
const CREAM_BIN       = 1008   // CSilo2
const SKIM_BIN        = 1006   // MSilo1

// Each combo: [sourceItemId, skimProductIndex] — keys of SEPARATION_BOM_MAP
const combos = [
  [5417, 1],  // Conv → 3.5%
  [5417, 2],  // Conv → 3.25%
  [5417, 3],  // Conv → 2%
  [5417, 4],  // Conv → 1%
  [5417, 5],  // Conv → Fat Free
  [5404, 6],  // Org → 3.5%
  [5404, 7],  // Org → 3.25%
  [5404, 8],  // Org → 2%
  [5404, 9],  // Org → 1%
  [5404, 10], // Org → Fat Free
]

async function fireOne(sourceItemId, skimProductIndex) {
  const bomId = itemConfig.getSeparationBomId(sourceItemId, skimProductIndex)
  const skimItem = itemConfig.getItemByProductIndex(skimProductIndex)
  const creamItemId = sourceItemId === 5404 ? 5483 : 5480
  const sourceBinId = sourceItemId === 5404 ? SOURCE_BIN_ORG : SOURCE_BIN_CONV

  const sourceQty = 1000
  const creamQty  = 100
  const skimQty   = 900

  const label = `TEST-BOM-${sourceItemId}_${skimProductIndex}`

  const body = {
    item: { id: sourceItemId },
    quantity: sourceQty,
    location: { id: 30 },
    subsidiary: { id: 3 },
    billOfMaterials: { id: bomId },
    custbody_milk_transfer_name: label,
    custbody_milk_destinations: 'TEST',
    inventoryDetail: {
      inventoryAssignment: {
        items: [{ quantity: sourceQty, binnumber: { id: sourceBinId } }],
      },
    },
    component: {
      items: [
        {
          item: creamItemId,
          quantity: creamQty,
          componentInventoryDetail: {
            inventoryAssignment: { items: [{ quantity: creamQty, binnumber: { id: CREAM_BIN } }] },
          },
        },
        {
          item: skimItem.id,
          quantity: skimQty,
          componentInventoryDetail: {
            inventoryAssignment: { items: [{ quantity: skimQty, binnumber: { id: SKIM_BIN } }] },
          },
        },
      ],
    },
  }

  console.log(`\n[${label}]  BOM=${bomId}  cream=${creamItemId}  skim=${skimItem.id} (${skimItem.name})`)
  if (!confirm) {
    console.log('  [dry run]')
    return
  }
  try {
    const result = await core.netsuitePost('/record/v1/assemblyUnbuild', body)
    const locHeader = result?.headers?.location || result?.headers?.Location || ''
    const locId = locHeader.match(/\/(\d+)(?:\?.*)?$/)?.[1] || null
    const id = result?.body?.id || result?.id || locId || '?'
    console.log(`  OK — id=${id}`)
  } catch (err) {
    console.log(`  FAILED: ${err.message}`)
  }
}

async function main() {
  for (const [src, pi] of combos) {
    await fireOne(src, pi)
  }
}

main().catch(err => { console.error(err); process.exitCode = 1 })
