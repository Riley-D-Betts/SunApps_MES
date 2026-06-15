const core = require('../clients/coreClient')
async function q(sql){ const r = await core.netsuitePost('/query/v1/suiteql', { q: sql }); return r?.body?.items || r?.items || [] }
function body(srcQty){ const cream=Math.round(srcQty*0.106*100)/100, skim=Math.round((srcQty-cream)*100)/100;
  return { item:{id:5404}, quantity:srcQty, location:{id:30}, subsidiary:{id:3}, billOfMaterials:{id:348},
    custbody_milk_transfer_name:'SLACK TEST',
    inventoryDetail:{ inventoryAssignment:{ items:[{ quantity:srcQty, binnumber:{id:4931}, inventoryStatus:{id:1} }] } },
    component:{ items:[
      { item:5483, quantity:cream, componentInventoryDetail:{ inventoryAssignment:{ items:[{ quantity:cream, binnumber:{id:4928}, inventoryStatus:{id:1} }] } } },
      { item:5410, quantity:skim,  componentInventoryDetail:{ inventoryAssignment:{ items:[{ quantity:skim,  binnumber:{id:4934}, inventoryStatus:{id:1} }] } } },
    ] } } }
async function t(slack, avail){ const qty=Math.round((avail-slack)*100)/100;
  try{ await core.netsuitePost('/record/v1/assemblyUnbuild', body(qty)); console.log(`slack=${slack}: qty=${qty} -> ✅ ACCEPTED (consumed!)`); return true }
  catch(e){ const m=(e.message||'').match(/"detail":"([^"]+)"/); console.log(`slack=${slack}: qty=${qty} -> ❌ ${m?m[1]:e.message.slice(0,80)}`); return false } }
async function main(){
  const bal = await q(`SELECT quantityavailable FROM inventorybalance WHERE item=5404 AND location=30 AND binnumber=4931`)
  const avail = parseFloat(bal[0]?.quantityavailable||'0'); console.log(`available=${avail}\n`)
  for (const slack of [5, 100, 1000, 10000, 50000]) { if (await t(slack, avail)) break }
}
main().then(()=>process.exit(0)).catch(e=>{console.error('FAILED:',e.message);process.exit(1)})
