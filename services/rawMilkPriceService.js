const core = require('../clients/coreClient')
const config = require('../config')
const db = require('../models')
const statusStore = require('./statusStore')
const { RAW_ITEMS, PRODUCT_INDEX_ITEM_MAP } = require('./mesItemConfig')
const surgeParser = require('./surgeTankProductParser')
const blendParser = require('./blendTankProductParser')

/**
 * Raw milk price service (SD-717) — derives per-family $/lb from NetSuite
 * purchase transactions and prices batch waste with it.
 *
 * Why transactions, not item records: item.averagecost is unreliable for
 * these items (placeholder $0.01 on Organic Raw Milk, unit-mangled values on
 * the Raw assemblies). VendBill / ItemRcpt line rates are what was actually
 * paid per lb (stock unit for all raw milk items is Pound).
 *
 * Families (v1, family-level per Andrew 2026-09-02; BOM explosion is v2):
 *   organic / conventional / a2 / cream_organic / cream_conventional
 * A2 has no priced purchase transactions in NS at all — it stays 'manual'
 * (entered via POST /api/mes/config/costs/raw-milk) until that changes.
 */

// Trailing window for the qty-weighted average (Andrew 2026-09-02: 30 days;
// override via PRICE_SYNC_WINDOW_DAYS — dev's sandbox NS lags refreshes).
const WINDOW_DAYS = config.PRICE_SYNC_WINDOW_DAYS

// NS intake items whose purchase lines price each family. Ids come from the
// RAW_ITEMS taxonomy in mesItemConfig — the actually-purchased bulk items,
// not the per-fat-level split items (those are never on vendor bills).
const FAMILY_INTAKE_ITEMS = {
  organic:            [RAW_ITEMS.ORG_MILK.id],                          // 5404
  conventional:       [RAW_ITEMS.CONV_MILK.id],                         // 5417
  a2:                 [RAW_ITEMS.ORG_A2.id, RAW_ITEMS.ORG_A2_GRADE.id], // 5403, 5406
  cream_organic:      [RAW_ITEMS.ORG_CREAM.id],                         // 5483
  cream_conventional: [RAW_ITEMS.CONV_CREAM.id],                        // 5480
}
const FAMILIES = Object.keys(FAMILY_INTAKE_ITEMS)

// ── Batch → family classification ───────────────────────────────────────────

// Any RAW_ITEMS id → family, keyed off the taxonomy key names. A2 cream maps
// to cream_organic (closest priced family). NOTE lineIngredientMapper.js uses
// 5477 for Raw Conv 0% where RAW_ITEMS says 8163 — pre-existing inconsistency;
// this map keys on RAW_ITEMS and does not try to fix it.
const RAW_ID_FAMILY = {}
for (const [key, item] of Object.entries(RAW_ITEMS)) {
  RAW_ID_FAMILY[String(item.id)] =
    key.includes('CREAM') ? (key.startsWith('CONV') ? 'cream_conventional' : 'cream_organic')
      : key.startsWith('ORG_A2') ? 'a2'
        : key.startsWith('ORG') ? 'organic'
          : 'conventional'
}

// Catalog product (surge FG / blend raw-FG) → family via its modifiers.
// There is no 'conventional' modifier — conventional is the absence of
// 'organic'. Half-&-half priced at the full cream rate is a documented v1
// approximation (it's ~half milk).
function familyForProduct(product) {
  if (!product) return null
  const mods = product.modifiers || []
  const organic = mods.includes('organic')
  if (mods.includes('heavycream') || mods.includes('halfhalf')) {
    return organic ? 'cream_organic' : 'cream_conventional'
  }
  if (mods.includes('a2')) return 'a2'
  return organic ? 'organic' : 'conventional'
}

