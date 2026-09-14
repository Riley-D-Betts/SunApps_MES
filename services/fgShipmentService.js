'use strict'

/**
 * Shipped vs produced (SD-722) — the last step of the Milk Loss product path,
 * from NetSuite (read-only SuiteQL through the gateway).
 *
 * What NetSuite holds for finished goods (item.custitem6 = 1), verified
 * against prod 2026-09-14:
 *   - WOCompl: produced cases on the mainline (a shadow line carries −qty;
 *     counting both doubles). isinventoryaffecting = 'T' is that mainline.
 *   - ItemShip: every fulfilment line appears THREE times (mainline −qty, a
 *     COGS +qty, an ASSET −qty). Only the ASSET line has
 *     isinventoryaffecting = 'T' — that is shipped cases.
 *   - CustInvc: invoice lines (quantity < 0, mainline F) → cases and $.
 *   - InvAdjst: finished-goods adjustments, almost all posted by SunApps pallet
 *     tools with a memo "<reason> — Pallet P… quantity adjustment …", plus a
 *     "Created By Pallet Sync Script" book-to-physical true-up.
 *
 * What counts as LOSS here (decision 2026-09-14, stated in the report):
 *   - Produced − shipped is NOT loss: most of it is inventory on hand and
 *     timing (cases shipped this week were made last week). It is reported as
 *     volume context only.
 *   - Loss = finished goods written off by people: QC / samples, damage,
 *     failed / destroyed / dumped product.
 *   - Count corrections (op errors, recounts) and the pallet sync true-up are
 *     bookkeeping — shown separately, never counted as this window's loss.
 *     The sync true-up in particular reconciles product that went missing at
 *     some EARLIER time; it cannot be attributed to the window it posts in.
 *
 * Valuation (both $ bases, like every other step):
 *   - lb per case: bulk lb ÷ cases from WorkOrd lines (bulk FG consumed → SKU
 *     produced, trailing 180 days); fallback from the pack size in the item
 *     name (oz × pack ÷ 128 × LBS_PER_GAL), flagged.
 *   - cost: lb × raw-milk family price (family of the bulk item, else name).
 *   - revenue: cases × invoice $/case for that SKU (window, else trailing 90 d).
 */

const core = require('../clients/coreClient')
const itemConfig = require('./mesItemConfig')
const rawMilkPriceService = require('./rawMilkPriceService')
const surgeParser = require('./surgeTankProductParser')
const plantTime = require('../utils/plantTime')

const BULK_FG_IDS = surgeParser.PRODUCT_CATALOG.map(p => p.nsId)
const CACHE_MS = 10 * 60 * 1000
const _cache = new Map()

const num = v => (v == null || v === '' ? 0 : Number(v))
const round2 = v => Math.round(num(v) * 100) / 100

async function suiteql(sql) {
  const out = []
  for (let offset = 0; offset < 20000; offset += 1000) {
    const res = await core.netsuitePost(`/query/v1/suiteql?limit=1000&offset=${offset}`, { q: sql })
    const body = res?.body || res
    const items = body?.items || []
    for (const { links, ...r } of items) out.push(r)
    if (!body?.hasMore) break
  }
  return out
}

const nsDate = d => `TO_DATE('${d}', 'YYYY-MM-DD')`

function classifyAdjustment(memo) {
  const m = String(memo || '')
  if (/pallet sync script/i.test(m)) return 'reconciliation'
  const reason = m.split(' — ')[0].trim().toLowerCase()
  if (/sample|\bqc\b|\bqa\b|testing|retain|lab/.test(reason)) return 'qc'
  if (/damag|broke|leak|crush|dent|spill|drop|forklift|punctur/.test(reason)) return 'damage'
  if (/fail|dump|destroy|expir|spoil|scrap|dispos|trash|discard|sour|recall/.test(reason)) return 'destroyed'
  return 'correction'
}
const LOSS_KINDS = new Set(['qc', 'damage', 'destroyed'])
const KIND_LABEL = { qc: 'QC / samples', damage: 'Damage', destroyed: 'Failed / destroyed', correction: 'Count corrections', reconciliation: 'Pallet sync true-up' }

