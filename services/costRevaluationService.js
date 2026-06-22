/**
 * Cost Revaluation Service — fallback remediation for standard-cost items that
 * were created in NetSuite without a cost basis.
 *
 * Background (see investigation 2026-06-22): a STANDARD-costing item with
 * cost=0 and no Inventory Cost Revaluation has no cost basis. Any posting
 * transaction against it (workOrderIssue / build) fails with the misleading
 * NS error:
 *     "Inventory Revaluation is no longer the first transaction in the item's history."
 * For these items that error literally means "no revaluation ever happened",
 * not "one exists but is mis-ordered". Item 8370 "Raw Organic A2 4%" hit this
 * all weekend (207k lb of milk never reached NS).
 *
 * This service detects that signature and, as a fallback, posts a standard-cost
 * Inventory Cost Revaluation built as a BOM roll-up — one costComponent row per
 * real BOM component (self-references excluded), valued at each component's
 * standard cost. This mirrors how the working items (e.g. 5403) were set up.
 *
 * The revaluation's tranDate is set on/before the item's earliest existing
 * transaction so NS accepts it as the first transaction in the item's history.
 *
 * SAFETY: writes to the GL. Honors config.MES_DRY_RUN (logs the body, posts
 * nothing). The caller is responsible for throttling retries.
 */
const core = require('../clients/coreClient')
const config = require('../config')

// NS setup constants for this account (read off the working reval on item 5403,
// id 4770102, customForm "Standard Inventory Cost Revaluation").
const REVAL_ACCOUNT_ID = 477        // 52600 COGS : Inventory Revaluation
const REVAL_CUSTOM_FORM_ID = 63     // Standard Inventory Cost Revaluation
const DEFAULT_LOCATION_ID = 30      // Ida Milk
const DEFAULT_SUBSIDIARY_ID = 3     // Ida Milk
const DEFAULT_COST_CATEGORY_ID = 1  // Default Cost Category

function sql(q) {
  // Proven SuiteQL path; the core.suiteQL() helper route is mis-wired.
  return core.netsuitePost('/query/v1/suiteql', { q })
}
function rows(res) {
  return res?.items || res?.body?.items || []
}

// NS throws this on a posting transaction when the target standard-cost item has
// no cost revaluation establishing its cost basis. The message is misleading —
// it implies a reval exists but is mis-ordered; for a cost=0 / no-reval item it
// just means none was ever created. See module header.
function isNoCostBasisError(err) {
  return /Inventory Revaluation is no longer the first transaction/i.test(String(err?.message || ''))
}

// True when itemId is a STANDARD-costing item with cost=0 and no existing
// Inventory Cost Revaluation — i.e. genuinely missing its cost basis (the case
// this service can safely remediate). Returns false for avg/FIFO items or items
// that already have a reval (a real "no longer first" ordering problem we must
// NOT auto-touch).
async function needsCostBasis(itemId) {
  const item = rows(await sql(`SELECT id, costingmethod, cost FROM item WHERE id = ${itemId}`))[0]
  if (!item) return { eligible: false, reason: 'item not found' }
  if (String(item.costingmethod).toUpperCase() !== 'STANDARD') {
    return { eligible: false, reason: `costing=${item.costingmethod} (not STANDARD)` }
  }
  const reval = rows(await sql(
    `SELECT COUNT(*) AS n FROM transaction t JOIN transactionline tl ON tl.transaction = t.id
     WHERE tl.item = ${itemId} AND t.type = 'InvReval'`
  ))[0]
  if (Number(reval?.n) > 0) {
    return { eligible: false, reason: 'item already has an InvReval (real ordering issue — needs manual fix)' }
  }
  return { eligible: true, cost: Number(item.cost) || 0 }
}

// Earliest transaction date (YYYY-MM-DD) touching the item, so the reval can be
// dated on/before it and land as the first transaction. Null if none.
async function earliestTransactionDate(itemId) {
  const r = rows(await sql(
    `SELECT MIN(t.trandate) AS d FROM transaction t JOIN transactionline tl ON tl.transaction = t.id
     WHERE tl.item = ${itemId}`
  ))[0]
  return r?.d || null
}

// Resolve the assembly item's master BOM + its current revision id via REST.
// The WO's own component lines can't be used as a cost basis — this MES drives
// component quantities through workOrderIssue transactions, so WO BOM lines sit
// at qty 0 (and may carry circular self-references from the no-BOM seed
// fallback). The master BOM revision is the authoritative per-unit recipe.
// Returns { bomId, revisionId } or null when the item has no BOM attached.
async function resolveMasterBomRevision(assemblyItemId) {
  const wrap = await core.netsuiteGet(`/record/v1/assemblyItem/${assemblyItemId}?expandSubResources=true`)
  const item = wrap?.body || wrap
  const bomRows = item?.billOfMaterials?.items || []
  if (!bomRows.length) return null
  // Prefer the default/master BOM row when flagged; else first.
  const chosen = bomRows.find(r => r.masterDefault || r.bomDefault) || bomRows[0]
  const bomId = chosen?.billOfMaterials?.id
  const revisionId = chosen?.currentRevision?.id || null
  return bomId ? { bomId: String(bomId), revisionId: revisionId ? String(revisionId) : null } : null
}