// Catalog id → family, both parsers, computed once. Blend catalog carries the
// raw-FG ids that appear as componentItemId on blend-tank-sourced surge
// batches (e.g. 8352); surge catalog carries the FG ids (mesItem).
const CATALOG_ID_FAMILY = {}
for (const p of [...blendParser.PRODUCT_CATALOG, ...surgeParser.PRODUCT_CATALOG]) {
  const fam = familyForProduct(p)
  if (fam && CATALOG_ID_FAMILY[String(p.nsId)] === undefined) {
    CATALOG_ID_FAMILY[String(p.nsId)] = fam
  }
}

/**
 * Classify a batch for pricing. componentItemId (the consumed raw item,
 * pinned at WO create) wins; falls back to the FG mesItem; null when neither
 * classifies (consumers then use the flat global milkCostPerLb).
 */
function familyForBatch(componentItemId, mesItem) {
  for (const raw of [componentItemId, mesItem]) {
    if (raw == null || raw === '') continue
    const id = String(raw)
    if (RAW_ID_FAMILY[id]) return RAW_ID_FAMILY[id]
    if (CATALOG_ID_FAMILY[id]) return CATALOG_ID_FAMILY[id]
  }
  return null
}

// ── NetSuite derivation ─────────────────────────────────────────────────────

function sql(q) {
  // Proven SuiteQL path; the core.suiteQL() helper route is mis-wired.
  return core.netsuitePost('/query/v1/suiteql', { q })
}
function rows(res) {
  return res?.items || res?.body?.items || []
}

/**
 * Qty-weighted average $/lb per family over the trailing window.
 * VendBill rates (what was actually paid) win; ItemRcpt rates are the
 * fallback when bills lag; zero rates are always excluded. Families with no
 * priced lines in the window are simply absent from the result.
 * Returns { family: { price, basis } }.
 */
async function deriveFamilyPrices() {
  const allIds = Object.values(FAMILY_INTAKE_ITEMS).flat()
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000)
    .toISOString().slice(0, 10)
  const q = `
    SELECT tl.item AS itemid, t.type AS ttype,
           SUM(ABS(tl.rate) * ABS(tl.quantity)) AS dollars,
           SUM(ABS(tl.quantity)) AS lbs
    FROM transactionline tl
    JOIN transaction t ON t.id = tl.transaction
    WHERE t.type IN ('VendBill', 'ItemRcpt')
      AND tl.item IN (${allIds.join(', ')})
      AND ABS(tl.rate) > 0
      AND t.trandate >= TO_DATE('${since}', 'YYYY-MM-DD')
    GROUP BY tl.item, t.type
  `
  const lines = rows(await sql(q))

  const out = {}
  for (const [family, ids] of Object.entries(FAMILY_INTAKE_ITEMS)) {
    const idSet = new Set(ids.map(String))
    for (const ttype of ['VendBill', 'ItemRcpt']) {
      let dollars = 0
      let lbs = 0
      for (const l of lines) {
        if (l.ttype !== ttype || !idSet.has(String(l.itemid))) continue
        dollars += Number(l.dollars) || 0
        lbs += Number(l.lbs) || 0
      }
      if (lbs > 0) {
        out[family] = {
          price: Math.round((dollars / lbs) * 10000) / 10000,
          basis: `${ttype} wavg ${WINDOW_DAYS}d · item ${ids.join('+')} · ${Math.round(lbs).toLocaleString()} lb`,
        }
        break
      }
    }
  }
  return out
}

// ── Current prices (cached for the process lifetime, cleared on write) ──────

let _currentCache = null

function clearCache() {
  _currentCache = null
}

/** Newest row per family: { family: { pricePerLb, source, basis, effectiveFrom } } */
async function getCurrentPrices() {
  if (_currentCache) return _currentCache
  const all = await db.MesRawMilkPrice.findAll({
    order: [['effectiveFrom', 'DESC'], ['id', 'DESC']],
  })
  const current = {}
  for (const row of all) {
    if (!current[row.family]) {
      current[row.family] = {
        pricePerLb: Number(row.pricePerLb),
        source: row.source,
        basis: row.basis || null,
        effectiveFrom: row.effectiveFrom,
      }
    }
  }
  _currentCache = current
  return current
}

