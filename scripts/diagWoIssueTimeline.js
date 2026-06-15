const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

const WO = process.argv[2]

async function main() {
  await sequelize.authenticate()
  const rows = await db.MesProcessingLog.findAll({
    where: { sourceId: WO, eventType: { [Op.like]: 'blend_tank%' } },
    order: [['createdAt', 'ASC']],
  })
  console.log(`WO ${WO}: ${rows.length} blend_tank events`)
  for (const r of rows) {
    const tag = r.success ? 'OK ' : 'ERR'
    const short = (r.errorMessage || '').replace(/\s+/g, ' ').slice(0, 90)
    console.log(`${tag} ${r.createdAt.toISOString()} ${r.eventType} ${short}`)
  }
  await sequelize.close()
}
main().catch(e => { console.error(e); process.exit(1) })
