'use strict'

/**
 * Correlate inventory adjustments back to the WO / assembly-unbuild / batch
 * that triggered them.
 *
 * Today MesInventoryAdjustment carries no structured FK to its trigger — but the
 * non-sweep sources DO embed an exact key in their memo (see the call sites in
 * blendTankMesService / surgeTankMesService / milkMesService):
 *
 *   - blend shortfall    "Auto-adjust: blend WO <nsWorkOrderId> issue shortfall …"
 *   - surge shortfall     "Auto-adjust: surge WO <nsWorkOrderId> issue shortfall …"
 *   - surge lot top-up    "Auto-adjust: surge WO <nsWorkOrderId> top up lot <lot> …"
 *   - separation unbuild  "Auto-adjust: separation unbuild batch <batchId> shortfall …"
 *   - unbuild cap stage   "Auto-adjust: raise/clear unbuild cap … for batch <batchId> …"
 *
 * The "WO <n>" number is the NS INTERNAL work-order id (nsWorkOrderId on the
 * batch tables), and "batch <XFR-…>" is the MES separation batchId — both are
 * exact joins, not fuzzy text. 'sweep' rows carry no trigger transaction, so they
 * are matched to whatever batch was running on the same tank+item at that time.
 *
 * This is the retroactive ("report now") half of the linkage work; the durable
 * FK columns are added in a follow-up so future rows don't depend on memo text.
 */
const { Op } = require('sequelize')
const db = require('../models')

// "blend WO 12345", "surge WO 12345 top up lot …" → the NS internal WO id.
const WO_RE = /\bWO\s+(\d+)/i
// "separation unbuild batch XFR-1700000000000 shortfall", "cap for batch XFR-…".
const BATCH_RE = /\bbatch\s+([A-Za-z0-9][\w.-]*)/i

// How far outside a batch's [start,end] window a sweep adjustment can fall and
// still be attributed to it (sensor/rest lag, completion trailing the last tick).
const FUZZY_TOLERANCE_MS = 6 * 60 * 60 * 1000 // 6h

const n = v => (v == null ? null : Number(v))

/**
 * Extract the triggering identifier from an adjustment memo.
 * Returns { type:'wo', nsWorkOrderId, hint } | { type:'sepBatch', batchId } |
 * { type:null }.
 */
function parseMemoTrigger(memo) {
  const s = String(memo || '')
  const wo = s.match(WO_RE)
  if (wo) {
    const hint = /surge/i.test(s) ? 'surge' : /blend/i.test(s) ? 'blend' : null
    return { type: 'wo', nsWorkOrderId: wo[1], hint, via: 'memo' }
  }
  const b = s.match(BATCH_RE)
  if (b) return { type: 'sepBatch', batchId: b[1], via: 'memo' }
  return { type: null, via: 'memo' }
}

/**
 * Resolve a row's trigger, preferring the structured linkage columns written at
 * the call site (Phase 2) and falling back to memo parsing for legacy rows that
 * predate them. 'sweep' rows have no trigger transaction → fuzzy path.
 */
function resolveTrigger(r) {
  if (r.triggerKind === 'wo' && r.nsWorkOrderId) {
    return { type: 'wo', nsWorkOrderId: String(r.nsWorkOrderId), hint: r.batchKind || null, via: 'column' }
  }
  if (r.triggerKind === 'sepBatch' && r.mesBatchId) {
    return { type: 'sepBatch', batchId: String(r.mesBatchId), via: 'column' }
  }
  if (r.triggerKind === 'sweep') return { type: null, via: 'column' }
  return parseMemoTrigger(r.memo)
}

// Normalize a tank/silo name for comparison (the sweep tankName vs batch
// tankId/sourceSilo can differ only in case/whitespace).
function normTank(s) {
  return String(s || '').trim().toUpperCase()
}

// Project a batch row to the compact shape returned on each correlation.
function summarizeBatch(kind, b) {
  const item = kind === 'separation'
    ? b.itemId
    : (kind === 'surge' ? (b.componentItemId || b.mesItem) : b.mesItem)
  const start = kind === 'separation' ? b.batchStart : b.detectedAt
  const end = kind === 'separation' ? b.batchEnd : b.completedAt
  return {
    kind,
    id: b.id,
    batchId: b.batchId || null,
    tankId: b.tankId || b.sourceSilo || null,
    productName: b.productName || null,
    item: item != null ? String(item) : null,
    nsWorkOrderId: b.nsWorkOrderId != null ? String(b.nsWorkOrderId) : null,
    nsWorkOrderNumber: b.nsWorkOrderNumber != null ? String(b.nsWorkOrderNumber) : null,
    nsTransactionId: b.nsTransactionId != null ? String(b.nsTransactionId) : null,
    status: b.status || null,
    start: start || null,
    end: end || null,
    issuedLbs: n(b.cumulativeIssuedLbs),
    outputLbs: n(b.cumulativeOutputLbs),
    wasteLbs: n(b.wasteLbs),
    wastePercent: n(b.wastePercent),
  }
}

