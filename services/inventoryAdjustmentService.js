/**
 * Inventory adjustment service.
 *
 * Two entry points, one NS payload builder:
 *
 *   - submitInventoryAdjustment(...)  — low-level: post one signed adjustment
 *     against a (bin, item[, lot]) tuple.
 *   - applyShortfallAdjustment(...)   — called from WO issue / assembly
 *     unbuild paths when NS reports insufficient on-hand. Bumps the source bin
 *     up by exactly the shortfall and writes an audit row tagged source='shortfall'.
 *
 * The 5-min tank-at-rest sweep (services/tankAtRestSweepService) calls
 * submitInventoryAdjustment directly with source='sweep'.
 *
 * NS REST `/record/v1/inventoryAdjustment` payload shape was modeled after
 * the workOrderIssue/assemblyUnbuild shapes already established in this repo
 * (see [[ns_wo_issue_shape]]). If NS rejects the REST path in practice, swap
 * the netsuitePost call for core.callRestlet(...) with a custom restlet.
 */
const core = require('../clients/coreClient')
const nsInventory = require('./nsInventoryLookup')
const statusStore = require('./statusStore')
const config = require('../config')
const db = require('../models')

// Suntado plant — only location MES touches. Matches nsInventoryLookup.
const NS_LOCATION_ID = nsInventory.NS_LOCATION_ID
const NS_SUBSIDIARY_ID = 3
// GL account id 476 = "525000 Inventory Adjustment" — required by NS at the
// header of every inventoryAdjustment.
const NS_ADJ_ACCOUNT_ID = 476

/**
 * Look up the current lot id sitting in (item, bin, location). Returns null
 * if no lot has on-hand here. Used by the adjustment path to:
 *   - down-adjust against the existing lot (consume from it), and
 *   - up-adjust into the existing lot when one is already present.
 */
async function findExistingLotInBin(itemId, binId) {
  if (!itemId || !binId) return null
  const q = `
    SELECT TOP 1
      inv.id              AS lot_id,
      inv.inventorynumber AS lot_name,
      bal.quantityonhand  AS qty
    FROM inventorybalance bal
    JOIN inventorynumber inv ON inv.id = bal.inventorynumber
    WHERE bal.item = ${Number(itemId)}
      AND bal.binnumber = ${Number(binId)}
      AND bal.location = ${NS_LOCATION_ID}
      AND bal.quantityonhand > 0
    ORDER BY inv.id DESC
  `
  try {
    const res = await core.netsuitePost('/query/v1/suiteql', { q })
    const rows = res?.body?.items || res?.items || []
    if (rows.length === 0) return null
    return { lotId: String(rows[0].lot_id), lotName: rows[0].lot_name, qty: parseFloat(rows[0].qty) || 0 }
  } catch (err) {
    console.warn(`[InventoryAdjustment] findExistingLotInBin failed for item=${itemId} bin=${binId}:`, err.message.slice(0, 200))
    return null
  }
}

/**
 * Look up the current bin balance for (item, bin, location). Sums across lots
 * when the item is lot-tracked. Returns 0 if nothing on-hand.
 */
async function getBinQtyOnHand(itemId, binId) {
  if (!itemId || !binId) return 0
  const q = `
    SELECT SUM(bal.quantityonhand) AS qty
    FROM inventorybalance bal
    WHERE bal.item = ${Number(itemId)}
      AND bal.binnumber = ${Number(binId)}
      AND bal.location = ${NS_LOCATION_ID}
  `
  try {
    const res = await core.netsuitePost('/query/v1/suiteql', { q })
    const rows = res?.body?.items || res?.items || []
    if (rows.length === 0) return 0
    return parseFloat(rows[0].qty) || 0
  } catch (err) {
    console.warn(`[InventoryAdjustment] getBinQtyOnHand failed for item=${itemId} bin=${binId}:`, err.message.slice(0, 200))
    return 0
  }
}

function pad2(n) { return String(n).padStart(2, '0') }

/**
 * MMDDYY+woNumber, digits only. Matches surgeTankMesService.js:786. Caller
 * must supply a real WO number — for in-progress blend tanks the sweep skips
 * adjustment so this is only hit at end-of-batch.
 */
