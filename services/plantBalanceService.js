'use strict'

/**
 * Plant balance, received → cased (SD-722): where the milk that came in the
 * door went, for a window of plant days, from NetSuite (read-only SuiteQL).
 *
 *   lost before casing = received + tank drawdown − cased − bulk shipped
 *
 * Sources (verified against prod 2026-09-15, Aug 2026 audit):
 *   - received: customrecord_milk_truck net weight (custrecord_mt_nweight,
 *     else gross − tare) for trucks ARRIVING in the window with status
 *     Received or Pending External Results. Diverted / Failed QC / Pending QC
 *     trucks never entered a silo and are listed but not counted. Truck
 *     records are used instead of ItemRcpt because receipts post 2–3 weeks
 *     late; where every truck has its receipt, the linked ItemRcpt pounds are
 *     returned alongside as a check (they matched to the pound for August).
 *     `custrecord_mt_arrival` is a datetime: the upper edge is `< next day`.
 *   - tank drawdown: physical pounds in the silos, cream silos and blend tanks
 *     at each window edge, from the latest "Sweep reconcile" InvAdjst memo per
 *     tank before the edge ("MSilo1 item 5404 → 428321.73 lb (was …)"). A
 *     current-item memo sets the tank to that item alone; a "clear item"
 *     memo removes that item. Sweeps only post when a tank is at rest and off
 *     by ≥ 500 lb, so each tank's reading carries its age (`hoursOld`) and a
 *     stale reading is a caveat, not an error.
 *   - cased: WOCompl mainline cases × PHYSICAL lb per case (carton mL ×
 *     cartons per case × lb/gal, fgCartonVolumeService) — not the BOM lb/case,
 *     which under-states the fill by 10–20 %.
 *   - bulk shipped: ItemShip inventory lines on pound-unit raw / bulk items
 *     (item.custitem6 5 or 7), e.g. raw cream sold by the tanker.
 *   - destroyed after casing: the shipped-vs-produced cohort's loss pounds
 *     (fgShipmentService), shown for context — it happens after casing, so it
 *     is NOT part of "lost before casing".
 *
 * NetSuite createddate strings come back in plant time (checked against the
 * Filler 1 carton counters, 2026-09-10/11).
 */

const { suiteql, nsDate } = require('./fgShipmentService')
const cartons = require('./fgCartonVolumeService')
const plantTime = require('../utils/plantTime')

const CACHE_MS = 10 * 60 * 1000
const _cache = new Map()
const SWEEP_LOOKBACK_DAYS = 21
const STALE_HOURS = 72
const COUNTED_TRUCK_STATUS = ['4', '8']           // Received, Pending External Results
const RECEIVED_STATUS = '4'

const num = v => (v == null || v === '' ? 0 : Number(v))
const round2 = v => Math.round(num(v) * 100) / 100
const pctOf = (v, base) => (base > 0 ? round2((v / base) * 100) : null)

/** 'YYYY-MM-DD HH24:MI' plant wall-clock → UTC Date. */
function plantLocalToUtc(s) {
  const [day, hm = '00:00'] = String(s).split(' ')
  const [h, m] = hm.split(':').map(Number)
  return new Date(plantTime.startOfPlantDay(day).getTime() + (h * 60 + m) * 60000)
}

function tankGroup(tank) {
  if (/^MSilo/i.test(tank)) return 'silos'
  if (/^CSilo/i.test(tank)) return 'creamSilos'
  if (/^BlendTank/i.test(tank)) return 'blendTanks'
  return 'other'
}

/** Parse one sweep memo → { tank, item, kind: 'set'|'clear', lbs } or null. */
function parseSweepMemo(memo) {
  const m = String(memo || '')
  let r = m.match(/^Sweep reconcile: (\S+) item (\d+) → (-?[\d.]+) lb/)
  if (r) return { tank: r[1], item: r[2], kind: 'set', lbs: Number(r[3]) }
  r = m.match(/^Sweep reconcile: (\S+) clear item (\d+) /)
  if (r) return { tank: r[1], item: r[2], kind: 'clear', lbs: 0 }
  r = m.match(/^Sweep reconcile: clear stale product item (\d+) \(.*\) from (\S+)/)
  if (r) return { tank: r[2], item: r[1], kind: 'clear', lbs: 0 }
  return null // negative-lot clean-ups do not change what is physically in the tank
}

