/**
 * One-off recovery for the BlendTank2A fill that the broken processLineFlow
 * dropped on the floor.
 *
 * Context (see git log around 2026-04-28):
 *   17:20:01  blendTank.batchStart for BlendTank2A "Mp 1%" → MesBlendTankBatch
 *             id=1726, NS WO 4333064 created.
 *   17:20-17:43 ML3 pumped product from MSilo1 into BlendTank2A. The 5-min
 *             tick failed to match line.requestedBy="BT2A" against tankId
 *             "BlendTank2A" (fixed in commit 295beb3), so no per-tick issues
 *             were posted.
 *   17:43:31  ML3 totalizer reset; blendTankJob called processLineFlow with
 *             totalLbs=51600.004. The pre-fix processLineFlow only created a
 *             breadcrumb MesBlendTankInflow row (status='reset_event' or
 *             'unmatched') and did NOT fire the NS workOrderIssue. The row
 *             may have been linked to the WRONG batch (activeBatches[0]
 *             fallback when the abbreviation match failed).
 *
 * What this script does (idempotent — checks for prior recovery before firing):
 *   1. Confirms WO 4333064 has no existing workOrderIssue for ML3's product
 *      yet (via MesProcessingLog where eventType='blend_tank_recovery').
 *   2. POSTs a single workOrderIssue for 51600 lb of NS item 5415 (Raw
 *      Conventional 1%) from bin 1006 (MSilo1) to NS WO 4333064.
 *   3. Reconciles the orphaned MesBlendTankInflow row(s): finds rows where
 *      line='ML3' and totalLbs is close to 51600 with status in
 *      ('reset_event','unmatched','pending'), reassigns to batch 1726, and
 *      stamps with the new nsIssueId / status='completed'.
 *   4. Bumps batch 1726's cumulativeIssuedLbs and updates lastIssueAt — so
 *      the next tick will fire a corresponding workOrderCompletion of the
 *      same magnitude (mass-balance accounting closes the loop).
 *
 * Usage:
 *   node scripts/recoverBlendTank2AFill.js          # dry run
 *   node scripts/recoverBlendTank2AFill.js --confirm
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')
const core = require('../clients/coreClient')

const confirm = process.argv.includes('--confirm')

const RECOVERY = {
  batchId: 1726,
  nsWorkOrderId: '4333064',
  line: 'ML3',
  totalLbs: 51600.004,
  productName: 'Conventional Low Fat 1%',
  siloName: 'MSilo1',
  binId: 1006,                 // Silo-Raw-1
  nsItemId: 5415,              // Raw Conventional 1% (RAW_ITEMS.CONV_1 in mesItemConfig)
  resetTimeIso: '2026-04-28T17:43:31.697Z',
}

async function main() {
  await sequelize.authenticate()

  // 1. Idempotency: bail if a previous run already recovered this fill
  const prior = await db.MesProcessingLog.findOne({
    where: {
      eventType: 'blend_tank_recovery',
      sourceId: RECOVERY.nsWorkOrderId,
      success: true,
    },
  })
  if (prior) {
    console.log(`Already recovered (MesProcessingLog id ${prior.id} on ${prior.createdAt}). Nothing to do.`)
    return
  }

  // 2. Confirm the batch exists and matches expectations
  const batch = await db.MesBlendTankBatch.findByPk(RECOVERY.batchId)
  if (!batch) throw new Error(`Batch ${RECOVERY.batchId} not found`)
  if (batch.nsWorkOrderId !== RECOVERY.nsWorkOrderId) {
    throw new Error(`Batch ${RECOVERY.batchId} has nsWorkOrderId=${batch.nsWorkOrderId}, expected ${RECOVERY.nsWorkOrderId}`)
  }
  console.log(`Target batch: id=${batch.id} ${batch.tankId} "${batch.productName}" status=${batch.status} WO ${batch.nsWorkOrderId}`)
  console.log(`  Current cumulativeIssuedLbs: ${batch.cumulativeIssuedLbs}`)

  // 3. Find the orphaned breadcrumb(s) — line ML3, qty ~51600, leftover statuses
  const orphans = await db.MesBlendTankInflow.findAll({
    where: {
      line: RECOVERY.line,
      totalLbs: { [Op.between]: [RECOVERY.totalLbs - 5, RECOVERY.totalLbs + 5] },
      status: { [Op.in]: ['reset_event', 'unmatched', 'pending'] },
    },
    order: [['createdAt', 'ASC']],
  })
  console.log(`Found ${orphans.length} orphaned MesBlendTankInflow row(s):`)
  for (const o of orphans) {
    console.log(`  id=${o.id} batchId=${o.blendTankBatchId} status=${o.status} totalLbs=${o.totalLbs} resetTime=${o.resetTime}`)
  }

  // Fetch the WO's current BOM (always — diagnostics regardless of dry-run/confirm)
  // The Core API wraps NS responses as { status, ok, body, headers, ... }
  // so the actual NS payload is at .body, and the BOM sublist on a workOrder
  // record is exposed under "item.items" (NOT "component.items" — that name
  // applies to the workOrderIssue transform body, not the WO record itself).
  console.log('')
  const woWrap = await core.netsuiteGet(`/record/v1/workOrder/${RECOVERY.nsWorkOrderId}?expandSubResources=true`)
  const wo = woWrap?.body || woWrap
  console.log(`WO ${RECOVERY.nsWorkOrderId}: status=${wo?.status?.refName || wo?.status} orderStatus=${wo?.orderStatus?.refName} tranId=${wo?.tranId}`)
  require('fs').writeFileSync('./wo-4333064.json', JSON.stringify(woWrap, null, 2))

  const bomItems = wo?.item?.items || []
  console.log(`WO ${RECOVERY.nsWorkOrderId} BOM (item.items) has ${bomItems.length} component(s):`)
  for (const c of bomItems) {
    console.log(`  line ${c.line} item ${c.item?.id} (${c.item?.refName}) qty ${c.quantity}`)
  }

  const targetIdStr = String(RECOVERY.nsItemId)
  const targetLineRow = bomItems.find(c => String(c.item?.id) === targetIdStr)
  const targetLineNumber = targetLineRow?.line || null

  console.log('')
  console.log(`Plan: POST /record/v1/workOrder/${RECOVERY.nsWorkOrderId}/!transform/workOrderIssue`)
  console.log(`      lineNumber: ${targetLineNumber || '(needs PATCH first)'}, qty: ${RECOVERY.totalLbs}`)
  console.log(`      Reassign ${orphans.length} orphan row(s) to batch ${RECOVERY.batchId}, mark completed`)
  console.log(`      Increment batch ${RECOVERY.batchId} cumulativeIssuedLbs by ${RECOVERY.totalLbs}`)
  console.log('')

  if (!confirm) {
    console.log('DRY RUN. Re-run with --confirm to actually post to NetSuite + update DB.')
    return
  }

  if (!targetLineRow) {
    console.log(`Item ${RECOVERY.nsItemId} not on BOM — PATCHing WO to append it (qty 0)`)
    const merged = bomItems.map(c => ({
      item: { id: String(c.item?.id) },
      quantity: c.quantity,
      ...(c.units?.id ? { units: { id: String(c.units.id) } } : {}),
    }))
    merged.push({ item: { id: targetIdStr }, quantity: 0 })
    await core.netsuitePatch(`/record/v1/workOrder/${RECOVERY.nsWorkOrderId}`, { item: { items: merged } })
    console.log('  PATCH ok — re-fetching to get the new line number')
    const refetched = (await core.netsuiteGet(`/record/v1/workOrder/${RECOVERY.nsWorkOrderId}?expandSubResources=true`))?.body
    const newRow = (refetched?.item?.items || []).find(c => String(c.item?.id) === targetIdStr)
    if (!newRow) throw new Error('PATCH succeeded but item still not on BOM')
    console.log(`  added at line ${newRow.line}`)
    targetLineRow.line = newRow.line   // unreachable since targetLineRow was null — kept for symmetry
  }
  const lineNumber = targetLineRow?.line || (await core.netsuiteGet(`/record/v1/workOrder/${RECOVERY.nsWorkOrderId}?expandSubResources=true`))?.body?.item?.items?.find(c => String(c.item?.id) === targetIdStr)?.line

  // Use the DIRECT endpoint (not transform) so NS only consumes what we
  // explicitly list — transform tries to auto-issue every BOM line and
  // demands per-line inventory detail for lot-tracked components.
  //
  // Body shape matches the workOrderIssue response we observed (#21674):
  //   { createdFrom: { id }, component: { items: [{ item: "<id>",
  //       lineNumber, quantity }] } }
  // Note `item` is a STRING (not { id: ... }) and `component` is the sublist
  // field name on a workOrderIssue (NOT `item` — that's the FG reference).
  const issueBody = {
    transaction: { id: RECOVERY.nsWorkOrderId },        // parent WO (request side)
    custbody_tran_last_modified_by: 'system',
    component: {                                         // sublist field name
      items: [{
        item: targetIdStr,                               // bare string id
        lineNumber,
        quantity: RECOVERY.totalLbs,
      }],
    },
  }
  console.log(`POSTing direct workOrderIssue body:`, JSON.stringify(issueBody))
  const issueResp = await core.netsuitePost('/record/v1/workOrderIssue', issueBody)
  let nsIssueId = issueResp?.body?.id || issueResp?.id || null
  if (!nsIssueId && issueResp?.headers?.location) {
    const m = String(issueResp.headers.location).match(/\/(\d+)$/)
    if (m) nsIssueId = m[1]
  }
  console.log(`NS issue posted: ${nsIssueId}`)

  // 5. Update orphans → completed
  for (const o of orphans) {
    await o.update({
      blendTankBatchId: RECOVERY.batchId,
      nsItemId: String(RECOVERY.nsItemId),
      nsIssueId: nsIssueId ? String(nsIssueId) : null,
      status: 'completed',
    })
    console.log(`  reconciled inflow ${o.id}`)
  }

  // 6. Bump cumulative + log
  await batch.increment({ cumulativeIssuedLbs: RECOVERY.totalLbs })
  await batch.update({ lastIssueAt: new Date() })
  await db.MesProcessingLog.create({
    eventType: 'blend_tank_recovery',
    sourceId: RECOVERY.nsWorkOrderId,
    nsTransactionType: 'workOrderIssue',
    nsTransactionId: nsIssueId,
    payload: JSON.stringify(RECOVERY),
    result: JSON.stringify({ nsIssueId, orphansReconciled: orphans.length }),
    success: true,
  })

  console.log(`Done. Next tick will fire a workOrderCompletion of ~${RECOVERY.totalLbs} lb against WO ${RECOVERY.nsWorkOrderId} (mass-balance).`)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => sequelize.close())