function packSizeLbPerCase(name) {
  const m = String(name || '').match(/(\d+(?:\.\d+)?)\s*oz\.?[^0-9]*?(\d+)\s*(?:pack|pk|ct)/i)
  if (!m) return null
  return round2((Number(m[1]) * Number(m[2]) / 128) * itemConfig.LBS_PER_GAL)
}

function familyFromName(name) {
  const n = String(name || '').toLowerCase()
  const organic = /organic/.test(n)
  if (/half\s*(and|&)\s*half|cream|whip/.test(n)) return organic ? 'cream_organic' : 'cream_conventional'
  if (/a2/.test(n)) return 'a2'
  return organic ? 'organic' : 'conventional'
}

/**
 * The shipping step for plant days [fromDay, toDay] (inclusive).
 * Returns { available, error?, producedCases, shippedCases, invoicedCases,
 * gapCases, writeOff{cases, lbs, costUsd, revenueUsd, byKind[], byItem[]}, bookkeeping[],
 * byItem[], lossRows[{day, item, name, family, cases, lbs, costUsd, revenueUsd}] }.
 */
async function getShippingStep({ fromDay, toDay, prices }) {
  const key = `${fromDay}|${toDay}|${JSON.stringify(Object.entries(prices || {}).map(([f, p]) => [f, p.pricePerLb]))}`
  const hit = _cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

  let value
  try {
    value = await compute({ fromDay, toDay, prices: prices || {} })
  } catch (err) {
    console.warn(`[FgShipmentService] NetSuite unavailable: ${err.message.slice(0, 200)}`)
    value = { available: false, error: 'NetSuite could not be reached for shipped vs produced', fromDay, toDay }
  }
  _cache.set(key, { at: Date.now(), value })
  return value
}