/**
 * Main entry. Same filter/sort/paging params as
 * analyticsService.getInventoryAdjustments, plus the correlation enrichment.
 *
 * Returns { total, adjustments:[ { …row, correlation } ], summary }.
 *   correlation = {
 *     matchType: 'exact-wo' | 'exact-sep-batch' | 'fuzzy-tank-time' | 'none',
 *     confidence: 'exact' | 'high' | 'low' | null,
 *     trigger: { type, nsWorkOrderId?, batchId? } | null,
 *     batch: <summarizeBatch | null>,
 *     candidates?: number,   // fuzzy: how many batches were in contention
 *     note?: string,
 *   }
 */
async function getInventoryAdjustmentCorrelations(params = {}) {
  const analytics = require('./analyticsService')
  // Reuse the exact same filtered/sorted/paged read the review page uses, so the
  // correlation view and the table stay in lock-step.
  const { total, adjustments, summary } = await analytics.getInventoryAdjustments(params)
  const rows = adjustments.map(r => (typeof r.get === 'function' ? r.get({ plain: true }) : r))
  if (!rows.length) return { total, adjustments: [], summary, correlationStats: emptyStats() }

  // ── 1. Exact links: bulk-fetch the batches the triggers point at ──────────
  const triggers = rows.map(resolveTrigger)
  const woIds = [...new Set(triggers.filter(t => t.type === 'wo').map(t => t.nsWorkOrderId))]
  const sepBatchIds = [...new Set(triggers.filter(t => t.type === 'sepBatch').map(t => t.batchId))]

  const [blendByWo, surgeByWo, sepByBatch] = await Promise.all([
    woIds.length
      ? db.MesBlendTankBatch.findAll({ where: { nsWorkOrderId: { [Op.in]: woIds } } })
      : [],
    woIds.length
      ? db.MesSurgeTankBatch.findAll({ where: { nsWorkOrderId: { [Op.in]: woIds } } })
      : [],
    sepBatchIds.length
      ? db.MesSeparationBatch.findAll({ where: { batchId: { [Op.in]: sepBatchIds } } })
      : [],
  ])
  const blendWoMap = indexBy(blendByWo, b => String(b.nsWorkOrderId))
  const surgeWoMap = indexBy(surgeByWo, b => String(b.nsWorkOrderId))
  const sepBatchMap = indexBy(sepByBatch, b => String(b.batchId))

  // ── 2. Fuzzy pool: for the rows with no exact key (mostly 'sweep'), pull
  // every batch whose window plausibly overlaps the adjustment time range, then
  // match in memory. One bounded query per kind instead of N per-row queries. ──
  const unresolved = rows.filter((_, i) => triggers[i].type == null)
  let blendPool = [], surgePool = [], sepPool = []
  if (unresolved.length) {
    const times = unresolved.map(r => new Date(r.createdAt).getTime()).filter(t => !Number.isNaN(t))
    const lo = new Date(Math.min(...times) - FUZZY_TOLERANCE_MS)
    const hi = new Date(Math.max(...times) + FUZZY_TOLERANCE_MS)
    const blendSurgeWindow = {
      [Op.or]: [
        { detectedAt: { [Op.between]: [lo, hi] } },
        { completedAt: { [Op.between]: [lo, hi] } },
        { detectedAt: { [Op.lte]: lo }, completedAt: { [Op.gte]: hi } },
        { detectedAt: { [Op.lte]: hi }, completedAt: { [Op.is]: null } },
      ],
    }
    ;[blendPool, surgePool, sepPool] = await Promise.all([
      db.MesBlendTankBatch.findAll({ where: blendSurgeWindow }),
      db.MesSurgeTankBatch.findAll({ where: blendSurgeWindow }),
      db.MesSeparationBatch.findAll({
        where: {
          [Op.or]: [
            { batchStart: { [Op.between]: [lo, hi] } },
            { batchEnd: { [Op.between]: [lo, hi] } },
            { batchStart: { [Op.lte]: lo }, batchEnd: { [Op.gte]: hi } },
            { batchStart: { [Op.lte]: hi }, batchEnd: { [Op.is]: null } },
          ],
        },
      }),
    ])
  }
  const fuzzyPool = [
    ...blendPool.map(b => summarizeBatch('blend', b)),
    ...surgePool.map(b => summarizeBatch('surge', b)),
    ...sepPool.map(b => summarizeBatch('separation', b)),
  ]

  // ── 3. Attach a correlation to every row ───────────────────────────────────
  const out = rows.map((r, i) => {
    const t = triggers[i]
    let correlation

    if (t.type === 'wo') {
      // Prefer the table the memo hinted at; fall back to the other.
      const primary = t.hint === 'surge' ? surgeWoMap : blendWoMap
      const secondary = t.hint === 'surge' ? blendWoMap : surgeWoMap
      const kindPrimary = t.hint === 'surge' ? 'surge' : 'blend'
      const kindSecondary = t.hint === 'surge' ? 'blend' : 'surge'
      const hit = primary.get(t.nsWorkOrderId)
        ? { kind: kindPrimary, b: primary.get(t.nsWorkOrderId) }
        : secondary.get(t.nsWorkOrderId)
          ? { kind: kindSecondary, b: secondary.get(t.nsWorkOrderId) }
          : null
      correlation = hit
        ? { matchType: 'exact-wo', confidence: 'exact', trigger: t, batch: summarizeBatch(hit.kind, hit.b) }
        : { matchType: 'none', confidence: null, trigger: t, batch: null, note: `WO ${t.nsWorkOrderId} not found in blend/surge batches` }
    } else if (t.type === 'sepBatch') {
      const b = sepBatchMap.get(t.batchId)
      correlation = b
        ? { matchType: 'exact-sep-batch', confidence: 'exact', trigger: t, batch: summarizeBatch('separation', b) }
        : { matchType: 'none', confidence: null, trigger: t, batch: null, note: `separation batch ${t.batchId} not found` }
    } else {
      correlation = fuzzyMatch(r, fuzzyPool)
    }

    return { ...r, correlation }
  })

  return { total, adjustments: out, summary, correlationStats: tallyStats(out) }
}