/** Flat global fallback from MesCostConfig (SD-717's hand-entered price). */
async function getGlobalMilkPrice() {
  const latest = await db.MesCostConfig.findOne({
    order: [['effectiveFrom', 'DESC'], ['id', 'DESC']],
  })
  return latest && latest.milkCostPerLb != null ? Number(latest.milkCostPerLb) : null
}

/** Everything a pricing consumer needs in one call. */
async function getPricingContext() {
  const [prices, globalPrice] = await Promise.all([getCurrentPrices(), getGlobalMilkPrice()])
  return { prices, globalPrice }
}

/** $/lb for one batch under a pricing context (null = nothing applicable). */
function priceForBatch(componentItemId, mesItem, ctx) {
  const family = familyForBatch(componentItemId, mesItem)
  const famPrice = family && ctx.prices[family] ? ctx.prices[family].pricePerLb : null
  return { family, pricePerLb: famPrice != null ? famPrice : ctx.globalPrice }
}

function appendManual({ family, pricePerLb, note }) {
  return db.MesRawMilkPrice.create({
    family,
    pricePerLb,
    source: 'manual',
    basis: note != null ? String(note).slice(0, 200) : null,
  }).then(row => {
    clearCache()
    return row
  })
}

// ── Daily sync ──────────────────────────────────────────────────────────────

/**
 * Append an 'ns' row for every family whose derived price moved (> $0.0001)
 * or that has no row yet. Families NS can't derive (no priced lines — A2) are
 * left entirely alone, so their manual rows stand. A manual override of a
 * DERIVABLE family is re-asserted by the next sync when the NS price differs —
 * NS is the source of truth wherever it has data.
 */
async function syncTick() {
  const derived = await deriveFamilyPrices()
  const current = await getCurrentPrices()
  const changes = []
  for (const [family, d] of Object.entries(derived)) {
    const cur = current[family]
    if (cur && Math.abs(cur.pricePerLb - d.price) <= 0.0001) continue
    await db.MesRawMilkPrice.create({
      family,
      pricePerLb: d.price,
      source: 'ns',
      basis: d.basis,
    })
    changes.push({ family, from: cur ? cur.pricePerLb : null, to: d.price, overrodeManual: cur?.source === 'manual' })
  }
  if (changes.length) {
    clearCache()
    statusStore.pushEvent(
      'priceSync.updated',
      `Raw milk prices updated: ${changes.map(c => `${c.family} ${c.from != null ? `$${c.from}→` : ''}$${c.to}${c.overrodeManual ? ' (over manual)' : ''}`).join(', ')}`,
      { changes, windowDays: WINDOW_DAYS }
    )
  }
  return { derivedFamilies: Object.keys(derived), updated: changes.length }
}

// ── SQL expressions for aggregate waste-$ ───────────────────────────────────

function sqlIdList(ids) {
  // componentItemId / mesItem are STRING columns holding numeric ids.
  return ids.map(id => `'${String(id).replace(/'/g, '')}'`).join(', ')
}

/** { family: [ids…] } over both the RAW_ITEMS taxonomy and the two catalogs. */
function familyIdLists() {
  const familyIds = {}
  for (const [id, fam] of Object.entries(RAW_ID_FAMILY)) (familyIds[fam] ||= []).push(id)
  for (const [id, fam] of Object.entries(CATALOG_ID_FAMILY)) (familyIds[fam] ||= []).push(id)
  return familyIds
}

/**
 * { family: [HMI product indices…] } — separation batches store the HMI
 * product index ('15' conventional bulk, '16' organic bulk, '21' A2…) in
 * itemId, not an NS item id. Resolved through PRODUCT_INDEX_ITEM_MAP.
 */
function familyIndexLists() {
  const out = {}
  for (const [idx, item] of Object.entries(PRODUCT_INDEX_ITEM_MAP)) {
    if (!item || item.id == null) continue
    const fam = RAW_ID_FAMILY[String(item.id)]
    if (fam) (out[fam] ||= []).push(String(idx))
  }
  return out
}

