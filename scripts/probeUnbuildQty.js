// Does "total inventory detail quantity must be N" simply mean: requested more
// than the source bin has available? available now ~499880.03.
const core = require('../clients/coreClient')
async function q(sql){ const r = await core.netsuitePost('/query/v1/suiteql', { q: sql }); return r?.body?.items || r?.items || [] }
function body(qty) {
  return {
    item: { id: 5404 }, quantity: qty, location: { id: 30 }, subsidiary: { id: 3 }, billOfMaterials: { id: 348 },
    custbody_milk_transfer_name: 'QTY TEST (no-commit)',
    inventoryDetail: { inventoryAssignment: { items: [{ quantity: qty, binnumber: { id: 4931 }, inventoryStatus: { id: 1 } }] } },
    component: { items: [
      { item: 5483, quantity: Math.round(qty*0.106), componentInventoryDetail: { inventoryAssignment: { items: [{ quantity: Math.round(qty*0.106), binnumber: { id: 4928 }, inventoryStatus: { id: 1 } }] } } },
      { item: 5410, quantity: Math.round(qty*0.87), componentInventoryDetail: { inventoryAssignment: { items: [{ quantity: Math.round(qty*0.87), binnumber: { id: 4934 }, inventoryStatus: { id: 1 } }] } } },
    ] },
  }
}
async function tryPost(label, qty) {
  try { const r = await core.netsuitePost('/record/v1/assemblyUnbuild', body(qty)); console.log(`${label} qty=${qty}: ✅ ACCEPTED id=${r?.body?.id||r?.id}`) }
  catch (e) { const m=(e.message||'').match(/"detail":"([^"]+)"/); console.log(`${label} qty=${qty}: ❌ ${m?m[1]:e.message.slice(0,160)}`) }
}
async function main() {
  const bal = await q(`SELECT quantityavailable FROM inventorybalance WHERE item=5404 AND location=30 AND binnumber=4931`)
  const avail = parseFloat(bal[0]?.quantityavailable||'0')
  console.log(`bin 4931 available = ${avail}\n`)
  await tryPost('OVER  (avail+5000)', Math.round((avail+5000)*100)/100)
}
main().then(()=>process.exit(0)).catch(e=>{console.error('FAILED:',e.message);process.exit(1)})
