const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')
async function main() {
  await sequelize.authenticate()
  const rows = await db.MesProcessingLog.findAll({
    where: { sourceId: '4863432' },
    order: [['createdAt', 'ASC']],
  })
  console.log(`WO 4863432: ${rows.length} log rows`)
  for (const r of rows) {
    console.log(`\n[${r.createdAt.toISOString()}] ${r.eventType} success=${r.success}`)
    if (r.payload) console.log(`  payload: ${r.payload.slice(0,600)}`)
    if (r.errorMessage) console.log(`  err: ${r.errorMessage.slice(0,200)}`)
  }
  // Also the batch + its inflows to confirm the component item(s)
  const batch = await db.MesBlendTankBatch.findOne({ where: { nsWorkOrderId: '4863432' } })
  if (batch) {
    console.log(`\n=== Batch ${batch.id} ${batch.tankId} "${batch.productName}" status=${batch.status} ===`)
    const inflows = await db.MesBlendTankInflow.findAll({ where: { blendTankBatchId: batch.id }, order:[['id','ASC']] })
    for (const f of inflows) console.log(`  inflow ${f.id} line=${f.line} type=${f.ingredientType} nsItem=${f.nsItemId} bin? lbs=${f.totalLbs} status=${f.status} silo=${f.siloName}`)
  }
  await sequelize.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
