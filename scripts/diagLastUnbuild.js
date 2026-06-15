const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')
async function main() {
  await sequelize.authenticate()
  const row = await db.MesProcessingLog.findOne({
    where: { eventType: 'separation_unbuild', sourceId: { [Op.like]: 'XFR-1780945181147%' } },
    order: [['createdAt', 'DESC']],
  })
  if (!row) { console.log('no row'); return process.exit(0) }
  console.log(`id=${row.id} ${row.createdAt.toISOString()} success=${row.success}`)
  console.log(`errorMessage: ${row.errorMessage}`)
  console.log(`\n--- result (rejectedBody) ---`)
  try { console.log(JSON.stringify(JSON.parse(row.result), null, 2)) }
  catch { console.log(row.result) }
  await sequelize.close()
}
main().catch(e=>{console.error(e);process.exit(1)})
