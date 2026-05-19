// One-shot diagnostic: why are BT1A WOs showing 0 lb issued/completed?
// Pulls recent BT1A batches, their inflows, and their processing logs.
const db = require('../models')

async function main() {
  // 1) Recent BT1A batches
  const batches = await db.MesBlendTankBatch.findAll({
    where: { tankId: 'BlendTank1A' },
    order: [['detectedAt', 'DESC']],
    limit: 8,
  })

  console.log('\n=== Recent BT1A batches ===')
  for (const b of batches) {
    console.log(
      `id=${b.id} WO=${b.nsWorkOrderNumber || '-'} (nsId=${b.nsWorkOrderId || '-'}) ` +
      `product="${b.productName}" mesItem=${b.mesItem} conf=${b.parserConfidence} ` +
      `from=${b.fromEntName} to=${b.toEntName} status=${b.status} ` +
      `start=${b.detectedAt?.toISOString?.()} closed=${b.closedAt?.toISOString?.() || '-'} ` +
      `issued=${b.cumulativeIssuedLbs} completed=${b.cumulativeCompletedLbs} ` +
      `lastIssueAt=${b.lastIssueAt?.toISOString?.() || '-'}`
    )
  }

  const batchIds = batches.map(b => b.id)

  // 2) All inflow attempts for those batches
  const inflows = await db.MesBlendTankInflow.findAll({
    where: { blendTankBatchId: batchIds },
    order: [['createdAt', 'DESC']],
    limit: 60,
  })

  console.log(`\n=== Inflows for those batches (${inflows.length} rows) ===`)
  const inflowByStatus = {}
  for (const i of inflows) {
    inflowByStatus[i.status] = (inflowByStatus[i.status] || 0) + 1
    console.log(
      `[${i.createdAt?.toISOString?.()}] batch=${i.blendTankBatchId} ${i.line} ` +
      `${Number(i.totalLbs).toFixed(1)} lb item=${i.nsItemId || '-'} ` +
      `status=${i.status} nsIssue=${i.nsIssueId || '-'} err="${(i.errorMessage || '').slice(0, 120)}"`
    )
  }
  console.log('Inflow status counts:', inflowByStatus)

  // 3) Processing logs for those batches' WOs (tail-catcher / tick / WO creates)
  const woIds = batches.map(b => b.nsWorkOrderId).filter(Boolean)
  if (woIds.length > 0) {
    const logs = await db.MesProcessingLog.findAll({
      where: {
        sourceId: woIds,
        eventType: ['blend_tank_tail_issue', 'blend_tank_tick_issue', 'blend_tank_wo_create', 'blend_tank_wo_end'],
      },
      order: [['createdAt', 'DESC']],
      limit: 80,
    })

    console.log(`\n=== Processing logs for those WOs (${logs.length} rows) ===`)
    const logCounts = {}
    for (const l of logs) {
      const k = `${l.eventType}:${l.success ? 'ok' : 'fail'}`
      logCounts[k] = (logCounts[k] || 0) + 1
      console.log(
        `[${l.createdAt?.toISOString?.()}] WO=${l.sourceId} ${l.eventType} ` +
        `success=${l.success} nsId=${l.nsTransactionId || '-'} ` +
        `err="${(l.errorMessage || '').slice(0, 200)}"`
      )
    }
    console.log('Log counts:', logCounts)
  }

  // 4) Current state of MesPipeIssueState for active BT1A batch
  const activeBT1A = batches.find(b => b.status === 'active')
  if (activeBT1A) {
    const pipes = await db.MesPipeIssueState.findAll({
      where: { blendTankBatchId: activeBT1A.id },
    })
    console.log(`\n=== Pipe state for active BT1A batch id=${activeBT1A.id} (WO ${activeBT1A.nsWorkOrderNumber}) ===`)
    for (const p of pipes) {
      console.log(
        `${p.line}: issued=${p.lastIssuedTotalizerLbs} last=${p.lastTotalizerLbs} ` +
        `product="${p.lastProductName || '-'}" silo="${p.lastSiloName || '-'}" ` +
        `lastIssueAt=${p.lastIssueAt?.toISOString?.() || '-'}`
      )
    }
  }

  await db.sequelize.close()
}

main().catch(err => {
  console.error('Diag failed:', err)
  process.exit(1)
})