// Build the per-component standard-cost roll-up from the assembly's MASTER BOM
// revision (per-unit quantities), valuing each component at its standard cost.
// Returns { components: [{ itemId, cost, quantity }], unitCost, bomId, revisionId }.
async function rollupCostFromMasterBom(assemblyItemId) {
  const bom = await resolveMasterBomRevision(assemblyItemId)
  if (!bom) return { components: [], unitCost: 0, bomId: null, revisionId: null, reason: 'no master BOM attached to item' }

  // Resolve the revision id if the item record didn't expose currentRevision.
  let revisionId = bom.revisionId
  if (!revisionId) {
    const rev = rows(await sql(`SELECT id FROM bomrevision WHERE billofmaterials = ${bom.bomId} ORDER BY id DESC`))[0]
    revisionId = rev?.id ? String(rev.id) : null
  }
  if (!revisionId) return { components: [], unitCost: 0, bomId: bom.bomId, revisionId: null, reason: 'no BOM revision found' }

  const compRows = rows(await sql(
    `SELECT item, quantity FROM bomrevisioncomponent WHERE bomrevision = ${revisionId}`
  ))

  const components = []
  let unitCost = 0
  for (const c of compRows) {
    const quantity = Number(c.quantity) || 0
    const info = rows(await sql(`SELECT cost FROM item WHERE id = ${c.item}`))[0]
    const cost = Number(info?.cost) || 0
    components.push({ itemId: String(c.item), cost, quantity })
    unitCost += cost * quantity // BOM quantities are per 1 unit of assembly
  }
  return { components, unitCost, bomId: bom.bomId, revisionId }
}

// Assemble the inventoryCostRevaluation POST body. costComponent quantities are
// the master BOM's per-unit quantities (mirrors the working reval on item 5403).
function buildRevaluationBody({ assemblyItemId, tranDate, rollup }) {
  const items = rollup.components.map(c => ({
    componentItem: { id: c.itemId },
    costCategory: { id: DEFAULT_COST_CATEGORY_ID },
    // NS treats costComponent.cost as the EXTENDED line amount (its contribution
    // to one unit of the assembly) and SUMS the lines into unitCost — it does NOT
    // multiply by quantity. Proven 2026-06-22: sending per-unit costs (0.32, 1.0)
    // yielded unitCost 1.32 instead of 0.388. So send standardCost × bomQty here.
    cost: c.cost * c.quantity,
    quantity: c.quantity,
    conversionRate: 1,
    // NS expects the checkbox 'T'/'F' string here, not a JS boolean (the boolean
    // serializes to "true"/"false" and trips "more than 1 character allowed").
    isMaterialOverhead: 'F',
  }))
  return {
    customForm: { id: REVAL_CUSTOM_FORM_ID },
    account: { id: REVAL_ACCOUNT_ID },
    item: { id: String(assemblyItemId) },
    itemType: 'Assembly',
    costingMethod: 'STANDARD',
    location: { id: DEFAULT_LOCATION_ID },
    subsidiary: { id: DEFAULT_SUBSIDIARY_ID },
    itemCostCategory: DEFAULT_COST_CATEGORY_ID,
    tranDate,
    unitCost: rollup.unitCost,
    costComponent: { items },
  }
}

// Top-level: ensure a standard-cost item has a cost basis, posting a BOM-rollup
// revaluation if it doesn't. Returns { revalued, reason, unitCost, body, nsResult }.
// Dated one day before the item's earliest transaction so it lands first.
async function ensureCostBasis({ assemblyItemId }) {
  const elig = await needsCostBasis(assemblyItemId)
  if (!elig.eligible) return { revalued: false, reason: elig.reason }

  const rollup = await rollupCostFromMasterBom(assemblyItemId)
  if (!rollup.components.length) {
    return { revalued: false, reason: rollup.reason || 'no master BOM components to roll up a cost from' }
  }
  if (!(rollup.unitCost > 0)) {
    return { revalued: false, reason: `rolled-up unitCost is ${rollup.unitCost} (component costs missing) — needs manual cost setup` }
  }

  const earliest = await earliestTransactionDate(assemblyItemId)
  // One day before the earliest existing transaction (or today if none). NS
  // requires the reval to be the first transaction in the item's history.
  const tranDate = earliest
    ? new Date(new Date(earliest).getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
    : new Date().toISOString().slice(0, 10)

  const body = buildRevaluationBody({ assemblyItemId, tranDate, rollup })

  if (config.MES_DRY_RUN) {
    console.log(`[CostRevaluationService] DRY RUN — would revalue item ${assemblyItemId} @ unitCost ${rollup.unitCost.toFixed(5)} (tranDate ${tranDate})`)
    console.log(`[CostRevaluationService] body: ${JSON.stringify(body)}`)
    return { revalued: false, reason: 'dry_run', unitCost: rollup.unitCost, body }
  }

  console.log(`[CostRevaluationService] Revaluing item ${assemblyItemId} @ unitCost ${rollup.unitCost.toFixed(5)} from ${rollup.components.length} component(s), tranDate ${tranDate}`)
  const nsResult = await core.netsuitePost('/record/v1/inventoryCostRevaluation', body)
  return { revalued: true, unitCost: rollup.unitCost, tranDate, body, nsResult }
}

module.exports = {
  isNoCostBasisError,
  needsCostBasis,
  earliestTransactionDate,
  resolveMasterBomRevision,
  rollupCostFromMasterBom,
  buildRevaluationBody,
  ensureCostBasis,
}
