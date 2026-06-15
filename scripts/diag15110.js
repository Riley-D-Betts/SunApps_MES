const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')
const core = require('../clients/coreClient')
async function q(sql){ const r = await core.netsuitePost('/query/v1/suiteql', { q: sql }); return r?.body?.items || r?.items || [] }
async function main() {
  await sequelize.authenticate()
  const row = await db.MesProcessingLog.findOne({
    where: { eventType: 'separation_unbuild', sourceId: { [Op.like]: 'XFR-1780945181147%' } },
    order: [['createdAt', 'DESC']],
  })
  console.log(`Latest unbuild log: id=${row?.id} ${row?.createdAt?.toISOString()} success=${row?.success}`)
  console.log(`err: ${(row?.errorMessage||'').slice(0,260)}`)
  if (row?.result) { try { const b=JSON.parse(row.result).rejectedBody; if(b) console.log(`req qty=${b.quantity} sourceAssign=${JSON.stringify(b.inventoryDetail?.inventoryAssignment?.items)}`) } catch{} }

  console.log('\nRecent adjustments item 5404 bin 4931:')
  const adj = await db.MesInventoryAdjustment.findAll({ where: { itemId: '5404', binId: 4931 }, order:[['id','DESC']], limit:5 })
  for (const a of adj) { const j=a.toJSON(); console.log(`  id=${j.id} ${new Date(j.createdAt).toISOString()} Δ=${j.qtyDelta} status=${j.status}`) }

  const bal = await q(`SELECT quantityonhand, quantityavailable FROM inventorybalance WHERE item=5404 AND location=30 AND binnumber=4931`)
  console.log(`\nbin 4931 5404 now: ${JSON.stringify(bal)}`)
  await sequelize.close()
}
main().catch(e=>{console.error(e.message);process.exit(1)})
