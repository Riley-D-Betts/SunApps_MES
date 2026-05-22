/**
 * For each active surge batch, dump:
 *   - the surge batch's pinned component (item + bin + how it was resolved)
 *   - the source blend tank's most recent batch and its NS WO (item / qty built / status)
 *   - NS on-hand for the component item in the pinned bin (lot detail)
 * to pinpoint why the surge WO issue is failing against a tiny inventory pool.
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')
const core = require('../clients/coreClient')

async function dumpWo(woId) {
  try {
    const wo = await core.netsuiteGet(`/record/v1/workOrder/${woId}?expandSubResources=true`)
    console.log(`  WO ${woId}: status=${wo.status}  orderStatus=${wo.orderStatus}  qty=${wo.quantity}  built=${wo.built}  assemblyItem=${JSON.stringify(wo.assemblyItem)}`)
    if (wo.component?.items?.length) {
      console.log(`  components (${wo.component.items.length}):`)
      for (const c of wo.component.items) {
        console.log(`    line=${c.line}  item=${c.item?.id || c.item?.refName}  qty=${c.quantity}  qtyCommitted=${c.quantityCommitted ?? '-'}`)
      }
    }
  } catch (err) {
    console.log(`  WO ${woId}: FAILED to fetch — ${err.message}`)
  }
}

async function dumpItemOnHand(itemId, binId) {
  try {
    const url = `/query/v1/suiteql`
    const sql = `
      SELECT il.item, il.binnumber, il.quantityonhand, il.quantityavailable,
             il.inventorynumber AS lotId, ii.lotnumber AS lotName, ii.expirationdate
      FROM inventoryNumberBinOnHand il
      LEFT JOIN inventoryNumber ii ON ii.id = il.inventorynumber
      WHERE il.item = ${Number(itemId)}
        ${binId ? `AND il.binnumber = ${Number(binId)}` : ''}
      ORDER BY il.quantityonhand DESC
    `
    const res = await core.netsuitePost(url, { q: sql })
    if (!res.items || res.items.length === 0) {
      console.log(`  on-hand: no rows for item=${itemId}${binId ? ` bin=${binId}` : ''}`)
      return
    }
    for (const r of res.items) {
      console.log(`    bin=${r.binnumber}  lot="${r.lotName || r.lotid}"  onHand=${r.quantityonhand}  avail=${r.quantityavailable}  exp=${r.expirationdate}`)
    }
  } catch (err) {
    console.log(`  on-hand lookup FAILED: ${err.message}`)
  }
}

async function main() {
  await sequelize.authenticate()

  const surgeBatches = await db.MesSurgeTankBatch.findAll({
    where: { status: 'active' },
    order: [['detectedAt', 'DESC']],
  })

  for (const sb of surgeBatches) {
    console.log(`\n========================================`)
    console.log(`SURGE ${sb.tankId} batch=${sb.id} "${sb.productName}"`)
    console.log(`========================================`)
    console.log(`  surgeWO     = ${sb.nsWorkOrderNumber} (id=${sb.nsWorkOrderId})`)
    console.log(`  surge mesItem = ${sb.mesItem}`)
    console.log(`  surge component pinned: item=${sb.componentItemId}  bin=${sb.componentBinId}  resolvedFrom=${sb.componentResolvedFrom}`)
    console.log(`  feeding   : uht=${sb.feedingUhtId}  fromEnt=${sb.feedingFromEntName}`)
    console.log(`  pairingStatus=${sb.pairingStatus}  layerSkipReason=${sb.layerSkipReason}`)
    console.log(`  detectedAt=${sb.detectedAt?.toISOString()}  lastIssueAt=${sb.lastIssueAt?.toISOString() || '-'}`)
    console.log(`  cumIssued=${sb.cumulativeIssuedLbs}  cumCompleted=${sb.cumulativeCompletedLbs}`)

    // Source blend tank — find most-recent batch (any status) whose tankId matches feedingFromEntName
    const srcTankId = sb.feedingFromEntName
    if (!srcTankId) {
      console.log(`  -> no feedingFromEntName recorded`)
      continue
    }
    console.log(`\n  --- source tank ${srcTankId} recent batches ---`)
    const srcBatches = await db.MesBlendTankBatch.findAll({
      where: { tankId: srcTankId },
      order: [['detectedAt', 'DESC']],
      limit: 5,
    })
    for (const bb of srcBatches) {
      console.log(`  bt batch=${bb.id} "${bb.productName}" status=${bb.status}  mesItem=${bb.mesItem}  WO=${bb.nsWorkOrderNumber}(${bb.nsWorkOrderId})`)
      console.log(`    detectedAt=${bb.detectedAt?.toISOString()}  completedAt=${bb.completedAt?.toISOString() || '-'}`)
      console.log(`    cumIssued=${bb.cumulativeIssuedLbs}  cumCompleted=${bb.cumulativeCompletedLbs}  lastCompletion=${bb.lastCompletionAt?.toISOString() || '-'}`)
    }

    // For the surge component item, look up actual NS on-hand by lot in that bin.
    console.log(`\n  --- NS on-hand for surge component item=${sb.componentItemId} bin=${sb.componentBinId} ---`)
    await dumpItemOnHand(sb.componentItemId, sb.componentBinId)

    // Also fetch the surge WO + its actual BOM to verify what the WO was created against.
    console.log(`\n  --- NS surge WO ---`)
    await dumpWo(sb.nsWorkOrderId)

    // And the source blend tank's most recent (active or just-closed) WO — that's what
    // produces the component the surge WO is supposed to consume.
    const srcLive = srcBatches[0]
    if (srcLive?.nsWorkOrderId) {
      console.log(`\n  --- NS source blend WO (${srcLive.nsWorkOrderNumber}) for ${srcTankId} batch ${srcLive.id} ---`)
      await dumpWo(srcLive.nsWorkOrderId)
    }
  }

  await sequelize.close()
}

main().catch(err => {
  console.error('FAILED:', err)
  process.exit(1)
})
