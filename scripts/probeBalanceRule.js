// Find NS's assemblyUnbuild rule: how close must (cream+skim) be to source qty?
// Small-scale so we don't drain bin 4931 (has ~500k of 5404).
const core = require('../clients/coreClient')
function body(srcQty, cream, skim) {
  return { item:{id:5404}, quantity:srcQty, location:{id:30}, subsidiary:{id:3}, billOfMaterials:{id:348},
    custbody_milk_transfer_name:'BALANCE RULE TEST',
    inventoryDetail:{ inventoryAssignment:{ items:[{ quantity:srcQty, binnumber:{id:4931}, inventoryStatus:{id:1} }] } },
    component:{ items:[
      { item:5483, quantity:cream, componentInventoryDetail:{ inventoryAssignment:{ items:[{ quantity:cream, binnumber:{id:4928}, inventoryStatus:{id:1} }] } } },
      { item:5410, quantity:skim,  componentInventoryDetail:{ inventoryAssignment:{ items:[{ quantity:skim,  binnumber:{id:4934}, inventoryStatus:{id:1} }] } } },
    ] } }
}
async function t(label, srcQty, cream, skim) {
  const gap = srcQty-(cream+skim), pct=(gap/srcQty*100).toFixed(2)
  try { await core.netsuitePost('/record/v1/assemblyUnbuild', body(srcQty,cream,skim)); console.log(`${label}: src=${srcQty} comp=${cream+skim} gap=${gap}(${pct}%) -> ✅ ACCEPTED`) }
  catch(e){ const m=(e.message||'').match(/"detail":"([^"]+)"/); console.log(`${label}: src=${srcQty} comp=${cream+skim} gap=${gap}(${pct}%) -> ❌ ${m?m[1]:e.message.slice(0,80)}`) }
}
async function main(){
  await t('exact ', 1000, 106, 894)     // gap 0
  await t('gap2%  ', 1000, 106, 874)    // gap 20 (2%)
  await t('gap0.5%', 1000, 106, 889)    // gap 5 (0.5%)
  await t('gap10% ', 1000, 106, 794)    // gap 100 (10%)
}
main().then(()=>process.exit(0)).catch(e=>{console.error('FAILED:',e.message);process.exit(1)})