/** Family for an HMI product index (separation batches' itemId), or null. */
function familyForProductIndex(idx) {
  const item = PRODUCT_INDEX_ITEM_MAP[Number(idx)]
  return item && item.id != null ? RAW_ID_FAMILY[String(item.id)] || null : null
}

/**
 * CASE literal classifying a row into a family name (or NULL), mirroring
 * familyForBatch: the first column in `cols` wins, then the next. `indexCols`
 * are columns holding an HMI product index instead of an item id. All
 * interpolated values are constant id lists — no request input.
 */
function familyCaseExpr({ cols = ['componentItemId', 'mesItem'], indexCols = [] } = {}) {
  const familyIds = familyIdLists()
  const familyIdx = familyIndexLists()
  const branches = []
  for (const col of cols) {
    for (const family of FAMILIES) {
      if (!familyIds[family] || !familyIds[family].length) continue
      branches.push(`WHEN [${col}] IN (${sqlIdList(familyIds[family])}) THEN '${family}'`)
    }
  }
  for (const col of indexCols) {
    for (const family of FAMILIES) {
      if (!familyIdx[family] || !familyIdx[family].length) continue
      branches.push(`WHEN [${col}] IN (${sqlIdList(familyIdx[family])}) THEN '${family}'`)
    }
  }
  return branches.length ? `CASE ${branches.join(' ')} ELSE NULL END` : 'NULL'
}

/**
 * CASE literal yielding the $/lb for a row, mirroring priceForBatch: only
 * families with a current price get a branch; ELSE the global price when
 * given, else NULL. Returns null when nothing can price anything (callers
 * then omit the $ column). Values are our own DECIMAL rows — no request input.
 */
function pricePerLbCaseExpr(prices, globalPrice, { cols = ['componentItemId', 'mesItem'], indexCols = [] } = {}) {
  const familyIds = familyIdLists()
  const familyIdx = familyIndexLists()
  const branches = []
  for (const col of cols) {
    for (const family of FAMILIES) {
      const p = prices[family]
      if (!p || !familyIds[family] || !familyIds[family].length) continue
      branches.push(`WHEN [${col}] IN (${sqlIdList(familyIds[family])}) THEN ${Number(p.pricePerLb)}`)
    }
  }
  for (const col of indexCols) {
    for (const family of FAMILIES) {
      const p = prices[family]
      if (!p || !familyIdx[family] || !familyIdx[family].length) continue
      branches.push(`WHEN [${col}] IN (${sqlIdList(familyIdx[family])}) THEN ${Number(p.pricePerLb)}`)
    }
  }
  const elsePrice = globalPrice != null ? Number(globalPrice) : null
  if (!branches.length && elsePrice == null) return null
  return branches.length
    ? `CASE ${branches.join(' ')} ELSE ${elsePrice != null ? elsePrice : 'NULL'} END`
    : `${elsePrice}`
}

/**
 * A SUM(...) literal mirroring familyForBatch/priceForBatch for the analytics
 * summary: componentItemId branches first, then mesItem, ELSE the global
 * price. Returns null when no per-family prices exist AND there is no global
 * price (callers then omit totalWasteUsd entirely).
 */
function wasteUsdCaseExpr(prices, globalPrice, { wasteCol = 'wasteLbs', cols = ['componentItemId', 'mesItem'] } = {}) {
  const caseExpr = pricePerLbCaseExpr(prices, globalPrice, { cols })
  if (caseExpr == null) return null
  return `SUM([${wasteCol}] * ${caseExpr})`
}

module.exports = {
  FAMILIES,
  FAMILY_INTAKE_ITEMS,
  WINDOW_DAYS,
  familyForBatch,
  deriveFamilyPrices,
  getCurrentPrices,
  getGlobalMilkPrice,
  getPricingContext,
  priceForBatch,
  appendManual,
  syncTick,
  wasteUsdCaseExpr,
  familyCaseExpr,
  pricePerLbCaseExpr,
  familyForProductIndex,
  clearCache,
}
