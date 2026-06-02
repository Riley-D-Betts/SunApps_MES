/**
 * NetSuite inventory lookup helpers for the WO issue path.
 *
 * - getItemTracking(itemId): is this item lot-tracked? does it use bins?
 *   Cached forever per process. Items don't change tracking class at runtime.
 *
 * - findInventoryAllocations(itemId, locationId, neededQty, preferredBinId):
 *   FIFO-by-lot allocations across available (lot, bin) pairs at the given
 *   location until neededQty is met. If preferredBinId is supplied and has
 *   stock, those rows are exhausted first before falling through to others.
 *   Returns [{ lotId, lotName, binId, binName, qty }, ...]. Empty if no
 *   on-hand inventory.
 *
 * These exist because the issue body shape NS expects on the transform
 * endpoint differs by tracking class:
 *   - lot + bin: assignment item needs both issueinventorynumber AND binnumber
 *   - lot only:  needs issueinventorynumber
 *   - bin only:  needs binnumber
 *   - neither:   no inventory detail
 *
 * See ns_wo_issue_shape memory + scripts/probeLotShape.js for the empirical
 * validation that established this shape.
 */
const core = require('../clients/coreClient')

const NS_LOCATION_ID = 30 // Suntado plant — only location MES touches

const _trackingCache = new Map()

async function getItemTracking(itemId) {
  if (itemId == null) return { isLot: false, useBins: false }
  const key = String(itemId)
  if (_trackingCache.has(key)) return _trackingCache.get(key)

  // NS REST API requires the right item subtype in the path. Try the
  // common ones in order until one accepts the read. The error response
  // for the wrong subtype names the correct one — we could parse it, but
  // walking through the candidate list is simpler and only happens once
  // per item (then cached).
  const subtypes = [
    'inventoryitem',
    'lotnumberedinventoryitem',
    'assemblyitem',
    'lotnumberedassemblyitem',
  ]
  let resolved = null
  for (const sub of subtypes) {
    try {
      const wrap = await core.netsuiteGet(`/record/v1/${sub}/${itemId}?fields=islotitem,usebins,cost`)
      const body = wrap?.body || wrap
      // `cost` = the item's standard cost; carried so inventoryAdjustment can
      // stamp a non-negative line unitcost (NS otherwise derives a negative
      // one and rejects with "Lines cannot have a negative unit cost").
      resolved = { isLot: !!body.isLotItem, useBins: !!body.useBins, cost: Number(body.cost) || 0 }
      break
    } catch (err) {
      const m = (err.data?.error || '').match(/different type: (\w+)/)
      if (m) {
        // The error tells us the right subtype — fetch from there next iteration.
        if (!subtypes.includes(m[1])) subtypes.push(m[1])
        continue
      }
      // Not a "wrong subtype" error → try the next candidate
    }
  }
  if (!resolved) {
    console.warn(`[NsInventoryLookup] Could not resolve tracking for item ${itemId} — defaulting to no tracking`)
    resolved = { isLot: false, useBins: false, cost: 0 }
  }
  _trackingCache.set(key, resolved)
  return resolved
}

// Item standard cost (lbs → $). Reuses getItemTracking's cached item read.
// Used by inventoryAdjustment to set a non-negative line unitcost.
async function getItemStandardCost(itemId) {
  const t = await getItemTracking(itemId)
  return t.cost || 0
}

/**
 * Find (lot, bin) rows with positive on-hand for itemId. Allocates FIFO until
 * neededQty is met. preferredBinId, if supplied, is consumed first; remaining
 * shortfall is filled from any other bin's stock.
 *
 * Returns [{ lotId, lotName, binId, binName, qty }, ...] — note `qty` is the
 * portion taken from that row, not the row's on-hand. Empty array if NS has
 * no on-hand for the item.
 */
