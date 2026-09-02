const core = require('../clients/coreClient')
const config = require('../config')
const db = require('../models')
const statusStore = require('./statusStore')
const surgeParser = require('./surgeTankProductParser')

/**
 * FG revenue rate service (SD-717) — what a pound of bulk finished goods
 * would have EARNED had it shipped as packaged product, derived per bulk FG
 * item from NetSuite transactions. Companion to rawMilkPriceService (which
 * prices waste at raw-milk INPUT cost); together they bracket what waste
 * actually costs the business.
 *
 * Derivation chain (validated live 2026-09-02): packaging WorkOrd
 * transactions consume the bulk assembly (negative lines) and output packaged
 * SKUs (positive lines) — that yields the real SKU mix AND lb-per-case with
 * no manual conversion tables. CustInvc lines give each SKU's qty-weighted
 * $/case. Then per bulk item:
 *
 *   revenuePerLb = Σ(outCases_S × invoice $/case_S) / Σ(bulkLbs_S)
 *
 * over SKUs having BOTH consumption and invoice data in the window.
 * e.g. 6420 → 6422 (8oz 18-pack) at 10.0 lb/case, $8.57/case ⇒ $0.86/lb,
 * vs $0.39/lb organic input cost.
 *
 * Caveats (surfaced in UI tooltips): WorkOrd lines are planned consumption;
 * the window's sales mix stands in for production mix; lost revenue assumes
 * the waste would have become sellable FG — an upper-bound-flavored measure.
 */

// 90d per Andrew (2026-09-02) — packaging WOs and invoices are chunkier than
// daily milk trucks; 90d keeps low-volume SKUs priced and the mix stable.
const WINDOW_DAYS = config.FG_REVENUE_WINDOW_DAYS

// Bulk FG scope: the surge parser catalog — exactly the ids `mesItem` takes.
const BULK_FG_IDS = surgeParser.PRODUCT_CATALOG.map(p => p.nsId)

function sql(q) {
  // Proven SuiteQL path; the core.suiteQL() helper route is mis-wired.
  return core.netsuitePost('/query/v1/suiteql', { q })
}
function rows(res) {
  return res?.items || res?.body?.items || []
}

/**
 * Derive revenue-per-lb for every bulk FG with packaging + invoice data in
 * the trailing window. Returns { fgItemId: { rate, basis } }.
 */
async function deriveRevenueRates() {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString().slice(0, 10)

  // 1. Packaging consumption: bulk (negative) → packaged SKU (positive) on
  // the same WorkOrd. tl2.item != tl1.item excludes the bulk item's own
  // double-entry ± pairs.
  const consumption = rows(await sql(`
    SELECT tl1.item AS bulkitem, tl2.item AS skuitem,
           SUM(ABS(tl1.quantity)) AS bulklbs,
           SUM(tl2.quantity) AS outcases
    FROM transactionline tl1
    JOIN transaction t ON t.id = tl1.transaction
    JOIN transactionline tl2 ON tl2.transaction = t.id
      AND tl2.quantity > 0 AND tl2.item != tl1.item
    WHERE t.type = 'WorkOrd'
      AND tl1.item IN (${BULK_FG_IDS.join(', ')})
      AND tl1.quantity < 0
      AND t.trandate >= TO_DATE('${since}', 'YYYY-MM-DD')
    GROUP BY tl1.item, tl2.item
  `))
  if (!consumption.length) return {}

  // 2. Invoice $/case for the SKUs found above.
  const skuIds = [...new Set(consumption.map(c => String(c.skuitem)))]
  const invoices = rows(await sql(`
    SELECT tl.item AS skuitem,
           SUM(ABS(tl.rate) * ABS(tl.quantity)) AS dollars,
           SUM(ABS(tl.quantity)) AS cases
    FROM transactionline tl
    JOIN transaction t ON t.id = tl.transaction
    WHERE t.type = 'CustInvc'
      AND tl.item IN (${skuIds.join(', ')})
      AND ABS(tl.rate) > 0
      AND t.trandate >= TO_DATE('${since}', 'YYYY-MM-DD')
    GROUP BY tl.item
  `))
  const priceBySku = {}
  for (const inv of invoices) {
    const cases = Number(inv.cases) || 0
    if (cases > 0) priceBySku[String(inv.skuitem)] = (Number(inv.dollars) || 0) / cases
  }

  // 3. Fold the SKU mix per bulk item — only SKUs with an invoice price count
  // (numerator AND denominator, so unpriced SKUs don't dilute the rate).
  const byBulk = {}
  for (const c of consumption) {
    const price = priceBySku[String(c.skuitem)]
    if (price == null) continue
    const bulkLbs = Number(c.bulklbs) || 0
    const outCases = Number(c.outcases) || 0
    if (bulkLbs <= 0 || outCases <= 0) continue
    const agg = (byBulk[String(c.bulkitem)] ||= { dollars: 0, lbs: 0, skus: [] })
    agg.dollars += outCases * price
    agg.lbs += bulkLbs
    agg.skus.push({ sku: String(c.skuitem), price, lbPerCase: bulkLbs / outCases })
  }

  const out = {}
  for (const [fgItemId, agg] of Object.entries(byBulk)) {
    if (agg.lbs <= 0) continue
    const basis = agg.skus.length === 1
      ? `${agg.skus[0].sku} $${agg.skus[0].price.toFixed(2)}/case ÷ ${agg.skus[0].lbPerCase.toFixed(1)} lb/case · ${WINDOW_DAYS}d`
      : `${agg.skus.length} SKUs · ${Math.round(agg.lbs).toLocaleString()} lb · ${WINDOW_DAYS}d mix`
    out[fgItemId] = {
      rate: Math.round((agg.dollars / agg.lbs) * 10000) / 10000,
      basis,
    }
  }
  return out
}

