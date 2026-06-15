// SANDBOX shape test: does source inventoryStatus decide whether NS accepts the
// assemblyUnbuild? Two small (100 lb) unbuilds of 5404 -> cream(5483)+skim(5410),
// components identical (with inventoryStatus); only the SOURCE status is toggled.
const core = require('../clients/coreClient')

function body(withSourceStatus) {
  const srcItem = { quantity: 100, binnumber: { id: 4931 } }
  if (withSourceStatus) srcItem.inventoryStatus = { id: 1 }
  return {
    item: { id: 5404 },
    quantity: 100,
    location: { id: 30 },
    subsidiary: { id: 3 },
    billOfMaterials: { id: 348 },
    custbody_milk_transfer_name: 'SHAPE TEST (delete me)',
    inventoryDetail: { inventoryAssignment: { items: [srcItem] } },
    component: { items: [
      { item: 5483, quantity: 11, componentInventoryDetail: { inventoryAssignment: { items: [{ quantity: 11, binnumber: { id: 4928 }, inventoryStatus: { id: 1 } }] } } },
      { item: 5410, quantity: 87, componentInventoryDetail: { inventoryAssignment: { items: [{ quantity: 87, binnumber: { id: 4934 }, inventoryStatus: { id: 1 } }] } } },
    ] },
  }
}

async function tryPost(label, withSourceStatus) {
  try {
    const r = await core.netsuitePost('/record/v1/assemblyUnbuild', body(withSourceStatus))
    const id = r?.body?.id || r?.id || (r?.headers?.location||'').match(/\/(\d+)/)?.[1]
    console.log(`${label}: ✅ ACCEPTED  nsId=${id}`)
  } catch (e) {
    const m = (e.message||'').match(/"detail":"([^"]+)"/)
    console.log(`${label}: ❌ REJECTED  ${m ? m[1] : e.message.slice(0,200)}`)
  }
}

async function main() {
  console.log('CONTROL  — source WITHOUT inventoryStatus (expect reject "must be 100"):')
  await tryPost('  control', false)
  console.log('\nFIX      — source WITH inventoryStatus (expect accept):')
  await tryPost('  fix', true)
}
main().then(()=>process.exit(0)).catch(e=>{console.error('FAILED:',e.message);process.exit(1)})