async function compute({ fromDay, toDay, prices }) {
  const W = `t.trandate >= ${nsDate(fromDay)} AND t.trandate <= ${nsDate(toDay)}`
  const [produced, shipped, invoiced, adjustments] = await Promise.all([
    suiteql(`
      SELECT tl.item, BUILTIN.DF(tl.item) AS name, SUM(tl.quantity) AS cases
      FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' AND tl.isinventoryaffecting = 'T'
      JOIN item i ON i.id = tl.item AND i.custitem6 = 1
      WHERE t.type = 'WOCompl' AND ${W}
      GROUP BY tl.item, BUILTIN.DF(tl.item)`),
    suiteql(`
      SELECT tl.item, BUILTIN.DF(tl.item) AS name, SUM(ABS(tl.quantity)) AS cases
      FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.isinventoryaffecting = 'T'
      JOIN item i ON i.id = tl.item AND i.custitem6 = 1
      WHERE t.type = 'ItemShip' AND ${W}
      GROUP BY tl.item, BUILTIN.DF(tl.item)`),
    suiteql(`
      SELECT tl.item, SUM(ABS(tl.quantity)) AS cases, SUM(ABS(tl.netamount)) AS dollars
      FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'F' AND tl.quantity < 0
      JOIN item i ON i.id = tl.item AND i.custitem6 = 1
      WHERE t.type = 'CustInvc' AND ${W}
      GROUP BY tl.item`),
    suiteql(`
      SELECT t.id, TO_CHAR(t.trandate, 'YYYY-MM-DD') AS day, t.memo, tl.item, BUILTIN.DF(tl.item) AS name, tl.quantity
      FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.isinventoryaffecting = 'T'
      JOIN item i ON i.id = tl.item AND i.custitem6 = 1
      WHERE t.type = 'InvAdjst' AND ${W}`),
  ])

  const names = {}
  for (const r of [...produced, ...shipped, ...adjustments]) if (r.name) names[String(r.item)] = r.name
  const adjItems = [...new Set(adjustments.map(a => String(a.item)))]

  // Valuation inputs for the items that were written off.
  const lossItems = [...new Set(adjustments.filter(a => LOSS_KINDS.has(classifyAdjustment(a.memo)) && num(a.quantity) < 0).map(a => String(a.item)))]
  const valuationItems = [...new Set([...lossItems, ...adjItems])]
  const [caseLbs, priceWindow, price90] = valuationItems.length ? await Promise.all([
    suiteql(`
      SELECT tl2.item AS sku, tl1.item AS bulk, SUM(ABS(tl1.quantity)) AS bulklbs, SUM(tl2.quantity) AS cases
      FROM transactionline tl1 JOIN transaction t ON t.id = tl1.transaction
      JOIN transactionline tl2 ON tl2.transaction = t.id AND tl2.quantity > 0 AND tl2.item != tl1.item
      WHERE t.type = 'WorkOrd' AND tl1.quantity < 0 AND tl1.item IN (${BULK_FG_IDS.join(', ')})
        AND tl2.item IN (${valuationItems.join(', ')})
        AND t.trandate >= ${nsDate(plantTime.addPlantDays(toDay, -180))}
      GROUP BY tl2.item, tl1.item`),
    Promise.resolve(invoiced),
    suiteql(`
      SELECT tl.item, SUM(ABS(tl.quantity)) AS cases, SUM(ABS(tl.netamount)) AS dollars
      FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'F' AND tl.quantity < 0
      WHERE t.type = 'CustInvc' AND tl.item IN (${valuationItems.join(', ')})
        AND t.trandate >= ${nsDate(plantTime.addPlantDays(toDay, -90))} AND t.trandate <= ${nsDate(toDay)}
      GROUP BY tl.item`),
  ]) : [[], [], []]

  const lbPerCase = {}
  const bulkOf = {}
  const bestCases = {}
  for (const r of caseLbs) {
    const sku = String(r.sku), cases = num(r.cases)
    if (cases <= 0) continue
    if (!bestCases[sku] || cases > bestCases[sku]) {
      bestCases[sku] = cases
      lbPerCase[sku] = { value: round2(num(r.bulklbs) / cases), source: 'work orders' }
      bulkOf[sku] = String(r.bulk)
    }
  }
  const pricePerCase = {}
  for (const r of price90) if (num(r.cases) > 0) pricePerCase[String(r.item)] = { value: num(r.dollars) / num(r.cases), source: 'invoices 90d' }
  for (const r of priceWindow) if (num(r.cases) > 0) pricePerCase[String(r.item)] = { value: num(r.dollars) / num(r.cases), source: 'invoices in window' }

  function valueOf(item, cases) {
    const lpc = lbPerCase[item] || (packSizeLbPerCase(names[item]) != null ? { value: packSizeLbPerCase(names[item]), source: 'pack size' } : null)
    const family = (bulkOf[item] && rawMilkPriceService.familyForBatch(null, bulkOf[item])) || familyFromName(names[item])
    const lbs = lpc ? cases * lpc.value : null
    const famPrice = prices[family] ? prices[family].pricePerLb : null
    const ppc = pricePerCase[item]
    return {
      lbs: lbs != null ? round2(lbs) : null,
      costUsd: lbs != null && famPrice != null ? round2(lbs * famPrice) : null,
      revenueUsd: ppc ? round2(cases * ppc.value) : null,
      family, lbPerCase: lpc ? lpc.value : null, lbPerCaseSource: lpc ? lpc.source : null,
      pricePerCase: ppc ? round2(ppc.value) : null,
    }
  }

  // Adjustments → loss vs bookkeeping, by kind, by item, by day.
  const kinds = {}
  const itemLoss = {}
  const dayLoss = {}
  for (const a of adjustments) {
    const kind = classifyAdjustment(a.memo)
    const q = num(a.quantity)
    const k = (kinds[kind] ||= { kind, label: KIND_LABEL[kind], countsAsLoss: LOSS_KINDS.has(kind), adjustments: new Set(), downCases: 0, upCases: 0 })
    k.adjustments.add(a.id)
    if (q < 0) k.downCases += -q; else k.upCases += q
    if (LOSS_KINDS.has(kind) && q < 0) {
      const item = String(a.item)
      itemLoss[item] = (itemLoss[item] || 0) + -q
      const d = (dayLoss[a.day] ||= {})
      d[item] = (d[item] || 0) + -q
    }
  }

  const byItemLoss = Object.entries(itemLoss).map(([item, cases]) => ({ item, name: names[item] || item, cases, ...valueOf(item, cases) }))
  const sum = (arr, k) => arr.reduce((t, r) => t + (r[k] || 0), 0)
  const writeOffCases = sum(byItemLoss, 'cases')
  // One row per (day, item) — the loss report turns these into stage rows so
  // shipping loss flows through headline, chain, rankings, trend and history
  // exactly like the MES stages. $ are null (not 0) where unpriced.
  const lossRows = []
  for (const [day, items] of Object.entries(dayLoss).sort()) {
    for (const [item, cases] of Object.entries(items)) {
      const v = valueOf(item, cases)
      lossRows.push({ day, item, name: names[item] || item, cases, lbs: v.lbs, costUsd: v.costUsd, revenueUsd: v.revenueUsd, family: v.family, pricePerLb: v.lbs && v.costUsd != null ? round2(v.costUsd / v.lbs * 10000) / 10000 : null, revenuePerLb: v.lbs && v.revenueUsd != null ? v.revenueUsd / v.lbs : null })
    }
  }

  const producedCases = round2(sum(produced.map(r => ({ c: num(r.cases) })), 'c'))
  const shippedCases = round2(sum(shipped.map(r => ({ c: num(r.cases) })), 'c'))
  const invoicedCases = round2(sum(invoiced.map(r => ({ c: num(r.cases) })), 'c'))

  const prodBy = Object.fromEntries(produced.map(r => [String(r.item), num(r.cases)]))
  const shipBy = Object.fromEntries(shipped.map(r => [String(r.item), num(r.cases)]))
  const items = [...new Set([...Object.keys(prodBy), ...Object.keys(shipBy), ...Object.keys(itemLoss)])]
  const byItem = items.map(item => ({
    item, name: names[item] || item,
    producedCases: round2(prodBy[item] || 0), shippedCases: round2(shipBy[item] || 0),
    gapCases: round2((prodBy[item] || 0) - (shipBy[item] || 0)),
    writeOffCases: round2(itemLoss[item] || 0),
  })).sort((a, b) => b.producedCases - a.producedCases)

  const kindList = Object.values(kinds).map(k => ({ kind: k.kind, label: k.label, countsAsLoss: k.countsAsLoss, adjustments: k.adjustments.size, downCases: round2(k.downCases), upCases: round2(k.upCases), netCases: round2(k.upCases - k.downCases) }))
  const unvalued = byItemLoss.filter(r => r.lbs == null).map(r => r.name)

  return {
    available: true, fromDay, toDay,
    producedCases, shippedCases, invoicedCases,
    gapCases: round2(producedCases - shippedCases),
    writeOff: {
      cases: round2(writeOffCases),
      lbs: round2(sum(byItemLoss, 'lbs')),
      costUsd: byItemLoss.some(r => r.costUsd != null) ? round2(sum(byItemLoss, 'costUsd')) : null,
      revenueUsd: byItemLoss.some(r => r.revenueUsd != null) ? round2(sum(byItemLoss, 'revenueUsd')) : null,
      unpricedCostLbs: round2(sum(byItemLoss.filter(r => r.costUsd == null), 'lbs')),
      unpricedRevenueCases: round2(sum(byItemLoss.filter(r => r.revenueUsd == null), 'cases')),
      byKind: kindList.filter(k => k.countsAsLoss),
      byItem: byItemLoss.sort((a, b) => (b.revenueUsd || 0) - (a.revenueUsd || 0)),
      unvaluedItems: unvalued,
    },
    bookkeeping: kindList.filter(k => !k.countsAsLoss),
    byItem,
    lossRows,
    definition: 'Loss = finished goods written off (QC/samples, damage, destroyed). Produced − shipped is inventory and timing, not loss. Count corrections and the pallet-sync true-up are bookkeeping and are not counted.',
  }
}

function clearCache() { _cache.clear() }

module.exports = { getShippingStep, classifyAdjustment, packSizeLbPerCase, familyFromName, clearCache, LOSS_KINDS }
