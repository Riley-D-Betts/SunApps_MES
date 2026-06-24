/**
 * Pull recent NS-transaction failures + surge batch errorMessages around
 * 2026-05-22 08:40 / 09:20 (when tick.error events fired on the dashboard).
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

async function main() {
  await sequelize.authenticate()

  // Time window: 06:00 - 10:00 local on 2026-05-22
  const since = new Date('2026-05-22T06:00:00')
  const until = new Date('2026-05-22T10:30:00')

  console.log(`\n=== MesProcessingLog failures between ${since.toISOString()} and ${until.toISOString()} ===`)
  const logs = await db.MesProcessingLog.findAll({
    where: {
      success: false,
      createdAt: { [Op.between]: [since, until] },
    },
    order: [['createdAt', 'DESC']],
    limit: 50,
  })
  console.log(`(${logs.length} rows)`)
  for (const row of logs) {
    console.log(`\n--- id=${row.id} at ${row.createdAt.toISOString()} ---`)
    console.log(`eventType=${row.eventType}  sourceId=${row.sourceId}  nsTx=${row.nsTransactionType}/${row.nsTransactionId}`)
    console.log(`errorMessage: ${row.errorMessage}`)
    if (row.payload) {
      const p = row.payload.length > 2000 ? row.payload.slice(0, 2000) + '…(truncated)' : row.payload
      console.log(`payload: ${p}`)
    }
    if (row.result) {
      const r = row.result.length > 2000 ? row.result.slice(0, 2000) + '…(truncated)' : row.result
      console.log(`result: ${r}`)
    }
  }

  console.log(`\n\n=== MesSurgeTankBatches with errorMessage (last 24h) ===`)
  const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const surgeRows = await db.MesSurgeTankBatch.findAll({
    where: {
      errorMessage: { [Op.ne]: null },
      [Op.or]: [
        { detectedAt: { [Op.gte]: dayAgo } },
        { lastIssueAt: { [Op.gte]: dayAgo } },
      ],
    },
    order: [['detectedAt', 'DESC']],
    limit: 25,
  })
  console.log(`(${surgeRows.length} rows)`)
  for (const b of surgeRows) {
    console.log(`\n--- batch id=${b.id} ${b.tankId} "${b.productName}" status=${b.status} ---`)
    console.log(`WO=${b.nsWorkOrderNumber || b.nsWorkOrderId}  detectedAt=${b.detectedAt?.toISOString()}`)
    console.log(`lastIssueAt=${b.lastIssueAt?.toISOString() || '-'}  lastCompletionAt=${b.lastCompletionAt?.toISOString() || '-'}`)
    console.log(`cumIssued=${b.cumulativeIssuedLbs}  cumCompleted=${b.cumulativeCompletedLbs}`)
    console.log(`errorMessage: ${b.errorMessage}`)
  }

  // Also pull both active surge batches' current state — these are the ones
  // the ticks are actually firing against.
  console.log(`\n\n=== Currently active MesSurgeTankBatches ===`)
  const active = await db.MesSurgeTankBatch.findAll({
    where: { status: 'active' },
    order: [['detectedAt', 'DESC']],
  })
  for (const b of active) {
    console.log(`\n--- ST=${b.tankId} batch=${b.id} "${b.productName}" ---`)
    console.log(`WO=${b.nsWorkOrderNumber || b.nsWorkOrderId} (id=${b.nsWorkOrderId})`)
    console.log(`mesItem=${b.mesItem}  componentItemId=${b.componentItemId}  componentBinId=${b.componentBinId}`)
    console.log(`feedingUhtId=${b.feedingUhtId}  feedingFromEntName=${b.feedingFromEntName}`)
    console.log(`pairingStatus=${b.pairingStatus}  layerSkipReason=${b.layerSkipReason}`)
    console.log(`cumIssued=${b.cumulativeIssuedLbs}  cumCompleted=${b.cumulativeCompletedLbs}`)
    console.log(`detectedAt=${b.detectedAt?.toISOString()}  lastIssueAt=${b.lastIssueAt?.toISOString() || '-'}`)
    console.log(`errorMessage=${b.errorMessage || '-'}`)
  }

  // Pull the surge issue states to see whether the per-tank state is moving.
  console.log(`\n\n=== Surge issue states ===`)
  const states = await db.MesSurgeTankIssueState.findAll()
  for (const s of states) {
    console.log(`batch=${s.surgeTankBatchId}  uhtId=${s.uhtId}  lastIssuedUhtGal=${s.lastIssuedUhtGal}  lastTotalizerGal=${s.lastTotalizerGal}  lastObservedAt=${s.lastObservedAt?.toISOString()}  lastFromEnt=${s.lastFromEntName}`)
  }

  await sequelize.close()
}

main().catch(err => {
  console.error('FAILED:', err)
  process.exit(1)
})
