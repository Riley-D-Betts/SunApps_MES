const { sequelize } = require('../config')
const db = require('../models')
const core = require('../clients/coreClient')
async function q(sql){ const r = await core.netsuitePost('/query/v1/suiteql', { q: sql }); return r?.body?.items || r?.items || [] }
async function avail(){ const b=await q(`SELECT quantityavailable FROM inventorybalance WHERE item=5404 AND location=30 AND binnumber=4931`); return parseFloat(b[0]?.quantityavailable||'0') }
async function main(){
  await sequelize.authenticate()
  const a1 = await avail(); console.log(`available now      = ${a1}`)
  await new Promise(r=>setTimeout(r, 8000))
  const a2 = await avail(); console.log(`available +8s      = ${a2}  (Δ ${(a2-a1).toFixed(2)})`)
  // recent sweep/shortfall adjustments touching 5404 @ 4931
  const adj = await db.MesInventoryAdjustment.findAll({ where:{ itemId:'5404', binId:4931 }, order:[['id','DESC']], limit:8 })
  console.log('\nrecent 5404@4931 adjustments:')
  for (const r of adj){ const j=r.toJSON(); console.log(`  id=${j.id} ${new Date(j.createdAt).toISOString()} source=${j.source} Δ=${j.qtyDelta} status=${j.status}`) }
  await sequelize.close()
}
main().catch(e=>{console.error(e.message);process.exit(1)})