// ── Current rates (cached for the process lifetime, cleared on write) ───────

let _currentCache = null

function clearCache() {
  _currentCache = null
}

/** Newest row per fgItemId: { fgItemId: { revenuePerLb, source, basis, effectiveFrom } } */
async function getCurrentRates() {
  if (_currentCache) return _currentCache
  const all = await db.MesFgRevenueRate.findAll({
    order: [['effectiveFrom', 'DESC'], ['id', 'DESC']],
  })
  const current = {}
  for (const row of all) {
    if (!current[row.fgItemId]) {
      current[row.fgItemId] = {
        revenuePerLb: Number(row.revenuePerLb),
        source: row.source,
        basis: row.basis || null,
        effectiveFrom: row.effectiveFrom,
      }
    }
  }
  _currentCache = current
  return current
}

/** $/lb of forgone FG revenue for a batch's bulk item, or null. */
function rateForItem(mesItem, rates) {
  if (mesItem == null || mesItem === '') return null
  const r = rates[String(mesItem)]
  return r ? r.revenuePerLb : null
}

function appendManual({ fgItemId, revenuePerLb, note }) {
  return db.MesFgRevenueRate.create({
    fgItemId: String(fgItemId),
    revenuePerLb,
    source: 'manual',
    basis: note != null ? String(note).slice(0, 200) : null,
  }).then(row => {
    clearCache()
    return row
  })
}

// ── Daily sync (invoked from priceSyncJob alongside the milk sync) ──────────

/**
 * Append an 'ns' row per bulk item whose derived rate moved (> $0.0001) or
 * that has no row. Items NS can't derive are left alone (manual rows stand);
 * derivable items' manual overrides get re-asserted — same rule as milk.
 */
async function syncTick() {
  const derived = await deriveRevenueRates()
  const current = await getCurrentRates()
  const changes = []
  for (const [fgItemId, d] of Object.entries(derived)) {
    const cur = current[fgItemId]
    if (cur && Math.abs(cur.revenuePerLb - d.rate) <= 0.0001) continue
    await db.MesFgRevenueRate.create({
      fgItemId,
      revenuePerLb: d.rate,
      source: 'ns',
      basis: d.basis,
    })
    changes.push({ fgItemId, from: cur ? cur.revenuePerLb : null, to: d.rate })
  }
  if (changes.length) {
    clearCache()
    statusStore.pushEvent(
      'fgRevenue.updated',
      `FG revenue rates updated: ${changes.map(c => `item ${c.fgItemId} ${c.from != null ? `$${c.from}→` : ''}$${c.to}/lb`).join(', ')}`,
      { changes, windowDays: WINDOW_DAYS }
    )
  }
  return { derivedItems: Object.keys(derived), updated: changes.length }
}

// ── SQL expression for aggregate lost-revenue ───────────────────────────────

/**
 * SUM(wasteLbs * CASE mesItem …) literal for the analytics summary. No
 * global fallback — unpriced items contribute NULL (dropped by SUM), so the
 * total only covers priced batches. Values are our own DECIMAL rows and
 * constant ids — no request input. Returns null when no rates exist.
 */
function lostRevenueCaseExpr(rates, { wasteCol = 'wasteLbs' } = {}) {
  const branches = Object.entries(rates)
    .map(([id, r]) => `WHEN [mesItem] = '${String(id).replace(/'/g, '')}' THEN ${Number(r.revenuePerLb)}`)
  if (!branches.length) return null
  return `SUM([${wasteCol}] * CASE ${branches.join(' ')} ELSE NULL END)`
}

module.exports = {
  WINDOW_DAYS,
  BULK_FG_IDS,
  deriveRevenueRates,
  getCurrentRates,
  rateForItem,
  appendManual,
  syncTick,
  lostRevenueCaseExpr,
  clearCache,
}