async function findInventoryAllocations(itemId, neededQty, preferredBinId = null) {
  if (!itemId || !(neededQty > 0)) return []

  // Source issues must come from the named source bin (silo / blend tank).
  // Falling back to any-bin-with-stock will pick up unrelated inventory
  // sitting in other bins — e.g. a stale lot in a destination silo — which
  // NS then rejects on the issue. When preferredBinId is given, we filter
  // the SQL itself so the allocator never sees other bins' rows.
  const binFilter = preferredBinId != null
    ? `AND bal.binnumber = ${Number(preferredBinId)}`
    : ''

  // Pull every (lot, bin) row with positive AVAILABLE qty. We use
  // quantityavailable, not quantityonhand — NS reserves/commits portions of a
  // lot to open transactions, and an issue rejects with "You only have N
  // available" if we try to take more than the available figure. Falls back
  // to quantityonhand only when available is null (older NS lot rows that
  // pre-date the availability tracker). ORDER BY lot id ASC = oldest first
  // (FIFO); bin preference is applied in JS after the query.
  const q = `
    SELECT
      inv.id                                       AS lot_id,
      inv.inventorynumber                          AS lot_name,
      bin.id                                       AS bin_id,
      bin.binnumber                                AS bin_name,
      COALESCE(bal.quantityavailable, bal.quantityonhand) AS qty
    FROM inventorybalance bal
    JOIN inventorynumber inv ON inv.id = bal.inventorynumber
    JOIN bin             bin ON bin.id = bal.binnumber
    WHERE bal.item = ${Number(itemId)}
      AND bal.location = ${NS_LOCATION_ID}
      AND COALESCE(bal.quantityavailable, bal.quantityonhand) > 0
      ${binFilter}
    ORDER BY inv.id ASC
  `

  let rows
  try {
    const res = await core.netsuitePost('/query/v1/suiteql', { q })
    rows = res?.body?.items || res?.items || []
  } catch (err) {
    console.warn(`[NsInventoryLookup] suiteql failed for item ${itemId}:`, err.message.slice(0, 200))
    return []
  }

  if (rows.length === 0) return []
  // SQL already filtered to preferredBinId when supplied; FIFO across lots is
  // preserved by the ORDER BY inv.id ASC on the query.

  const allocations = []
  let remaining = neededQty
  for (const r of rows) {
    if (remaining <= 0) break
    const rowQty = parseFloat(r.qty) || 0
    if (rowQty <= 0) continue
    const take = Math.min(remaining, rowQty)
    allocations.push({
      lotId: String(r.lot_id),
      lotName: r.lot_name,
      binId: String(r.bin_id),
      binName: r.bin_name,
      qty: take,
    })
    remaining -= take
  }

  return allocations
}

/**
 * Resolve which bin actually has on-hand stock for a non-lot-tracked item.
 * Tries preferredBinId first (same preferred-first pattern as
 * findInventoryAllocations); falls back to any bin at NS_LOCATION_ID that
 * has positive on-hand. Returns the resolved binId string, or null if NS
 * reports zero inventory everywhere.
 */
async function findBinForItem(itemId, preferredBinId = null, neededQty = 0) {
  if (!itemId) return null

  // Strict-preferred-bin: when the caller names a source bin, only that bin
  // counts as a valid result. Falling back to any-bin-with-stock would let
  // an issue draw from an unrelated bin and confuse downstream accounting.
  const binFilter = preferredBinId != null
    ? `AND bal.binnumber = ${Number(preferredBinId)}`
    : ''
  // SUM across the bin in case NS has multiple inventorybalance rows for the
  // same (item, bin, location) under different statuses or lot dimensions.
  const q = `
    SELECT
      bin.id                                                   AS bin_id,
      SUM(COALESCE(bal.quantityavailable, bal.quantityonhand)) AS qty
    FROM inventorybalance bal
    JOIN bin ON bin.id = bal.binnumber
    WHERE bal.item = ${Number(itemId)}
      AND bal.location = ${NS_LOCATION_ID}
      AND COALESCE(bal.quantityavailable, bal.quantityonhand) > 0
      ${binFilter}
    GROUP BY bin.id
    ORDER BY SUM(COALESCE(bal.quantityavailable, bal.quantityonhand)) DESC
  `

  let rows
  try {
    const res = await core.netsuitePost('/query/v1/suiteql', { q })
    rows = res?.body?.items || res?.items || []
  } catch (err) {
    console.warn(`[NsInventoryLookup] findBinForItem suiteql failed for item ${itemId}:`, err.message.slice(0, 200))
    return null
  }

  if (rows.length === 0) return null
  // Return null if the best candidate bin has less than what the caller
  // needs — otherwise the issue posts against the bin and NS rejects with
  // "you only have N available." Returning null instead lets the caller's
  // shortfall hook fire and top the bin up to the required qty.
  const best = rows[0]
  const available = parseFloat(best.qty) || 0
  if (neededQty > 0 && available + 1e-6 < neededQty) return null
  return String(best.bin_id)
}

// FLOOR each lot's assignment qty to 2dp. `a.qty` is the FIFO take, which is
// `min(remaining, availableInThisLot)` — i.e. always ≤ that lot's NS available.
// Flooring therefore guarantees the assignment qty never exceeds available;
// ROUNDING could push it up (e.g. available 9475.70589687 → 9475.71) and NS
// rejects the whole issue with "you only have N available". The component LINE
// quantity is set to the SUM of these floored values (see buildComponentDetail),
// so the inventory-detail total still equals the line exactly — no "total
// inventory detail quantity must be N" mismatch. Integer-cent math keeps the
// per-lot values and their sum free of float dust. The sub-cent-per-lot we drop
// stays in the un-issued delta and rolls into the next tick.
function snapQuantities(allocations) {
  return allocations.map(a => Math.floor((parseFloat(a.qty) || 0) * 100) / 100)
}

/**
 * Compose the assignment-item array for one BOM line based on its tracking
 * class. allocations is the output of findInventoryAllocations (when
 * lot-tracked) or null (when bin-only — we use preferredBinId directly).
 *
 * Returns an array suitable for componentinventorydetail.inventoryassignment.items.
 */
