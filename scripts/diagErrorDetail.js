/**
 * Dump full payload/result for one example of each interesting error signature.
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

const IDS = process.argv.slice(2).map(Number)

async function main() {
  await sequelize.authenticate()
  const rows = await db.MesProcessingLog.findAll({ where: { id: { [Op.in]: IDS } } })
  for (const row of rows) {
    console.log(`\n\n========== id=${row.id} ${row.createdAt.toISOString()} ==========`)
    console.log(`eventType=${row.eventType} sourceId=${row.sourceId} nsTx=${row.nsTransactionType}/${row.nsTransactionId} success=${row.success}`)
    console.log(`--- errorMessage ---\n${row.errorMessage}`)
    console.log(`--- payload ---\n${row.payload || '(none)'}`)
    console.log(`--- result ---\n${row.result || '(none)'}`)
  }
  await sequelize.close()
}
main().catch(e => { console.error(e); process.exit(1) })