/** Replay memos (sorted by time) up to `edge` → { tank: { lbs, item, at, lastSetAt } }. */
function tanksAt(memos, edge) {
  const tanks = {}
  for (const x of memos) {
    if (x.at >= edge) break
    const t = (tanks[x.tank] ||= { contents: {}, at: null, lastSetAt: null })
    if (x.kind === 'set') { t.contents = { [x.item]: x.lbs }; t.lastSetAt = x.at } else delete t.contents[x.item]
    t.at = x.at
  }
  const out = {}
  for (const [tank, t] of Object.entries(tanks)) {
    const lbs = Object.values(t.contents).reduce((s, v) => s + Math.max(0, v), 0)
    out[tank] = { tank, group: tankGroup(tank), lbs: round2(lbs), items: Object.keys(t.contents), readingAt: t.at.toISOString(),
      hoursOld: round2((edge - t.at) / 3600000) }
  }
  return out
}

async function getPlantBalance({ fromDay, toDay, shipping = null }) {
  const key = `${fromDay}|${toDay}|${plantTime.plantDateString()}`
  const hit = _cache.get(key)
  let value
  if (hit && Date.now() - hit.at < CACHE_MS) value = hit.value
  else {
    try {
      value = await compute({ fromDay, toDay })
    } catch (err) {
      console.warn(`[PlantBalance] NetSuite unavailable: ${String(err.message).slice(0, 200)}`)
      value = { available: false, fromDay, toDay, error: 'NetSuite could not be reached for the plant balance' }
    }
    _cache.set(key, { at: Date.now(), value })
  }
  return value.available ? withShipping(value, shipping) : value
}

// The after-casing figure comes from the report's own shipping step (already
// cached there), so it is attached per call rather than cached here.
function withShipping(v, shipping) {
  const lbs = shipping && shipping.available && shipping.loss ? shipping.loss.lbs : null
  return {
    ...v,
    destroyedAfterCasing: {
      lbs: lbs != null ? round2(lbs) : null,
      pctOfReceived: lbs != null ? pctOf(lbs, v.received.lbs) : null,
      source: shipping && shipping.available ? 'Shipped vs produced cohort loss (destroyed pallets + write-offs), BOM lb per case' : 'unavailable',
    },
  }
}

