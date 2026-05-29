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
      const wrap = await core.netsuiteGet(`/record/v1/${sub}/${itemId}?fields=islotitem,usebins`)
      const body = wrap?.body || wrap
      resolved = { isLot: !!body.isLotItem, useBins: !!body.useBins }
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
    resolved = { isLot: false, useBins: false }
  }
  _trackingCache.set(key, resolved)
  return resolved
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
    // Floor the per-lot take to 2 decimals (lbs precision). NS reports
    // quantityavailable at full DB precision (e.g. 556.74628043); echoing
    // that back through JS float serialization can serialize to a value
    // microscopically larger, which NS rejects with "You only have N
    // available. Please enter a different quantity." Flooring keeps us
    // strictly under whatever NS reported.
    const take = Math.floor(Math.min(remaining, rowQty) * 100) / 100
    if (take <= 0) continue
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

/**
 * Compose the assignment-item array for one BOM line based on its tracking
 * class. allocations is the output of findInventoryAllocations (when
 * lot-tracked) or null (when bin-only — we use preferredBinId directly).
 *
 * Returns an array suitable for componentinventorydetail.inventoryassignment.items.
 */
function buildAssignmentItems({ isLot, useBins }, totalQty, allocations, preferredBinId) {
  if (isLot && useBins) {
    return allocations.map(a => ({
      status: 1,
      quantity: a.qty,
      issueinventorynumber: a.lotId,
      binnumber: a.binId,
    }))
  }
  if (isLot) {
    return allocations.map(a => ({
      status: 1,
      quantity: a.qty,
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

module.exports = {
  getItemTracking,
  findInventoryAllocations,
  findBinForItem,
  buildAssignmentItems,
  NS_LOCATION_ID,
}
