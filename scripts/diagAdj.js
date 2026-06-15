const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')
async function main() {
  await sequelize.authenticate()
  if (!db.MesInventoryAdjustment) { console.log('no MesInventoryAdjustment model'); return process.exit(0) }
  // recent adjustments for source item 5404 and/or bin 4931
  const rows = await db.MesInventoryAdjustment.findAll({
    where: { [Op.or]: [{ itemId: '5404' }, { itemId: 5404 }, { binId: 4931 }] },
    order: [['id', 'DESC']],
    limit: 12,
  })
  console.log(`${rows.length} adjustment rows (item 5404 or bin 4931):`)
  for (const r of rows) {
    const j = r.toJSON()
    console.log(`\nid=${j.id} ${j.createdAt ? new Date(j.createdAt).toISOString() : ''} source=${j.source} item=${j.itemId} bin=${j.binId} Δ=${j.qtyDelta} status=${j.status} lot=${j.lotName||j.lotId||'-'}`)
    if (j.errorMessage) console.log(`   err: ${String(j.errorMessage).slice(0,300)}`)
  }
  await sequelize.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