function buildLotString(woNumber, date = new Date()) {
  const mm = pad2(date.getMonth() + 1)
  const dd = pad2(date.getDate())
  const yy = pad2(date.getFullYear() % 100)
  const wo = String(woNumber || '').replace(/\D/g, '')
  if (!wo) return null
  return `${mm}${dd}${yy}${wo}`
}

/**
 * Resolve the lot to attach to an adjustment for a lot-tracked item.
 *
 * - Item is bin-only (not lot-tracked): returns { lotId: null, lotName: null,
 *   isNewLot: false } — caller builds a bin-only payload.
 * - Lot-tracked, existing lot in this bin: returns its id (use for both up-
 *   and down-adjusts).
 * - Lot-tracked, no existing lot, up-adjust with a known WO number: returns a
 *   fresh MMDDYY+WO# lot name to receive into (isNewLot=true).
 * - Lot-tracked, no existing lot, down-adjust: returns null — there's nothing
 *   to consume against; caller should log + skip.
 */
async function resolveLotForBinAdjustment({ binId, itemId, qtyDelta, lastWoNumber }) {
  const tracking = await nsInventory.getItemTracking(itemId)
  if (!tracking.isLot) {
    return { lotId: null, lotName: null, isNewLot: false, tracking }
  }

  const existing = await findExistingLotInBin(itemId, binId)
  if (existing) {
    return { lotId: existing.lotId, lotName: existing.lotName, isNewLot: false, tracking }
  }

  if (qtyDelta > 0 && lastWoNumber) {
    const lotName = buildLotString(lastWoNumber)
    return { lotId: null, lotName, isNewLot: true, tracking }
  }

  return { lotId: null, lotName: null, isNewLot: false, tracking, unresolved: true }
}

/**
 * Build the NS REST `/record/v1/inventoryAdjustment` body for one (bin, item,
 * lot?) adjustment. qtyDelta is signed: positive = adjust up, negative = down.
 *
 * Shape mirrors the workOrderIssue body — lowercase inventorydetail-style
 * keys, raw string IDs for nested fields. inventoryStatus is included
 * because adjustments against status-managed items require it.
 */
// Build the inventoryAdjustment body. `location` is required at both header
// and line level; NS surfaces missing line-level location as USER_ERROR
// "Please enter value(s) for: Location." Tracking class drives whether the
// inventoryDetail block is needed and what fields it carries:
//   - lot + bin (blend tank raw FG): assignment pairs binnumber + lot.
//   - bin-only (silo items 5417/5404/etc): assignment carries binnumber only.
//   - lot-only: assignment carries the lot only.
//   - no tracking: omit inventoryDetail.
// Shape mirrors the assemblyUnbuild body already used in this repo —
// `binnumber: { id }` object form, NO inventoryStatus field. NS rejects the
// status field on items that aren't status-managed with the misleading
// "You cannot create an inventory detail for this item."
function buildInventoryAdjustmentBody({ binId, itemId, qtyDelta, lot, memo }) {
  const signedQty = qtyDelta
  const tracking = lot?.tracking || { isLot: false, useBins: false }

  const item = {
    item: { id: String(itemId) },
    adjustQtyBy: signedQty,
    location: { id: NS_LOCATION_ID },
  }

  // assignment.quantity must match the sign of adjustQtyBy — NS rejects a
  // positive assignment quantity on a down-adjust with "You must enter a
  // negative quantity."
  const assignment = { quantity: signedQty }
  let needAssignment = false
  if (tracking.useBins && binId) {
    assignment.binnumber = { id: String(binId) }
    needAssignment = true
  }
  if (tracking.isLot) {
    if (lot?.isNewLot && lot.lotName) {
      // Creating a new lot: receiptInventoryNumber only accepts a brand-new
      // lot name (string in object form). NS rejects an existing lot id
      // passed here with INVALID_VALUE.
      assignment.receiptInventoryNumber = { inventoryNumber: lot.lotName }
    } else if (lot?.lotId) {
      // Referencing an EXISTING lot — issueInventoryNumber works for both
      // up- and down-adjusts; signed quantity tells NS the direction. Using
      // receiptInventoryNumber with an existing id is INVALID_VALUE per NS.
      assignment.issueInventoryNumber = { id: String(lot.lotId) }
    }
    needAssignment = true
  }
  if (needAssignment) {
    item.inventoryDetail = {
      inventoryAssignment: { items: [assignment] },
    }
  }

  return {
    subsidiary: { id: NS_SUBSIDIARY_ID },
    location: { id: NS_LOCATION_ID },
    account: { id: NS_ADJ_ACCOUNT_ID },
    memo: memo || 'MES auto inventory adjustment',
    inventory: { items: [item] },
  }
}

