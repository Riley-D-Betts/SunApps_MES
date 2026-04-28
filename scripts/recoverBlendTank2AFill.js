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

  console.log('')
  console.log(`Plan: POST workOrderIssue { WO: ${RECOVERY.nsWorkOrderId}, item: ${RECOVERY.nsItemId}, qty: ${RECOVERY.totalLbs}, bin: ${RECOVERY.binId} }`)
  console.log(`      Reassign ${orphans.length} orphan row(s) to batch ${RECOVERY.batchId}, mark completed`)
  console.log(`      Increment batch ${RECOVERY.batchId} cumulativeIssuedLbs by ${RECOVERY.totalLbs}`)
  console.log('')

  if (!confirm) {
    console.log('DRY RUN. Re-run with --confirm to actually post to NetSuite + update DB.')
    return
  }

  // 4a. Fetch the WO's current BOM and check if our item is already there.
  //     The BOM sublist on workOrder is "component" (not "item" — that's the
  //     workOrderIssue record's field). If our item isn't a component, PATCH
  //     to add it before issuing.
  const wo = await core.netsuiteGet(`/record/v1/workOrder/${RECOVERY.nsWorkOrderId}?expandSubResources=true`)
  console.log(`WO ${RECOVERY.nsWorkOrderId} top-level keys:`, Object.keys(wo || {}).join(', '))
  console.log(`  status:`, wo?.status, '| orderStatus:', wo?.orderStatus?.refName || wo?.orderStatus, '| built:', wo?.built)
  // Try several shapes — different NS configurations expose the BOM under
  // different field names. We'll log all candidates and use whichever works.
  const candidates = ['component', 'componentList', 'items', 'item', 'componentInventoryDetail']
  for (const k of candidates) {
    const v = wo?.[k]
    if (v) console.log(`  wo.${k} type:`, typeof v, 'has items:', !!v.items, 'length:', v.items?.length || (Array.isArray(v) ? v.length : '-'))
  }
  // Save full JSON for offline inspection
  require('fs').writeFileSync('./wo-4333064.json', JSON.stringify(wo, null, 2))
  console.log(`  full WO JSON saved to ./wo-4333064.json`)

  const bomItems = wo?.component?.items || []
  console.log(`WO ${RECOVERY.nsWorkOrderId} current BOM (component.items) has ${bomItems.length} component(s):`)
  for (const c of bomItems) console.log(`  line ${c.line} item ${c.item?.id || c.item?.refName} qty ${c.quantity}`)

  const targetIdStr = String(RECOVERY.nsItemId)
  const onBom = bomItems.some(c => String(c.item?.id) === targetIdStr)

  if (!onBom) {
    console.log(`Item ${RECOVERY.nsItemId} not on BOM — PATCHing WO to append it`)
    // NS PATCH on sublists replaces the whole list, so we need the existing
    // components + the new one. Strip read-only fields (links, refName, etc.)
    // and keep just the writable shape.
    const merged = bomItems.map(c => ({
      item: { id: String(c.item?.id) },
      quantity: c.quantity,
      ...(c.units?.id ? { units: { id: String(c.units.id) } } : {}),
    }))
    merged.push({ item: { id: targetIdStr }, quantity: 0 })
    const patchBody = { component: { items: merged } }
    const patchResult = await core.netsuitePatch(`/record/v1/workOrder/${RECOVERY.nsWorkOrderId}`, patchBody)
    console.log(`  PATCH response: ${JSON.stringify(patchResult).slice(0, 200)}`)
  } else {
    console.log(`Item ${RECOVERY.nsItemId} already on BOM — skipping PATCH`)
  }

  // 4b. Fire the NS workOrderIssue
  const body = {
    transaction: { id: RECOVERY.nsWorkOrderId },
    item: {
      items: [{
        item: { id: targetIdStr },
        quantity: RECOVERY.totalLbs,
        inventorydetail: {
          inventoryassignment: {
            items: [{ quantity: RECOVERY.totalLbs, binnumber: { id: RECOVERY.binId } }],
          },
        },
      }],
    },
  }

  const nsResult = await core.netsuitePost('/record/v1/workOrderIssue', body)
  let nsIssueId = nsResult?.id || null
  if (!nsIssueId && nsResult?.headers?.location) {
    const m = nsResult.headers.location.match(/\/(\d+)$/)
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
