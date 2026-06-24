/**
 * Did the 13:38 ML3 line.flowComplete fire an issue on WO1402?
 * Pulls: BT2B "marcels 1%" batch row, MesBlendTankInflow rows for ML3 around
 * 13:30-13:45, and MesProcessingLog entries for that WO.
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

async function main() {
  await sequelize.authenticate()

  // 13:38 local MDT = 19:38 UTC on 2026-05-22
  const since = new Date('2026-05-22T18:00:00Z')
  const until = new Date('2026-05-22T21:00:00Z')

  console.log(`\n=== BT2B active batch (marcels 1%) ===`)
  const batch = await db.MesBlendTankBatch.findOne({
    where: { tankId: 'BlendTank2B', status: 'active' },
    order: [['detectedAt', 'DESC']],
  })
  if (batch) {
    console.log(`batch=${batch.id} "${batch.productName}" status=${batch.status}  WO=${batch.nsWorkOrderNumber} (${batch.nsWorkOrderId})`)
    console.log(`detectedAt=${batch.detectedAt?.toISOString()}  lastIssueAt=${batch.lastIssueAt?.toISOString() || '-'}  lastCompletionAt=${batch.lastCompletionAt?.toISOString() || '-'}`)
    console.log(`cumIssued=${batch.cumulativeIssuedLbs}  cumCompleted=${batch.cumulativeCompletedLbs}`)
    console.log(`mesItem=${batch.mesItem}`)
  } else {
    console.log('No active BT2B batch found')
  }

  console.log(`\n=== ML3 MesBlendTankInflows ${since.toISOString()} → ${until.toISOString()} ===`)
  const inflows = await db.MesBlendTankInflow.findAll({
    where: {
      line: 'ML3',
      createdAt: { [Op.between]: [since, until] },
    },
    order: [['createdAt', 'DESC']],
    limit: 20,
  })
  console.log(`(${inflows.length} rows)`)
  for (const f of inflows) {
    console.log(`  id=${f.id}  batch=${f.blendTankBatchId}  status=${f.status}  totalLbs=${f.totalLbs}  resetTime=${f.resetTime?.toISOString()}  createdAt=${f.createdAt?.toISOString()}  nsIssueId=${f.nsIssueId || '-'}  destination=${f.destination || '-'}`)
    if (f.errorMessage) console.log(`     error: ${f.errorMessage}`)
  }

  console.log(`\n=== Pipe state ML3 ===`)
  const pipe = await db.MesPipeIssueState.findOne({ where: { line: 'ML3' } })
  if (pipe) {
    console.log(`batchId=${pipe.blendTankBatchId}  lastIssuedTotalizerLbs=${pipe.lastIssuedTotalizerLbs}  lastIssueAt=${pipe.lastIssueAt?.toISOString() || '-'}`)
    console.log(`lastTotalizerLbs=${pipe.lastTotalizerLbs}  lastObservedAt=${pipe.lastObservedAt?.toISOString() || '-'}`)
    console.log(`lastProductName=${pipe.lastProductName}  lastSiloName=${pipe.lastSiloName}`)
  }

  console.log(`\n=== MesProcessingLog for WO1402 / batch ${batch?.id} between ${since.toISOString()} → ${until.toISOString()} ===`)
  const logs = await db.MesProcessingLog.findAll({
    where: {
      [Op.or]: [
        { sourceId: batch?.nsWorkOrderId || '__none__' },
        { sourceId: String(batch?.id || '__none__') },
        { payload: { [Op.like]: `%"batchId":${batch?.id}%` } },
      ],
      createdAt: { [Op.between]: [since, until] },
    },
    order: [['createdAt', 'DESC']],
    limit: 30,
  })
  console.log(`(${logs.length} rows)`)
  for (const row of logs) {
    console.log(`\n--- id=${row.id} at ${row.createdAt.toISOString()}  type=${row.eventType}  success=${row.success}  nsTx=${row.nsTransactionType}/${row.nsTransactionId}`)
    if (row.errorMessage) console.log(`   error: ${row.errorMessage}`)
    if (row.payload) {
      const p = row.payload.length > 1500 ? row.payload.slice(0, 1500) + '…' : row.payload
      console.log(`   payload: ${p}`)
    }
    if (row.result) {
      const r = row.result.length > 800 ? row.result.slice(0, 800) + '…' : row.result
      console.log(`   result: ${r}`)
    }
  }

  console.log(`\n=== Most recent MesProcessingLog entries (any) since ${since.toISOString()} ===`)
  const recent = await db.MesProcessingLog.findAll({
    where: { createdAt: { [Op.gte]: since } },
    order: [['createdAt', 'DESC']],
    limit: 20,
  })
  console.log(`(${recent.length} rows)`)
  for (const r of recent) {
    console.log(`  id=${r.id}  ${r.createdAt.toISOString()}  type=${r.eventType}  src=${r.sourceId}  success=${r.success}  err=${r.errorMessage?.slice(0, 120) || '-'}`)
  }

  await sequelize.close()
}

main().catch(err => { console.error('FAILED:', err); process.exit(1) })