/**
 * Time/tank/item match for a row with no exact trigger key (sweep, or a
 * shortfall whose memo lost its id). Scores candidates by: same tank, time
 * containment (vs. just nearby), and same item; returns the best, with a
 * confidence reflecting how much it leaned on.
 */
function fuzzyMatch(row, pool) {
  const adjTime = new Date(row.createdAt).getTime()
  const tank = normTank(row.tankName)
  const item = row.itemId != null ? String(row.itemId) : null

  // A sweep that fires right as a batch ends still counts as "at the edge" —
  // end-of-batch reconciliation is the most common sweep, and it lands just
  // after completedAt, never strictly inside.
  const EDGE_MS = 60 * 60 * 1000 // 1h
  const scored = []
  for (const b of pool) {
    if (tank && b.tankId && normTank(b.tankId) !== tank) continue
    const start = b.start ? new Date(b.start).getTime() : null
    const end = b.end ? new Date(b.end).getTime() : (start != null ? Infinity : null)
    if (start == null) continue

    const contained = adjTime >= start - FUZZY_TOLERANCE_MS && adjTime <= end + FUZZY_TOLERANCE_MS
    if (!contained) continue
    const strictlyInside = adjTime >= start && adjTime <= end
    const itemMatch = item != null && b.item === item
    // Distance to the nearest edge of the batch window (0 if inside).
    const edgeDist = strictlyInside ? 0 : Math.min(Math.abs(adjTime - start), end === Infinity ? Infinity : Math.abs(adjTime - end))
    const nearEdge = edgeDist <= EDGE_MS

    let score = 0
    if (tank && b.tankId) score += 3          // tank matched (we required it above)
    if (strictlyInside) score += 3
    else if (nearEdge) score += 1
    if (itemMatch) score += 2
    // Closeness to the batch midpoint breaks ties toward the better-centered batch.
    const center = end === Infinity ? start : (start + end) / 2
    const dist = Math.abs(adjTime - center)
    scored.push({ b, score, dist, itemMatch, strictlyInside, nearEdge })
  }
  if (!scored.length) {
    return { matchType: 'none', confidence: null, trigger: null, batch: null, candidates: 0 }
  }
  scored.sort((a, b) => (b.score - a.score) || (a.dist - b.dist))
  const best = scored[0]
  // High = item-matched AND firmly tied in time (inside the window or right at
  // its edge). Anything looser is a low-confidence positional guess.
  const confidence = best.itemMatch && (best.strictlyInside || best.nearEdge) ? 'high' : 'low'
  return {
    matchType: 'fuzzy-tank-time',
    confidence,
    trigger: null,
    batch: best.b,
    candidates: scored.length,
    note: best.itemMatch ? undefined : `tank+time match but adjustment item ${item} != batch item ${best.b.item}`,
  }
}

function indexBy(rows, keyFn) {
  const m = new Map()
  for (const r of rows) {
    const k = keyFn(r)
    if (k != null && !m.has(k)) m.set(k, r) // first wins; WO ids are unique per batch table anyway
  }
  return m
}

function emptyStats() {
  return { total: 0, exactWo: 0, exactSepBatch: 0, fuzzy: 0, fuzzyHigh: 0, fuzzyLow: 0, none: 0 }
}

function tallyStats(out) {
  const s = emptyStats()
  s.total = out.length
  for (const r of out) {
    const c = r.correlation
    if (c.matchType === 'exact-wo') s.exactWo++
    else if (c.matchType === 'exact-sep-batch') s.exactSepBatch++
    else if (c.matchType === 'fuzzy-tank-time') {
      s.fuzzy++
      if (c.confidence === 'high') s.fuzzyHigh++
      else s.fuzzyLow++
    } else s.none++
  }
  return s
}

module.exports = {
  getInventoryAdjustmentCorrelations,
  parseMemoTrigger,
  resolveTrigger,
  summarizeBatch,
  fuzzyMatch,
}
