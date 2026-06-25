// Read-only: dump the FULL errorMessage/result/payload for a blend-tank WO's
// failed processing-log rows, against the prod_ table set regardless of local
// ENVIRONMENT. Usage: node scripts/dumpWoErrors.js WO1470 [prod]
const path = require('path')
const dotenv = require('dotenv')
dotenv.config({ path: path.resolve(__dirname, '../.env') })
const { Sequelize, QueryTypes } = require('sequelize')

const woNumber = process.argv[2] || 'WO1470'
const env = (process.argv[3] || 'prod').toLowerCase()
const P = `${env}_`

const sequelize = new Sequelize(
  process.env.SQL_DATABASE, process.env.SQL_USER, process.env.SQL_PASSWORD,
  {
    host: process.env.SQL_SERVER, dialect: 'mssql',
    dialectOptions: { options: { encrypt: true, trustServerCertificate: true } },
    logging: false,
  }
)

;(async () => {
  // Resolve the WO's NS internal id (that's what MesProcessingLog.sourceId holds).
  const batch = await sequelize.query(
    `SELECT TOP 1 id, nsWorkOrderId, nsWorkOrderNumber, tankId, status
       FROM ${P}MesBlendTankBatches WHERE nsWorkOrderNumber = :wo
       ORDER BY id DESC`,
    { replacements: { wo: woNumber }, type: QueryTypes.SELECT }
  )
  if (!batch.length) { console.log(`No ${P}MesBlendTankBatches row for ${woNumber}`); process.exit(0) }
  const b = batch[0]
  console.log(`Batch #${b.id}  ${b.tankId}  ${b.nsWorkOrderNumber}  nsWorkOrderId=${b.nsWorkOrderId}  status=${b.status}\n`)

  const rows = await sequelize.query(
    `SELECT id, eventType, nsTransactionType, nsTransactionId, success, errorMessage, result, payload, createdAt
       FROM ${P}MesProcessingLog
       WHERE sourceId = :sid
       ORDER BY createdAt DESC`,
    { replacements: { sid: String(b.nsWorkOrderId) }, type: QueryTypes.SELECT }
  )
  console.log(`${rows.length} processing-log row(s) for sourceId=${b.nsWorkOrderId}\n`)
  for (const r of rows) {
    console.log('═'.repeat(100))
    console.log(`#${r.id}  ${r.createdAt}  ${r.eventType}  ${r.nsTransactionType}  success=${r.success}  nsTxn=${r.nsTransactionId || '—'}`)
    console.log('\n── errorMessage ──')
    console.log(r.errorMessage || '(none)')
    if (r.result) { console.log('\n── result ──'); console.log(r.result) }
    if (r.payload) { console.log('\n── payload ──'); console.log(r.payload) }
    console.log('')
  }
  await sequelize.close()
})().catch(e => { console.error(e); process.exit(1) })
