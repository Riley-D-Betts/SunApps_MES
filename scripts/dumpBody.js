const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')
async function main(){
  await sequelize.authenticate()
  const row = await db.MesProcessingLog.findOne({ where:{ id: 56900 } })
  console.log('FULL errorMessage:\n', row.errorMessage)
  console.log('\nFULL rejectedBody:\n', JSON.stringify(JSON.parse(row.result).rejectedBody, null, 2))
  await sequelize.close()
}
main().catch(e=>{console.error(e.message);process.exit(1)})