async function compute({ fromDay, toDay }) {
  const endExcl = plantTime.addPlantDays(toDay, 1)
  const fromEdge = plantTime.startOfPlantDay(fromDay)
  const toEdge = plantTime.startOfPlantDay(endExcl)
  // Sweep memos only around each edge, so a long window never pages past the SuiteQL cap.
  const sweepSql = (edgeDay) => `
      SELECT t.id, t.memo, TO_CHAR(t.createddate, 'YYYY-MM-DD HH24:MI') AS ts
      FROM transaction t
      WHERE t.type = 'InvAdjst' AND t.memo LIKE 'Sweep reconcile:%'
        AND t.createddate >= ${nsDate(plantTime.addPlantDays(edgeDay, -SWEEP_LOOKBACK_DAYS))} AND t.createddate < ${nsDate(plantTime.addPlantDays(edgeDay, 1))}`

  const [trucks, wocompl, ships, sweepsStart, sweepsEnd] = await Promise.all([
    suiteql(`
      SELECT id, custrecord_mt_status AS st, BUILTIN.DF(custrecord_mt_status) AS stname,
             custrecord_mt_nweight AS net, custrecord_mt_gweight AS gross, custrecord_mt_tweight AS tare,
             custrecord_mt_item_receipt AS rc, TO_CHAR(custrecord_mt_arrival, 'YYYY-MM-DD') AS day
      FROM customrecord_milk_truck
      WHERE isinactive = 'F' AND custrecord_mt_arrival >= ${nsDate(fromDay)} AND custrecord_mt_arrival < ${nsDate(endExcl)}`),
    suiteql(`
      SELECT tl.item, BUILTIN.DF(tl.item) AS name, SUM(tl.quantity) AS cases
      FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T' AND tl.isinventoryaffecting = 'T'
      JOIN item i ON i.id = tl.item AND i.custitem6 = 1
      WHERE t.type = 'WOCompl' AND t.trandate >= ${nsDate(fromDay)} AND t.trandate < ${nsDate(endExcl)}
      GROUP BY tl.item, BUILTIN.DF(tl.item)`),
    suiteql(`
      SELECT tl.item, BUILTIN.DF(tl.item) AS name, SUM(tl.quantity) AS lbs, COUNT(DISTINCT t.id) AS shipments
      FROM transaction t JOIN transactionline tl ON tl.transaction = t.id AND tl.isinventoryaffecting = 'T'
      JOIN item i ON i.id = tl.item AND i.custitem6 IN (5, 7)
      WHERE t.type = 'ItemShip' AND BUILTIN.DF(i.stockunit) = 'Pound'
        AND t.trandate >= ${nsDate(fromDay)} AND t.trandate < ${nsDate(endExcl)}
      GROUP BY tl.item, BUILTIN.DF(tl.item)`),
    suiteql(sweepSql(fromDay)),
    suiteql(sweepSql(endExcl)),
  ])

  // ── Received ──
  const netOf = t => (t.net != null && t.net !== '' ? num(t.net) : (t.gross != null && t.tare != null ? num(t.gross) - num(t.tare) : 0))
  const counted = trucks.filter(t => COUNTED_TRUCK_STATUS.includes(String(t.st)))
  const excludedByStatus = {}
  for (const t of trucks.filter(x => !COUNTED_TRUCK_STATUS.includes(String(x.st)))) {
    const e = (excludedByStatus[t.stname || t.st] ||= { status: t.stname || String(t.st), trucks: 0, lbs: 0 })
    e.trucks += 1; e.lbs += netOf(t)
  }
  const receivedLbs = counted.reduce((s, t) => s + netOf(t), 0)
  const receiptIds = [...new Set(counted.filter(t => t.rc).map(t => String(t.rc)))]
  let linkedReceiptLbs = null
  if (receiptIds.length) {
    linkedReceiptLbs = 0
    for (let i = 0; i < receiptIds.length; i += 500) {
      const [r] = await suiteql(`
        SELECT SUM(tl.quantity) AS lbs FROM transactionline tl JOIN item i ON i.id = tl.item AND i.custitem6 = 7
        WHERE tl.isinventoryaffecting = 'T' AND tl.transaction IN (${receiptIds.slice(i, i + 500).join(', ')})`)
      linkedReceiptLbs += num(r && r.lbs)
    }
  }
  const withoutReceipt = counted.filter(t => !t.rc).length
  const pendingResults = counted.filter(t => String(t.st) !== RECEIVED_STATUS).length
  const receiptsComplete = counted.length > 0 && withoutReceipt === 0 && pendingResults === 0

  // ── Tank inventory at each edge ──
  const toMemos = rows => rows.map(s => ({ ...parseSweepMemo(s.memo), at: plantLocalToUtc(s.ts), id: s.id }))
    .filter(m => m.tank).sort((a, b) => a.at - b.at || Number(a.id) - Number(b.id))
  const start = tanksAt(toMemos(sweepsStart), fromEdge)
  const end = tanksAt(toMemos(sweepsEnd), toEdge)
  const tankNames = [...new Set([...Object.keys(start), ...Object.keys(end)])].sort()
  const groups = {}
  const tanks = tankNames.map(name => {
    const s = start[name], e = end[name]
    const g = (groups[tankGroup(name)] ||= { group: tankGroup(name), startLbs: 0, endLbs: 0 })
    g.startLbs += s ? s.lbs : 0; g.endLbs += e ? e.lbs : 0
    return { tank: name, group: tankGroup(name), startLbs: s ? s.lbs : null, startReadingAt: s ? s.readingAt : null, startHoursOld: s ? s.hoursOld : null,
      endLbs: e ? e.lbs : null, endReadingAt: e ? e.readingAt : null, endHoursOld: e ? e.hoursOld : null,
      stale: !s || !e || s.hoursOld > STALE_HOURS || e.hoursOld > STALE_HOURS }
  })
  const invStart = tanks.reduce((t, x) => t + num(x.startLbs), 0)
  const invEnd = tanks.reduce((t, x) => t + num(x.endLbs), 0)
  const drawdown = invStart - invEnd

  // ── Cased (physical) ──
  const names = Object.fromEntries(wocompl.map(r => [String(r.item), r.name]))
  const vols = await cartons.getCartonVolumes(Object.keys(names), names)
  const casedItems = wocompl.map(r => {
    const v = vols[String(r.item)] || {}
    const cases = num(r.cases)
    return { item: String(r.item), name: r.name, cases: round2(cases), mL: v.mL ?? null, cartonsPerCase: v.cartonsPerCase ?? null,
      lbPerCase: v.lbPerCase ?? null, lbs: v.lbPerCase != null ? round2(cases * v.lbPerCase) : null, volumeSource: v.source || 'unknown' }
  }).sort((a, b) => num(b.lbs) - num(a.lbs))
  const casedLbs = casedItems.reduce((t, r) => t + num(r.lbs), 0)
  const unvalued = casedItems.filter(r => r.lbs == null)

  // ── Bulk shipped ──
  const shipItems = ships.map(r => ({ item: String(r.item), name: r.name, lbs: round2(-num(r.lbs)), shipments: num(r.shipments) })).filter(r => r.lbs !== 0)
  const bulkShippedLbs = shipItems.reduce((t, r) => t + r.lbs, 0)

  const lostBeforeCasing = receivedLbs + drawdown - casedLbs - bulkShippedLbs

  const caveats = []
  if (!receiptsComplete) {
    const open = [withoutReceipt ? `${withoutReceipt} have no NetSuite item receipt yet` : null, pendingResults ? `${pendingResults} are still pending external results` : null].filter(Boolean)
    caveats.push(`Received pounds come from truck scale records, not item receipts (receipts post 2–3 weeks late). Of ${counted.length} counted truck(s), ${open.length ? open.join(' and ') : 'none have receipts yet'}.`)
  }
  if (linkedReceiptLbs != null && Math.abs(linkedReceiptLbs - receivedLbs) > 1) {
    caveats.push(`Truck net weight (${Math.round(receivedLbs).toLocaleString('en-US')} lb) and the item receipts linked to those trucks (${Math.round(linkedReceiptLbs).toLocaleString('en-US')} lb) differ by ${Math.round(receivedLbs - linkedReceiptLbs).toLocaleString('en-US')} lb; the truck scale figure is used.`)
  }
  const staleTanks = tanks.filter(t => t.stale).map(t => t.tank)
  if (staleTanks.length) caveats.push(`Tank readings older than ${STALE_HOURS} h (or missing) at a window edge: ${staleTanks.join(', ')}. A sweep only posts when a tank is at rest and off by 500 lb or more, so an old reading may no longer be what is in the tank.`)
  caveats.push('Surge tanks, UHT holding and pipework are not in the tank inventory; their contents at the window edges are counted as lost (or found).')
  if (unvalued.length) caveats.push(`${unvalued.length} finished-goods item(s) have no carton volume and are not in cased pounds: ${unvalued.map(u => `${u.name} (${Math.round(u.cases)} cases)`).join(', ')}.`)
  caveats.push('Cased pounds use one density for every product (8.6 lb/gal); cream and half & half are a little lighter, so their pounds are slightly overstated.')
  if (toEdge > new Date()) caveats.push('The window runs to today: trucks, completions and sweeps still to post will change these figures.')

  return {
    available: true, fromDay, toDay, asOf: new Date().toISOString(),
    definition: 'Milk received on trucks, plus what the silos, cream silos and blend tanks drew down, minus the physical pounds packed into cases and the bulk product shipped. What is left never reached a case.',
    received: {
      lbs: round2(receivedLbs), trucks: counted.length, receiptsComplete,
      trucksWithoutReceipt: withoutReceipt, trucksPendingResults: pendingResults,
      linkedItemReceiptLbs: linkedReceiptLbs != null ? round2(linkedReceiptLbs) : null,
      excluded: Object.values(excludedByStatus).map(e => ({ ...e, lbs: round2(e.lbs) })),
      source: 'customrecord_milk_truck net weight by arrival date (status Received or Pending External Results)',
    },
    inventory: {
      startLbs: round2(invStart), endLbs: round2(invEnd), drawdownLbs: round2(drawdown),
      byGroup: Object.values(groups).map(g => ({ ...g, startLbs: round2(g.startLbs), endLbs: round2(g.endLbs), drawdownLbs: round2(g.startLbs - g.endLbs) })),
      tanks, staleTanks, staleAfterHours: STALE_HOURS,
      source: 'Latest "Sweep reconcile" InvAdjst memo per tank before each window edge',
    },
    cased: {
      lbs: round2(casedLbs), cases: round2(casedItems.reduce((t, r) => t + r.cases, 0)), pctOfReceived: pctOf(casedLbs, receivedLbs),
      unvaluedCases: round2(unvalued.reduce((t, r) => t + r.cases, 0)), items: casedItems,
      source: 'WOCompl cases × physical lb per case (carton mL × cartons per case × 8.6 lb/gal)',
    },
    bulkShipped: { lbs: round2(bulkShippedLbs), pctOfReceived: pctOf(bulkShippedLbs, receivedLbs), items: shipItems, source: 'ItemShip on pound-unit raw and bulk items' },
    lostBeforeCasing: { lbs: round2(lostBeforeCasing), pctOfReceived: pctOf(lostBeforeCasing, receivedLbs), formula: 'received + drawdown − cased − bulk shipped' },
    '%ofReceived': {
      cased: pctOf(casedLbs, receivedLbs), bulkShipped: pctOf(bulkShippedLbs, receivedLbs),
      drawdown: pctOf(drawdown, receivedLbs), lostBeforeCasing: pctOf(lostBeforeCasing, receivedLbs),
    },
    receiptsComplete,
    caveats,
  }
}

function clearCache() { _cache.clear() }

module.exports = { getPlantBalance, parseSweepMemo, tanksAt, plantLocalToUtc, clearCache }