function buildAssignmentItems({ isLot, useBins }, totalQty, allocations, preferredBinId) {
  if (isLot && useBins) {
    const qtys = snapQuantities(allocations)
    return allocations.map((a, i) => ({
      status: 1,
      quantity: qtys[i],
      issueinventorynumber: a.lotId,
      binnumber: a.binId,
    }))
  }
  if (isLot) {
    const qtys = snapQuantities(allocations)
    return allocations.map((a, i) => ({
      status: 1,
      quantity: qtys[i],
      issueinventorynumber: a.lotId,
    }))
  }
  if (useBins) {
    return [{
      status: 1,
      quantity: totalQty,
      binnumber: String(preferredBinId),
    }]
  }
  return null // no tracking detail needed
}

// Build the full inventory-detail object to merge onto a component line,
// keyed and shaped per tracking class. The wrapper key for a BIN-ONLY line
// depends on whether the WHOLE WO has any lot-tracked component line
// (woHasLotLines) — NS switches its inventory-detail sublist mode per order:
//   - WO with ANY lot line (e.g. blend WOs carry vitamin 530 / citrate 7235):
//     the lowercase manufacturing `componentinventorydetail.inventoryassignment`
//     sublist is used for EVERY line. A camelCase `inventoryDetail` on a
//     bin-only line is then SILENTLY IGNORED → "Please configure the inventory
//     detail in line N".
//   - WO with ONLY bin-only lines (e.g. surge WOs — one raw-milk item): the
//     generic camelCase `inventoryDetail.inventoryAssignment` sublist is used.
//     A lowercase wrapper there is IGNORED → "total inventory detail quantity
//     must be N" (credits 0).
// EMPIRICALLY VALIDATED 2026-06-02 (scripts/probeBlendDetailShape.js): blend
// WO 4813196 (has lot lines) → lowercase works / camelCase ignored; surge WO
// 4813527 (pure bin-only) → camelCase works / lowercase ignored. This is why
// commit 4951626 (camelCase-everywhere) fixed surge but broke blend, and the
// lowercase-everywhere attempt did the reverse. Lot / lot+bin lines ALWAYS use
// the lowercase componentinventorydetail shape (they only exist on lot WOs).
// Bin id MUST be the {id: Number} object form regardless of wrapper — a raw
// string binnumber credits 0. See [[ns-wo-issue-shape]], SD-597.
// Returns { quantity, detail }: `detail` is the object to Object.assign onto the
// component entry (or null when the item needs no inventory detail), and
// `quantity` is the effective component-LINE quantity the caller must use. For
// lot-tracked lines that quantity is the SUM of the floored per-lot assignment
// qtys (≤ totalQty) so the line and the inventory-detail total match exactly;
// for bin-only / untracked lines it's just totalQty.
function buildComponentDetail(tracking, totalQty, allocations, preferredBinId, woHasLotLines = false) {
  const { isLot, useBins } = tracking
  if (isLot) {
    const items = buildAssignmentItems(tracking, totalQty, allocations, preferredBinId)
    if (!items || items.length === 0) return { quantity: 0, detail: null }
    // Line qty = sum of the floored per-lot qtys (integer-cent to avoid drift).
    const cents = items.reduce((s, it) => s + Math.round(it.quantity * 100), 0)
    return { quantity: cents / 100, detail: { componentinventorydetail: { inventoryassignment: { items } } } }
  }
  if (useBins) {
    if (preferredBinId == null) return { quantity: totalQty, detail: null }
    if (woHasLotLines) {
      return {
        quantity: totalQty,
        detail: {
          componentinventorydetail: {
            inventoryassignment: {
              items: [{ status: 1, quantity: totalQty, binnumber: { id: Number(preferredBinId) } }],
            },
          },
        },
      }
    }
    return {
      quantity: totalQty,
      detail: {
        inventoryDetail: {
          inventoryAssignment: {
            items: [{ quantity: totalQty, binnumber: { id: Number(preferredBinId) }, inventoryStatus: { id: 1 } }],
          },
        },
      },
    }
  }
  return { quantity: totalQty, detail: null }
}

// True if any component line on the WO BOM is lot-tracked. Drives the bin-only
// inventory-detail wrapper choice in buildComponentDetail (see its comment).
// bomLines: [{ line, itemId }]. Tracking reads are cached, so this is one NS
// round-trip per distinct item the first time a WO is seen, then free.
async function anyLotTracked(bomLines) {
  if (!Array.isArray(bomLines) || bomLines.length === 0) return false
  for (const l of bomLines) {
    const t = await getItemTracking(l.itemId)
    if (t.isLot) return true
  }
  return false
}

// Drop the per-process item-tracking cache so a replay reset re-reads tracking
// config fresh rather than serving values cached during a prior run.
function clearCaches() {
  _trackingCache.clear()
}

module.exports = {
  getItemTracking,
  getItemStandardCost,
  findInventoryAllocations,
  findBinForItem,
  buildAssignmentItems,
  buildComponentDetail,
  anyLotTracked,
  clearCaches,
  NS_LOCATION_ID,
}
