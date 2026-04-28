/**
 * Diagnostic: pull the current state of WO 4333064 and any prior WO issue
 * attempts from MesProcessingLog so we can see what shape is actually
 * accepted by NS. Helps debug the "Invalid value for ... 'item'" error
 * the recovery script hit.
 *
 * Usage: node scripts/diagnoseWoIssue.js
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')
const core = require('../clients/coreClient')

const WO_ID = '4333064'

async function main() {
  await sequelize.authenticate()

  // 1. Fetch the WO record
  console.log(`=== WO ${WO_ID} record ===`)
  try {
    const wo = await core.netsuiteGet(`/record/v1/workOrder/${WO_ID}?expandSubResources=true`)
    console.log('status:', wo.status)
    console.log('orderStatus:', wo.orderStatus)
    console.log('quantity:', wo.quantity)
    console.log('built:', wo.built)
    console.log('location:', wo.location)
    console.log('subsidiary:', wo.subsidiary)
    console.log('assemblyItem:', wo.assemblyItem)
    console.log('custbody_woi_line:', wo.custbody_woi_line)
    console.log('component count:', wo.component?.items?.length || 0)
    if (wo.component?.items?.length) {
      console.log('components:')
      for (const c of wo.component.items) {
        console.log(`  line ${c.line} item ${c.item?.id || c.item?.refName} qty ${c.quantity}`)
      }
    }
  } catch (err) {
    console.log('FAILED to fetch WO:', err.message, err.data?.error || '')
  }

  // 2. Look at MesProcessingLog for any prior workOrderIssue attempts on any WO
  console.log('')
  console.log('=== Recent NS workOrderIssue attempts (any WO) ===')
  const logs = await db.MesProcessingLog.findAll({
    where: { nsTransactionType: 'workOrderIssue' },
    order: [['createdAt', 'DESC']],
    limit: 10,
  })
  for (const l of logs) {
    console.log(`[${l.createdAt.toISOString()}] event=${l.eventType} sourceWO=${l.sourceId} success=${l.success} txnId=${l.nsTransactionId || '-'}`)
    if (!l.success && l.errorMessage) {
      console.log(`  error: ${l.errorMessage.slice(0, 300)}`)
    }
    if (l.payload) {
      try {
        const p = JSON.parse(l.payload)
        console.log(`  payload keys: ${Object.keys(p).join(', ')}`)
      } catch { /* */ }
    }
  }

  // 3. Look for any successful workOrderIssue ever (find a working payload shape)
  console.log('')
  console.log('=== Most recent SUCCESSFUL workOrderIssue (if any) ===')
  const ok = await db.MesProcessingLog.findOne({
    where: { nsTransactionType: 'workOrderIssue', success: true, nsTransactionId: { [Op.ne]: null } },
    order: [['createdAt', 'DESC']],
  })
  if (ok) {
    console.log(`Found: id=${ok.id} createdAt=${ok.createdAt.toISOString()} txnId=${ok.nsTransactionId}`)
    console.log('payload:')
    try { console.log(JSON.stringify(JSON.parse(ok.payload), null, 2)) } catch { console.log(ok.payload) }
  } else {
    console.log('NONE — no workOrderIssue has ever succeeded according to MesProcessingLog')
  }
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => sequelize.close())