function extractNsAdjustmentId(nsResult) {
  if (nsResult?.body?.id) return String(nsResult.body.id)
  if (nsResult?.id) return String(nsResult.id)
  const loc = nsResult?.headers?.location || nsResult?.headers?.Location
  if (loc) {
    const m = String(loc).match(/\/(\d+)(?:\?.*)?$/)
    if (m) return m[1]
  }
  return null
}

/**
 * Submit one inventory adjustment to NS. Always writes an audit row to
 * MesInventoryAdjustments — even on dry-run and on failure — so the history
 * is queryable regardless of mode.
 *
 * @param {object} args
 * @param {number} args.binId
 * @param {string|number} args.itemId
 * @param {number} args.qtyDelta            — signed; lbs.
 * @param {string} args.source              — 'sweep' | 'shortfall'.
 * @param {string} [args.tankName]
 * @param {number} [args.observedLbs]       — 5-min avg, sweep only.
 * @param {number} [args.nsQtyBefore]       — current on-hand, sweep only.
 * @param {string} [args.lastWoNumber]      — used when a new lot must be created.
 * @param {string} [args.memo]
 * @returns {Promise<{ok: boolean, nsAdjustmentId: string|null, lotId: string|null,
 *                    lotName: string|null, skipped?: string, error?: string}>}
 */
