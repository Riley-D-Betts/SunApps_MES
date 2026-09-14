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
 * COHORT (Andrew, 2026-09-14): the step follows product PRODUCED in the window
 * forward to today — pallet details carry production date, fulfilment,
 * inventory status and pallet status — so product made before the window is
 * never counted just because it shipped during it.
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
 * The shipping step for product PRODUCED on plant days [fromDay, toDay]
 * (inclusive), followed forward to today. See the header for definitions.
 */
async function getShippingStep({ fromDay, toDay, prices }) {
  const key = `${fromDay}|${toDay}|${plantTime.plantDateString()}|${JSON.stringify(Object.entries(prices || {}).map(([f, p]) => [f, p.pricePerLb]))}`
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

// Destruction "Issue:" text is free-typed by QA; group it for an executive view
// and keep the raw spellings as examples.
function reasonGroup(raw) {
  const r = String(raw || '').toLowerCase()
  if (/\bcod\b/.test(r)) return 'COD'
  if (/bloat/.test(r)) return 'Bloaters'
  if (/charm/.test(r)) return 'Failed Charm test'
  if (/temp|time abuse|out to+ long/.test(r)) return 'Temperature / time abuse'
  if (/ls strip/.test(r)) return 'Missing LS strip'
  if (/leak|damag|crush/.test(r)) return 'Leaking / damaged'
  if (/rework/.test(r)) return 'Rework'
  if (/\bqa\b|\bqc\b|ph\b|micro|spec/.test(r)) return 'QA failure'
  return 'Reason not recorded'
}

// Pallet-detail inventory status → where that product is today.
function placeOf(d) {
  const status = String(d.status || '')
  const inactive = d.inactive === 'T'
  if (d.ful || String(d.palletstatus || '') === 'Shipped') return 'shipped'
  if (inactive) return status === 'Failed' ? 'destroyed' : 'superseded'
  if (status === 'Failed') return 'failedPending'
  if (status === 'On Hold') return 'onHold'
  if (status === 'Rework') return 'rework'
  if (/pending qc|retest/i.test(status)) return 'awaitingQc'
  if (status === 'Good') return 'onHand'
  return 'other'
}
const PLACE_LABEL = {
  shipped: 'Shipped', onHand: 'In inventory (good)', awaitingQc: 'Awaiting QC / retest', onHold: 'On hold', rework: 'Rework',
  failedPending: 'Failed — awaiting disposition', destroyed: 'Destroyed', other: 'Other status',
}

async function compute({ fromDay, toDay, prices }) {
  const PD = `pd.custrecord_pd_production_date >= ${nsDate(fromDay)} AND pd.custrecord_pd_production_date <= ${nsDate(toDay)}`
  const WC = `t.trandate >= ${nsDate(fromDay)} AND t.trandate <= ${nsDate(toDay)}`
  const [produced, pallets, details] = await Promise.all([
    suiteql(`
      SELECT tl.item, BUILTIN.DF(tl.item) AS name, SUM(tl.quantity) AS cases
      FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' AND tl.isinventoryaffecting = 'T'
      JOIN item i ON i.id = tl.item AND i.custitem6 = 1
      WHERE t.type = 'WOCompl' AND ${WC}
      GROUP BY tl.item, BUILTIN.DF(tl.item)`),
    suiteql(`
      SELECT p.custrecord_pallet_item AS item, COUNT(*) AS pallets
      FROM customrecord_pallet p JOIN transaction t ON t.id = p.custrecord_pallet_work_order_completion
      WHERE t.type = 'WOCompl' AND ${WC}
      GROUP BY p.custrecord_pallet_item`),
    suiteql(`
      SELECT pd.id, pd.isinactive AS inactive, pd.custrecord_pd_pallet AS pallet, p.name AS palletname,
             pd.custrecord_pd_item AS item, BUILTIN.DF(pd.custrecord_pd_item) AS name,
             pd.custrecord_pd_quantity AS qty, BUILTIN.DF(pd.custrecord_pd_inventory_status) AS status,
             BUILTIN.DF(p.custrecord_pallet_status) AS palletstatus, pd.custrecord_pd_item_fulfillment AS ful,
             TO_CHAR(pd.custrecord_pd_production_date, 'YYYY-MM-DD') AS day
      FROM customrecord_pallet_details pd JOIN customrecord_pallet p ON p.id = pd.custrecord_pd_pallet
      JOIN item i ON i.id = pd.custrecord_pd_item AND i.custitem6 = 1
      WHERE ${PD}`),
  ])

  const names = {}
  for (const r of [...produced, ...details]) if (r.name) names[String(r.item)] = r.name
  const palletDay = {}
  const palletNames = new Set()
  for (const d of details) { palletDay[d.palletname] = d.day; palletNames.add(d.palletname) }

  // Destruction reasons live in the notes of destroyed rows only — fetch those notes separately (small).
  const destroyedIds = details.filter(d => placeOf(d) === 'destroyed').map(d => d.id)
  const [destroyedNotes, adjustments] = await Promise.all([
    destroyedIds.length ? suiteql(`SELECT pd.id, pd.custrecord_pd_notes AS notes FROM customrecord_pallet_details pd WHERE pd.id IN (${destroyedIds.join(', ')})`) : Promise.resolve([]),
    // Pallet-tool adjustments that name a cohort pallet, posted any time since the window opened.
    suiteql(`
      SELECT t.id, t.memo, tl.item, BUILTIN.DF(tl.item) AS name, tl.quantity
      FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.isinventoryaffecting = 'T'
      JOIN item i ON i.id = tl.item AND i.custitem6 = 1
      WHERE t.type = 'InvAdjst' AND t.trandate >= ${nsDate(fromDay)} AND t.memo LIKE '%Pallet P%'`),
  ])
  const notesById = Object.fromEntries(destroyedNotes.map(n => [String(n.id), String(n.notes || '')]))
  for (const a of adjustments) if (a.name) names[String(a.item)] = a.name

  // ── Where the cohort is today ──
  const places = {}
  const bump = (place, d) => {
    const p = (places[place] ||= { place, label: PLACE_LABEL[place] || place, cases: 0, pallets: new Set() })
    p.cases += num(d.qty); p.pallets.add(String(d.pallet))
  }
  const destroyedReasons = {}
  const loss = [] // { day, item, cases, kind, reason }
  const atRisk = []
  for (const d of details) {
    const place = placeOf(d)
    if (place === 'superseded') continue // replaced by a transfer/split row that carries the quantity
    bump(place, d)
    if (place === 'destroyed' && num(d.qty) > 0) {
      const m = (notesById[String(d.id)] || '').match(/Issue:\s*([^/\n]+)/gi)
      const raw = m ? m[m.length - 1].replace(/Issue:\s*/i, '').trim() : ''
      const reason = reasonGroup(raw)
      const g = (destroyedReasons[reason] ||= { cases: 0, pallets: new Set(), examples: new Set() })
      g.cases += num(d.qty); g.pallets.add(String(d.pallet)); if (raw) g.examples.add(raw)
      loss.push({ day: d.day, item: String(d.item), cases: num(d.qty), kind: 'destroyed', reason })
    }
    if (place === 'failedPending' && num(d.qty) > 0) atRisk.push({ day: d.day, item: String(d.item), cases: num(d.qty) })
  }

  // ── Pallet-tool adjustments on cohort pallets ──
  const kinds = {}
  for (const a of adjustments) {
    const m = String(a.memo || '').match(/Pallet (P\d+)/)
    if (!m || !palletNames.has(m[1])) continue
    const kind = classifyAdjustment(a.memo)
    const q = num(a.quantity)
    const k = (kinds[kind] ||= { kind, label: KIND_LABEL[kind], countsAsLoss: LOSS_KINDS.has(kind), adjustments: new Set(), downCases: 0, upCases: 0 })
    k.adjustments.add(a.id)
    if (q < 0) k.downCases += -q; else k.upCases += q
    if (LOSS_KINDS.has(kind) && q < 0) loss.push({ day: palletDay[m[1]], item: String(a.item), cases: -q, kind, reason: KIND_LABEL[kind] })
  }

  // ── Valuation (lb/case, $/lb family, invoice $/case) for anything lost or at risk ──
  const valuationItems = [...new Set([...loss, ...atRisk].map(r => r.item))]
  const [caseLbs, price90] = valuationItems.length ? await Promise.all([
    suiteql(`
      SELECT tl2.item AS sku, tl1.item AS bulk, SUM(ABS(tl1.quantity)) AS bulklbs, SUM(tl2.quantity) AS cases
      FROM transactionline tl1 JOIN transaction t ON t.id = tl1.transaction
      JOIN transactionline tl2 ON tl2.transaction = t.id AND tl2.quantity > 0 AND tl2.item != tl1.item
      WHERE t.type = 'WorkOrd' AND tl1.quantity < 0 AND tl1.item IN (${BULK_FG_IDS.join(', ')})
        AND tl2.item IN (${valuationItems.join(', ')})
        AND t.trandate >= ${nsDate(plantTime.addPlantDays(toDay, -180))}
      GROUP BY tl2.item, tl1.item`),
    suiteql(`
      SELECT tl.item, SUM(ABS(tl.quantity)) AS cases, SUM(ABS(tl.netamount)) AS dollars
      FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'F' AND tl.quantity < 0
      WHERE t.type = 'CustInvc' AND tl.item IN (${valuationItems.join(', ')})
        AND t.trandate >= ${nsDate(plantTime.addPlantDays(toDay, -90))}
      GROUP BY tl.item`),
  ]) : [[], []]
  const lbPerCase = {}, bulkOf = {}, bestCases = {}
  for (const r of caseLbs) {
    const sku = String(r.sku), cases = num(r.cases)
    if (cases > 0 && (!bestCases[sku] || cases > bestCases[sku])) {
      bestCases[sku] = cases; lbPerCase[sku] = { value: round2(num(r.bulklbs) / cases), source: 'work orders' }; bulkOf[sku] = String(r.bulk)
    }
  }
  const pricePerCase = {}
  for (const r of price90) if (num(r.cases) > 0) pricePerCase[String(r.item)] = num(r.dollars) / num(r.cases)
  function valueOf(item, cases) {
    const packLb = packSizeLbPerCase(names[item])
    const lpc = lbPerCase[item] || (packLb != null ? { value: packLb, source: 'pack size' } : null)
    const family = (bulkOf[item] && rawMilkPriceService.familyForBatch(null, bulkOf[item])) || familyFromName(names[item])
    const lbs = lpc ? cases * lpc.value : null
    const famPrice = prices[family] ? prices[family].pricePerLb : null
    const ppc = pricePerCase[item]
    return {
      lbs: lbs != null ? round2(lbs) : null,
      costUsd: lbs != null && famPrice != null ? round2(lbs * famPrice) : null,
      revenueUsd: ppc != null ? round2(cases * ppc) : null,
      family, lbPerCase: lpc ? lpc.value : null, lbPerCaseSource: lpc ? lpc.source : null, pricePerCase: ppc != null ? round2(ppc) : null,
    }
  }
  const sumBy = (rows, fn) => rows.reduce((t, r) => t + (fn(r) || 0), 0)
  const valued = rows => {
    const byItem = {}
    for (const r of rows) byItem[r.item] = (byItem[r.item] || 0) + r.cases
    const items = Object.entries(byItem).map(([item, cases]) => ({ item, name: names[item] || item, cases: round2(cases), ...valueOf(item, cases) }))
    return {
      cases: round2(sumBy(items, r => r.cases)),
      lbs: round2(sumBy(items, r => r.lbs)),
      costUsd: items.some(r => r.costUsd != null) ? round2(sumBy(items, r => r.costUsd)) : null,
      revenueUsd: items.some(r => r.revenueUsd != null) ? round2(sumBy(items, r => r.revenueUsd)) : null,
      unpricedCostLbs: round2(sumBy(items.filter(r => r.costUsd == null), r => r.lbs)),
      topItems: items.sort((a, b) => (b.revenueUsd || 0) - (a.revenueUsd || 0)).slice(0, 10),
    }
  }

  // One loss row per (production day, item) so the report and history can bucket it.
  const lossRows = []
  const byDayItem = {}
  for (const r of loss) { if (!r.day) continue; const k = `${r.day}|${r.item}`; byDayItem[k] = (byDayItem[k] || 0) + r.cases }
  for (const [k, cases] of Object.entries(byDayItem).sort()) {
    const [day, item] = k.split('|')
    const v = valueOf(item, cases)
    lossRows.push({ day, item, name: names[item] || item, cases, lbs: v.lbs, costUsd: v.costUsd, revenueUsd: v.revenueUsd, family: v.family,
      pricePerLb: v.lbs && v.costUsd != null ? v.costUsd / v.lbs : null, revenuePerLb: v.lbs && v.revenueUsd != null ? v.revenueUsd / v.lbs : null })
  }

  const producedCases = round2(sumBy(produced, r => num(r.cases)))
  const producedPallets = sumBy(pallets, r => num(r.pallets))
  const placeList = Object.values(places).map(p => ({ place: p.place, label: p.label, cases: round2(p.cases), pallets: p.pallets.size,
    pctOfProduced: producedCases > 0 ? round2((p.cases / producedCases) * 100) : null }))
  const order = ['shipped', 'onHand', 'awaitingQc', 'onHold', 'rework', 'failedPending', 'destroyed', 'other']
  placeList.sort((a, b) => order.indexOf(a.place) - order.indexOf(b.place))
  const tracedCases = sumBy(placeList, p => p.cases)
  const place = k => placeList.find(p => p.place === k) || { cases: 0, pallets: 0 }
  const writeOffAdj = Object.values(kinds).filter(k => k.countsAsLoss)
  const writtenOffByAdjustment = round2(sumBy(writeOffAdj, k => k.downCases))

  // Per item: produced vs where it is now.
  const prodBy = Object.fromEntries(produced.map(r => [String(r.item), num(r.cases)]))
  const palBy = Object.fromEntries(pallets.map(r => [String(r.item), num(r.pallets)]))
  const itemPlaces = {}
  for (const d of details) {
    const pl = placeOf(d); if (pl === 'superseded') continue
    const it = (itemPlaces[String(d.item)] ||= {}); it[pl] = (it[pl] || 0) + num(d.qty)
  }
  const byItem = [...new Set([...Object.keys(prodBy), ...Object.keys(itemPlaces)])].map(item => {
    const p = itemPlaces[item] || {}
    return { item, name: names[item] || item, producedCases: round2(prodBy[item] || 0), producedPallets: palBy[item] || 0,
      shippedCases: round2(p.shipped || 0), onHandCases: round2((p.onHand || 0) + (p.awaitingQc || 0) + (p.onHold || 0) + (p.rework || 0)),
      failedPendingCases: round2(p.failedPending || 0), destroyedCases: round2(p.destroyed || 0),
      shippedPct: prodBy[item] > 0 ? round2(((p.shipped || 0) / prodBy[item]) * 100) : null }
  }).sort((a, b) => b.producedCases - a.producedCases)

  return {
    available: true, fromDay, toDay, asOf: plantTime.plantDateString(),
    cohort: 'Product produced in the window, followed to today (shipments after the window count; product made before it does not).',
    producedCases, producedPallets,
    shippedCases: place('shipped').cases, shippedPallets: place('shipped').pallets,
    shippedPctOfProduced: producedCases > 0 ? round2((place('shipped').cases / producedCases) * 100) : null,
    places: placeList,
    notTracedCases: round2(producedCases - tracedCases - writtenOffByAdjustment),
    loss: { ...valued(loss), destroyedCases: round2(sumBy(loss.filter(r => r.kind === 'destroyed'), r => r.cases)), destroyedPallets: place('destroyed').pallets,
      writtenOffCases: writtenOffByAdjustment,
      byReason: [
        ...Object.entries(destroyedReasons).map(([reason, g]) => ({ kind: 'destroyed', reason, label: `Destroyed — ${reason}`, cases: round2(g.cases), pallets: g.pallets.size, examples: [...g.examples].slice(0, 6) })),
        ...writeOffAdj.map(k => ({ kind: k.kind, reason: k.label, label: `Written off — ${k.label}`, cases: round2(k.downCases), adjustments: k.adjustments.size })),
      ].sort((a, b) => b.cases - a.cases),
      pctOfProduced: producedCases > 0 ? round2((sumBy(loss, r => r.cases) / producedCases) * 100) : null },
    atRisk: { ...valued(atRisk), pallets: place('failedPending').pallets, label: 'Failed — awaiting disposition (likely loss, not counted yet)' },
    bookkeeping: Object.values(kinds).filter(k => !k.countsAsLoss).map(k => ({ kind: k.kind, label: k.label, adjustments: k.adjustments.size, downCases: round2(k.downCases), upCases: round2(k.upCases), netCases: round2(k.upCases - k.downCases) })),
    byItem,
    lossRows,
    definition: 'Product produced in this window, followed to today. Loss = destroyed pallets (failed QC, out too long, temperature abuse …) plus cases written off for samples or damage. Failed pallets still awaiting a decision are shown as at risk, not counted. Shipped / in inventory / on hold are where the rest of the product is — not loss. Product made before the window is excluded even if it shipped during it.',
  }
}

function clearCache() { _cache.clear() }

module.exports = { getShippingStep, reasonGroup, classifyAdjustment, packSizeLbPerCase, familyFromName, placeOf, clearCache, LOSS_KINDS }
