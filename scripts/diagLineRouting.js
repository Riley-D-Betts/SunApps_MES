// What requestedBy values are SCADA writing right now, and what
// 'unmatched' inflows exist that hint at lines pointing at tanks with no batch?
const db = require('../models')
const restProvider = require('../historian/providers/restProvider')

async function main() {
  console.log('=== Current line status (live historian read) ===')
  try {
    const lines = await restProvider.getMilkLineStatus()
    for (const l of lines) {
      console.log(
        `${l.line}: totalizer=${Number(l.totalizerLbs || 0).toFixed(0)} lb ` +
        `product="${l.productName}" silo="${l.siloName}" ` +
        `requestedBy="${l.requestedBy}" target=${l.requestedTargetLbs} ` +
        `mode="${l.mode}" active=${l.active}`
      )
    }
  } catch (err) {
    console.error('Historian read failed:', err.message)
  }

  console.log('\n=== Recent inflows across all tanks (last 50) ===')
  const inflows = await db.MesBlendTankInflow.findAll({
    order: [['createdAt', 'DESC']],
    limit: 50,
  })
  const byStatus = {}
  for (const i of inflows) {
    byStatus[i.status] = (byStatus[i.status] || 0) + 1
  }
  console.log('Status counts:', byStatus)
  for (const i of inflows.slice(0, 30)) {
    console.log(
      `[${i.createdAt?.toISOString?.()}] batch=${i.blendTankBatchId || 'null'} ${i.line} ` +
      `${Number(i.totalLbs).toFixed(1)} lb ingredient="${i.ingredientType}" status=${i.status} ` +
      `err="${(i.errorMessage || '').slice(0, 100)}"`
    )
  }

  console.log('\n=== Recent active batches across all tanks ===')
  const batches = await db.MesBlendTankBatch.findAll({
    where: { status: 'active' },
  })
  for (const b of batches) {
    console.log(
      `tank=${b.tankId} WO=${b.nsWorkOrderNumber} product="${b.productName}" ` +
      `from=${b.fromEntName} to=${b.toEntName} issued=${b.cumulativeIssuedLbs}`
    )
  }

  console.log('\n=== Last 30 batches across all tanks ===')
  const recent = await db.MesBlendTankBatch.findAll({
    order: [['detectedAt', 'DESC']],
    limit: 30,
  })
  for (const b of recent) {
    console.log(
      `[${b.detectedAt?.toISOString?.()}] ${b.tankId} WO=${b.nsWorkOrderNumber || '-'} ` +
      `"${b.productName}" status=${b.status} issued=${b.cumulativeIssuedLbs}`
    )
  }

  await db.sequelize.close()
}

main().catch(err => {
  console.error('Diag failed:', err)
  process.exit(1)
})