async function submitInventoryAdjustment(args) {
  const {
    binId,
    itemId,
    qtyDelta,
    source,
    tankName = null,
    observedLbs = null,
    nsQtyBefore = null,
    lastWoNumber = null,
    memo = null,
  } = args

  if (!binId || !itemId) {
    return { ok: false, error: 'binId and itemId required', nsAdjustmentId: null, lotId: null, lotName: null }
  }
  if (!Number.isFinite(qtyDelta) || qtyDelta === 0) {
    return { ok: false, error: 'qtyDelta must be a non-zero finite number', nsAdjustmentId: null, lotId: null, lotName: null }
  }

  const lot = await resolveLotForBinAdjustment({ binId, itemId, qtyDelta, lastWoNumber })
  if (lot.unresolved) {
    const reason = `lot-tracked item ${itemId} has no existing lot in bin ${binId} and no lastWoNumber for a new-lot ${qtyDelta < 0 ? 'down-' : 'up-'}adjust`
    console.warn(`[InventoryAdjustment] Skipping (${source}) ${tankName || ''}: ${reason}`)
    statusStore.pushEvent(
      'inventoryAdjustment.skipped',
      `${tankName || `bin ${binId}`}: Δ${qtyDelta.toFixed(0)} lb skipped — no lot context`,
      { source, tankName, binId, itemId, qtyDelta, reason }
    )
    await safeAudit({
      source, tankName, binId, itemId, qtyDelta, observedLbs, nsQtyBefore,
      lotId: null, lotName: null, nsAdjustmentId: null, memo,
      status: 'skipped', errorMessage: reason,
    })
    return { ok: false, skipped: reason, nsAdjustmentId: null, lotId: null, lotName: null }
  }

  const body = buildInventoryAdjustmentBody({
    binId, itemId, qtyDelta, lot,
    memo: memo || `MES ${source} adjustment${tankName ? ` (${tankName})` : ''}`,
  })

  if (config.MES_DRY_RUN) {
    console.log(`[InventoryAdjustment] DRY_RUN (${source}) tank=${tankName} bin=${binId} item=${itemId} Δ=${qtyDelta.toFixed(2)} lot=${lot.lotName || lot.lotId || 'none'}`)
    console.log(`[InventoryAdjustment] DRY_RUN body: ${JSON.stringify(body)}`)
    await safeAudit({
      source, tankName, binId, itemId, qtyDelta, observedLbs, nsQtyBefore,
      lotId: lot.lotId, lotName: lot.lotName, nsAdjustmentId: null,
      memo: body.memo, status: 'dry_run', errorMessage: null,
    })
    return { ok: true, nsAdjustmentId: null, lotId: lot.lotId, lotName: lot.lotName }
  }

  try {
    console.log(`[InventoryAdjustment] POST (${source}) tank=${tankName} bin=${binId} item=${itemId} Δ=${qtyDelta.toFixed(2)} lot=${lot.lotName || lot.lotId || 'none'}`)
    const nsResult = await core.netsuitePost('/record/v1/inventoryAdjustment', body)
    const nsAdjustmentId = extractNsAdjustmentId(nsResult)
    console.log(`[InventoryAdjustment] OK (${source}) ${tankName || ''}: NS id=${nsAdjustmentId}`)
    await safeAudit({
      source, tankName, binId, itemId, qtyDelta, observedLbs, nsQtyBefore,
      lotId: lot.lotId, lotName: lot.lotName, nsAdjustmentId,
      memo: body.memo, status: 'submitted', errorMessage: null,
    })
    return { ok: true, nsAdjustmentId, lotId: lot.lotId, lotName: lot.lotName }
  } catch (err) {
    console.error(`[InventoryAdjustment] FAILED (${source}) tank=${tankName} bin=${binId} item=${itemId} Δ=${qtyDelta.toFixed(2)}:`, err.message.slice(0, 400))
    statusStore.pushEvent(
      'inventoryAdjustment.error',
      `${source} adjustment failed for ${tankName || `bin ${binId}`} (item ${itemId}, Δ${qtyDelta.toFixed(0)} lb): ${extractNsErrorDetail(err) || err.message.slice(0, 200)}`,
      { source, tankName, binId, itemId, qtyDelta, error: err.message.slice(0, 500) }
    )
    await safeAudit({
      source, tankName, binId, itemId, qtyDelta, observedLbs, nsQtyBefore,
      lotId: lot.lotId, lotName: lot.lotName, nsAdjustmentId: null,
      memo: body.memo, status: 'error', errorMessage: err.message.slice(0, 1900),
    })
    return { ok: false, error: err.message, nsAdjustmentId: null, lotId: lot.lotId, lotName: lot.lotName }
  }
}

// Try to pull the NS USER_ERROR detail out of the wrapped error message so the
// event-stream entry is human-readable instead of a wall of escaped JSON.
function extractNsErrorDetail(err) {
  const m = String(err?.message || '').match(/"detail":"([^"]+)"/)
  return m ? m[1] : null
}

/**
 * Inline auto-adjust used by WO issue / assembly unbuild paths. Bumps the
 * source bin up by exactly the shortfall (no buffer) and returns to the
 * caller, which must then re-query allocations before retrying the NS post.
 */
async function applyShortfallAdjustment({ sourceBinId, itemId, shortfallQty, lastWoNumber, tankName, memo }) {
  if (!(shortfallQty > 0)) {
    return { ok: false, error: 'shortfallQty must be positive', nsAdjustmentId: null }
  }
  return submitInventoryAdjustment({
    binId: sourceBinId,
    itemId,
    qtyDelta: shortfallQty,
    source: 'shortfall',
    tankName,
    lastWoNumber,
    memo: memo || `Auto-adjust: WO issue/unbuild shortfall (+${shortfallQty.toFixed(2)} lb)`,
  })
}

async function safeAudit(row) {
  try {
    if (!db.MesInventoryAdjustment) return
    await db.MesInventoryAdjustment.create(row)
  } catch (err) {
    console.warn(`[InventoryAdjustment] Audit insert failed: ${err.message.slice(0, 200)}`)
  }
}

module.exports = {
  submitInventoryAdjustment,
  applyShortfallAdjustment,
  resolveLotForBinAdjustment,
  findExistingLotInBin,
  getBinQtyOnHand,
  buildInventoryAdjustmentBody,
  buildLotString,
  NS_LOCATION_ID,
  NS_SUBSIDIARY_ID,
}
