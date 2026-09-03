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
const core = require('../clients/coreClient')
const rawMilkPriceService = require('./rawMilkPriceService')
const fgRevenueRateService = require('./fgRevenueRateService')

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

// Parse a separation batch's destinations JSON into the silos/bins the cream &
// skim landed in. A cream-silo sweep is correlated to the separation that fed
// it via these (the batch's own tankId is its SOURCE silo, not the cream dest).
function parseSeparationDests(b) {
  const silos = new Set()
  const bins = new Set()
  try {
    const d = b.destinations ? JSON.parse(b.destinations) : null
    const resolved = Array.isArray(d?.resolved) ? d.resolved : []
    for (const r of resolved) {
      if (r?.silo) silos.add(String(r.silo))
      if (r?.binId != null) bins.add(Number(r.binId))
    }
  } catch { /* malformed / legacy row → no dests */ }
  return { destSilos: [...silos], destBins: [...bins] }
}

// Project a batch row to the compact shape returned on each correlation.
function summarizeBatch(kind, b) {
  const item = kind === 'separation'
    ? b.itemId
    : (kind === 'surge' ? (b.componentItemId || b.mesItem) : b.mesItem)
  const start = kind === 'separation' ? b.batchStart : b.detectedAt
  const end = kind === 'separation' ? b.batchEnd : b.completedAt
  // Issued / completed normalized across kinds so waste math is uniform.
  //   blend/surge: cumulative tick totals.
  //   separation:  input went in; cream+skim came out (the unbuild's products).
  const issuedLbs = kind === 'separation' ? n(b.inputVolume) : n(b.cumulativeIssuedLbs)
  const completedLbs = kind === 'separation'
    ? (n(b.creamVolume) || 0) + (n(b.skimVolume) || 0)
    : n(b.cumulativeCompletedLbs)
  const dests = kind === 'separation' ? parseSeparationDests(b) : { destSilos: [], destBins: [] }
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
    issuedLbs,
    completedLbs,
    outputLbs: n(b.cumulativeOutputLbs),
    wasteLbs: n(b.wasteLbs),
    wastePercent: n(b.wastePercent),
    destSilos: dests.destSilos,
    destBins: dests.destBins,
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
  const out = await correlateAdjustmentRows(adjustments)
  return { total, adjustments: out, summary, correlationStats: tallyStats(out) }
}

/**
 * Core: attach a `.correlation` to each adjustment row (Sequelize instances or
 * plain objects). Shared by the adjustment-centric and batch-centric endpoints.
 */
async function correlateAdjustmentRows(adjustments) {
  const rows = adjustments.map(r => (typeof r.get === 'function' ? r.get({ plain: true }) : r))
  if (!rows.length) return []

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

  return out
}

// Compact projection of an adjustment for the batch-centric view (drops the
// nested correlation.batch — redundant once it's grouped under that batch).
function projectAdjustment(a) {
  const c = a.correlation || {}
  return {
    id: a.id,
    source: a.source,
    status: a.status,
    qtyDelta: n(a.qtyDelta),
    itemId: a.itemId != null ? String(a.itemId) : null,
    binId: a.binId,
    tankName: a.tankName,
    lotName: a.lotName,
    memo: a.memo,
    nsAdjustmentId: a.nsAdjustmentId || null,
    createdAt: a.createdAt,
    matchType: c.matchType || null,
    confidence: c.confidence || null,
    matchedOn: c.matchedOn || (c.matchType && c.matchType.startsWith('exact') ? 'exact' : null),
    via: c.trigger?.via || null,
  }
}

// Roll a batch's adjustments up into headline numbers for the master row.
// netLbs is every submitted adjustment, but exactNetLbs (adjustments tied to
// this batch by WO / separation batchId) is the only one safe to fold into the
// waste figure — fuzzyNetLbs comes from silo sweeps that reconcile the WHOLE
// silo across many batches, so attributing them to one batch overstates waste.
function rollupAdjustments(adjs) {
  const r = {
    count: adjs.length, netLbs: 0, exactNetLbs: 0, fuzzyNetLbs: 0,
    shortfallLbs: 0, sweepNetLbs: 0, errorCount: 0, exactCount: 0, fuzzyCount: 0, bySource: {},
  }
  for (const a of adjs) {
    const q = n(a.qtyDelta) || 0
    const isExact = a.matchType && a.matchType.startsWith('exact')
    if (isExact) r.exactCount++; else r.fuzzyCount++
    if (a.status === 'submitted') {
      r.netLbs += q
      if (isExact) r.exactNetLbs += q
      else r.fuzzyNetLbs += q
    }
    if (a.source === 'shortfall' || a.source === 'unbuild_cap') r.shortfallLbs += Math.abs(q)
    if (a.source === 'sweep' && a.status === 'submitted') r.sweepNetLbs += q
    if (a.status === 'error' || a.status === 'skipped') r.errorCount++
    r.bySource[a.source] = (r.bySource[a.source] || 0) + 1
  }
  return r
}

const batchKey = (kind, id) => `${kind}#${id}`

/**
 * Batch-centric "holistic" view: every batch in the window with the inventory
 * adjustments correlated to it (and per-batch rollups). Batches with no
 * adjustments still appear (rollup.count = 0); adjustments whose correlation
 * resolved to no batch are returned separately under `unattributed`.
 *
 * @param {object} params
 * @param {string} [params.from] [params.to]   ISO window (default: last 7d).
 * @param {string} [params.kind]               'blend'|'surge'|'separation' (comma-ok); default all.
 * @param {boolean} [params.onlyWithAdjustments] only return batches that have ≥1 adjustment.
 * @param {number} [params.limit]               max batches (default 300, cap 1000).
 */
async function getBatchesWithAdjustments(params = {}) {
  const to = params.to ? new Date(params.to) : new Date()
  const from = params.from ? new Date(params.from) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000)
  const kinds = params.kind
    ? String(params.kind).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    : ['blend', 'surge', 'separation']
  const want = k => kinds.includes(k)
  const limit = Math.min(Number(params.limit) || 300, 1000)
  const onlyWith = params.onlyWithAdjustments === true || params.onlyWithAdjustments === 'true'

  // ── Batches in the window (each kind keyed by its own start field) ─────────
  const [blend, surge, sep] = await Promise.all([
    want('blend')
      ? db.MesBlendTankBatch.findAll({ where: { detectedAt: { [Op.between]: [from, to] } }, order: [['detectedAt', 'DESC']], limit })
      : [],
    want('surge')
      ? db.MesSurgeTankBatch.findAll({ where: { detectedAt: { [Op.between]: [from, to] } }, order: [['detectedAt', 'DESC']], limit })
      : [],
    want('separation')
      ? db.MesSeparationBatch.findAll({ where: { batchStart: { [Op.between]: [from, to] } }, order: [['batchStart', 'DESC']], limit })
      : [],
  ])
  const batches = [
    ...blend.map(b => summarizeBatch('blend', b)),
    ...surge.map(b => summarizeBatch('surge', b)),
    ...sep.map(b => summarizeBatch('separation', b)),
  ]
  const byKey = new Map(batches.map(b => [batchKey(b.kind, b.id), { ...b, adjustments: [] }]))

  // ── Adjustments in a widened window (catch end-of-batch sweeps just past
  // completedAt), correlated, then grouped under their batch. ────────────────
  const adjFrom = new Date(from.getTime() - FUZZY_TOLERANCE_MS)
  const adjTo = new Date(to.getTime() + FUZZY_TOLERANCE_MS)
  const rawAdjs = await db.MesInventoryAdjustment.findAll({
    where: { createdAt: { [Op.between]: [adjFrom, adjTo] } },
    order: [['createdAt', 'DESC']],
    limit: 5000,
  })
  const correlated = await correlateAdjustmentRows(rawAdjs)

  const unattributed = []
  for (const a of correlated) {
    const b = a.correlation?.batch
    if (!b) { unattributed.push(projectAdjustment(a)); continue }
    const entry = byKey.get(batchKey(b.kind, b.id))
    if (entry) entry.adjustments.push(projectAdjustment(a))
    // else: the adjustment's batch is outside the requested window/kind — skip.
  }

  // Issue / completion / unbuild counts (+ failures) per batch from our NS
  // transaction log. Lb totals come from the batch's own cumulative fields
  // (authoritative); the log gives transaction counts and failure flags.
  const txnByKey = await aggregateTransactions(batches, from, to)

  let result = [...byKey.values()].map(b => {
    const adjustmentRollup = rollupAdjustments(b.adjustments)
    const transactions = txnByKey.get(batchKey(b.kind, b.id)) || blankTxns()
    // (issues − completions), then the same including this batch's EXACT-linked
    // adjustments (shortfall/unbuild_cap) — NOT fuzzy silo sweeps, which span
    // many batches and would wildly overstate one batch's waste.
    const issued = b.issuedLbs || 0
    const completed = b.completedLbs || 0
    const issuedMinusCompletedLbs = Math.round((issued - completed) * 100) / 100
    const wasteWithAdjLbs = Math.round((issued + adjustmentRollup.exactNetLbs - completed) * 100) / 100
    return { ...b, adjustmentRollup, transactions, issuedMinusCompletedLbs, wasteWithAdjLbs }
  })
  if (onlyWith) result = result.filter(b => b.adjustmentRollup.count > 0)
  // Newest batch first across all kinds.
  result.sort((a, b) => new Date(b.start || 0) - new Date(a.start || 0))

  const stats = {
    batchCount: result.length,
    batchesWithAdjustments: result.filter(b => b.adjustmentRollup.count > 0).length,
    adjustmentsLinked: correlated.length - unattributed.length,
    adjustmentsUnattributed: unattributed.length,
  }
  return { from: from.toISOString(), to: to.toISOString(), batches: result, unattributed, stats }
}

function blankTxns() {
  return { issues: { count: 0, errors: 0 }, completions: { count: 0, errors: 0 }, unbuilds: { count: 0, errors: 0 } }
}

// Aggregate MesProcessingLog NS transactions per batch. Blend/surge events are
// keyed by sourceId = nsWorkOrderId (tick/backfill/tail issues + completions);
// separation unbuilds by sourceId = batchId. Returns Map<batchKey, txns>.
async function aggregateTransactions(batches, from, to) {
  const woToKey = new Map()
  const batchIdToKey = new Map()
  for (const b of batches) {
    const key = batchKey(b.kind, b.id)
    if (b.nsWorkOrderId) woToKey.set(String(b.nsWorkOrderId), key)
    if (b.kind === 'separation' && b.batchId) batchIdToKey.set(String(b.batchId), key)
  }
  const sourceIds = [...new Set([...woToKey.keys(), ...batchIdToKey.keys()])]
  const out = new Map()
  if (!sourceIds.length) return out

  const lo = new Date(from.getTime() - FUZZY_TOLERANCE_MS)
  const hi = new Date(to.getTime() + FUZZY_TOLERANCE_MS)
  const logs = await db.MesProcessingLog.findAll({
    where: { sourceId: { [Op.in]: sourceIds }, createdAt: { [Op.between]: [lo, hi] } },
    attributes: ['eventType', 'sourceId', 'success'],
    raw: true,
    limit: 50000,
  })
  for (const e of logs) {
    const key = woToKey.get(String(e.sourceId)) || batchIdToKey.get(String(e.sourceId))
    if (!key) continue
    const t = out.get(key) || blankTxns()
    const et = e.eventType || ''
    const bucket = /unbuild/.test(et) ? t.unbuilds
      : /complet/.test(et) ? t.completions
      : /issue/.test(et) ? t.issues
      : null
    if (bucket) { bucket.count++; if (!e.success) bucket.errors++ }
    out.set(key, t)
  }
  return out
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
  const binId = row.binId != null ? Number(row.binId) : null
  const item = row.itemId != null ? String(row.itemId) : null

  // A sweep that fires right as a batch ends still counts as "at the edge" —
  // end-of-batch reconciliation is the most common sweep, and it lands just
  // after completedAt, never strictly inside.
  const EDGE_MS = 60 * 60 * 1000 // 1h
  const scored = []
  for (const b of pool) {
    // A sweep can tie to a batch by its SOURCE tank, or — for separations — by
    // a DESTINATION silo/bin the cream or skim landed in (a cream-silo sweep
    // reconciles product a separation fed it; the batch's own tankId is the
    // source silo, so source-only matching would miss it).
    const onSource = !!(tank && b.tankId && normTank(b.tankId) === tank)
    const onDest = !!(
      (tank && b.destSilos && b.destSilos.some(s => normTank(s) === tank)) ||
      (binId != null && b.destBins && b.destBins.includes(binId))
    )
    if (tank && !onSource && !onDest) continue

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
    if (onSource) score += 3            // source tank match is the strongest signal
    else if (onDest) score += 2         // destination (cream/skim) match is a touch weaker
    if (strictlyInside) score += 3
    else if (nearEdge) score += 1
    if (itemMatch) score += 2
    // Closeness to the batch midpoint breaks ties toward the better-centered batch.
    const center = end === Infinity ? start : (start + end) / 2
    const dist = Math.abs(adjTime - center)
    scored.push({ b, score, dist, itemMatch, strictlyInside, nearEdge, onSource, onDest })
  }
  if (!scored.length) {
    return { matchType: 'none', confidence: null, trigger: null, batch: null, candidates: 0 }
  }
  scored.sort((a, b) => (b.score - a.score) || (a.dist - b.dist))
  const best = scored[0]
  // High = item-matched AND firmly tied in time (inside the window or right at
  // its edge). A destination-only match (cream silo aggregates many separations)
  // is inherently looser, so it never rates high.
  const confidence = best.itemMatch && (best.strictlyInside || best.nearEdge) && !best.onDest ? 'high' : 'low'
  const note = best.onDest && !best.onSource
    ? `matched to separation by destination silo/bin (cream/skim landing), not source`
    : (best.itemMatch ? undefined : `tank+time match but adjustment item ${item} != batch item ${best.b.item}`)
  return {
    matchType: 'fuzzy-tank-time',
    confidence,
    trigger: null,
    batch: best.b,
    candidates: scored.length,
    matchedOn: best.onSource ? 'source' : (best.onDest ? 'dest' : 'time'),
    note,
  }
}

// Distinct bins & lots touched by a batch's adjustments, with the net submitted
// lbs per bin/lot — the "where did the product physically sit" view that the
// dedicated batch page surfaces alongside the adjustment list.
function aggregateBinsLots(adjustments) {
  const binMap = new Map()
  const lotMap = new Map()
  for (const a of adjustments) {
    if (a.binId != null) {
      const b = binMap.get(a.binId) || { binId: a.binId, items: new Set(), lots: new Set(), netLbs: 0, count: 0 }
      if (a.itemId) b.items.add(a.itemId)
      if (a.lotName) b.lots.add(a.lotName)
      if (a.status === 'submitted') b.netLbs += (n(a.qtyDelta) || 0)
      b.count++
      binMap.set(a.binId, b)
    }
    if (a.lotName) {
      const key = `${a.lotName}#${a.itemId || ''}`
      const l = lotMap.get(key) || { lotName: a.lotName, itemId: a.itemId || null, binId: a.binId, netLbs: 0, count: 0 }
      if (a.status === 'submitted') l.netLbs += (n(a.qtyDelta) || 0)
      l.count++
      lotMap.set(key, l)
    }
  }
  const bins = [...binMap.values()].map(b => ({
    binId: b.binId, items: [...b.items], lots: [...b.lots], netLbs: round2(b.netLbs), count: b.count,
  }))
  const lots = [...lotMap.values()].map(l => ({ ...l, netLbs: round2(l.netLbs) }))
  return { bins, lots }
}

/**
 * Everything about ONE batch, for the dedicated batch-detail page: the full
 * batch record, its correlated inventory adjustments + rollup, NS transaction
 * counts and the raw processing-log entries behind them, the bins/lots it
 * touched, blend-tank ingredient inflows, and separation destinations. The live
 * NetSuite source-of-truth pull stays a separate on-demand call
 * (getBatchNetSuiteTransactions) so this stays a fast local read.
 */
async function getBatchDetail({ kind, id }) {
  const Model = kind === 'blend' ? db.MesBlendTankBatch
    : kind === 'surge' ? db.MesSurgeTankBatch
      : kind === 'separation' ? db.MesSeparationBatch : null
  if (!Model) throw new Error(`unknown batch kind '${kind}'`)
  const row = await Model.findByPk(Number(id))
  if (!row) throw new Error(`${kind} batch ${id} not found`)

  const summary = summarizeBatch(kind, row)
  const woId = summary.nsWorkOrderId
  const sepBatchId = kind === 'separation' ? summary.batchId : null

  // ── Adjustments correlated to THIS batch ──────────────────────────────────
  // Pull exact-linked rows (by WO / separation batchId) plus everything in the
  // batch's widened time window (catches fuzzy silo sweeps), correlate them the
  // same way every other view does, then keep only the ones that resolve here.
  const start = summary.start ? new Date(summary.start) : null
  const end = summary.end ? new Date(summary.end) : new Date()
  const lo = new Date((start ? start.getTime() : end.getTime()) - FUZZY_TOLERANCE_MS)
  const hi = new Date(end.getTime() + FUZZY_TOLERANCE_MS)
  const exactOr = []
  if (woId) exactOr.push({ nsWorkOrderId: woId })
  if (sepBatchId) exactOr.push({ mesBatchId: sepBatchId })
  const where = exactOr.length
    ? { [Op.or]: [...exactOr, { createdAt: { [Op.between]: [lo, hi] } }] }
    : { createdAt: { [Op.between]: [lo, hi] } }
  const rawAdjs = await db.MesInventoryAdjustment.findAll({
    where, order: [['createdAt', 'DESC']], limit: 2000,
  })
  const correlated = await correlateAdjustmentRows(rawAdjs)
  const adjustments = correlated
    .filter(a => a.correlation?.batch && a.correlation.batch.kind === kind && a.correlation.batch.id === row.id)
    .map(projectAdjustment)
  const adjustmentRollup = rollupAdjustments(adjustments)
  const { bins, lots } = aggregateBinsLots(adjustments)

  // ── NS transaction counts + the raw processing-log entries behind them ─────
  const txnByKey = await aggregateTransactions([summary], start || lo, end)
  const transactions = txnByKey.get(batchKey(kind, row.id)) || blankTxns()
  const logSourceIds = [woId, sepBatchId].filter(Boolean)
  const log = logSourceIds.length
    ? (await db.MesProcessingLog.findAll({
      where: { sourceId: { [Op.in]: logSourceIds } },
      attributes: ['id', 'eventType', 'nsTransactionType', 'nsTransactionId', 'success', 'errorMessage', 'createdAt'],
      order: [['createdAt', 'DESC']], raw: true, limit: 1000,
    })).map(l => ({
      id: l.id, eventType: l.eventType, nsTransactionType: l.nsTransactionType,
      nsTransactionId: l.nsTransactionId, success: !!l.success,
      errorMessage: l.errorMessage || null, createdAt: l.createdAt,
    }))
    : []

  // ── Blend-tank ingredient inflows (line-by-line) ──────────────────────────
  const inflows = kind === 'blend'
    ? (await db.MesBlendTankInflow.findAll({
      where: { blendTankBatchId: row.id }, order: [['createdAt', 'ASC']], raw: true,
    })).map(f => ({
      id: f.id, line: f.line, ingredientType: f.ingredientType, totalLbs: n(f.totalLbs),
      nsItemId: f.nsItemId || null, nsIssueId: f.nsIssueId || null, status: f.status,
      destination: f.destination || null, siloName: f.siloName || null,
      errorMessage: f.errorMessage || null, createdAt: f.createdAt,
    }))
    : []

  const issued = summary.issuedLbs || 0
  const completed = summary.completedLbs || 0
  const issuedMinusCompletedLbs = round2(issued - completed)
  const wasteWithAdjLbs = round2(issued + adjustmentRollup.exactNetLbs - completed)

  // Per-family raw milk pricing (SD-717) — priced from wasteWithAdjLbs, the
  // headline waste figure this view leads with. Absent when nothing prices
  // the batch (frontend falls back to its flat-price math).
  let costFamily = null
  let wasteUsd = null
  let lostRevenueUsd = null
  if (kind === 'surge' || kind === 'blend') {
    try {
      const ctx = await rawMilkPriceService.getPricingContext()
      const priced = rawMilkPriceService.priceForBatch(row.componentItemId, row.mesItem, ctx)
      costFamily = priced.family
      if (priced.pricePerLb != null) wasteUsd = round2(wasteWithAdjLbs * priced.pricePerLb)
    } catch (err) {
      console.warn(`[AdjustmentCorrelation] batch pricing failed: ${err.message}`)
    }
  }
  // Forgone FG revenue — surge directly; blend through the raw-FG → FG alias
  // map (blend mesItem is a raw-FG id). Separation stays unpriced here: too
  // far upstream to honestly attribute a finished good.
  if (kind === 'surge' || kind === 'blend') {
    try {
      const fgRates = fgRevenueRateService.expandRatesWithRawFg(
        await fgRevenueRateService.getCurrentRates()
      )
      const rate = fgRevenueRateService.rateForItem(row.mesItem, fgRates)
      if (rate != null) lostRevenueUsd = round2(wasteWithAdjLbs * rate)
    } catch (err) {
      console.warn(`[AdjustmentCorrelation] FG revenue pricing failed: ${err.message}`)
    }
  }

  return {
    kind, id: row.id,
    batch: row.get({ plain: true }),
    costFamily,
    wasteUsd,
    lostRevenueUsd,
    summary,
    issuedMinusCompletedLbs,
    wasteWithAdjLbs,
    adjustments, adjustmentRollup,
    transactions, log,
    bins, lots,
    inflows,
    destSilos: summary.destSilos, destBins: summary.destBins,
  }
}

// ── NetSuite pull ───────────────────────────────────────────────────────────
// Rather than trust only our local MesProcessingLog/batch totals, pull the
// ACTUAL transactions for a batch's work order from NetSuite by the transaction
// ids we recorded, and report NS-posted quantities. SuiteQL notes (probed live):
//   - `transaction.createdfrom` is NOT a queryable column → can't link WO→kids
//     that way; we use the NS ids stored in MesProcessingLog.nsTransactionId /
//     MesInventoryAdjustment.nsAdjustmentId instead.
//   - type codes: WOIssue, WOCompl, Unbuild, InvAdjst.
//   - lines are double-entry (offsetting ±). Headline qty per txn = MAX(ABS(qty));
//     adjustments don't offset so their signed net = SUM(qty); an unbuild's input
//     = |Σ negatives|, output (cream+skim) = Σ positives.
const NS_QUERY = '/query/v1/suiteql'
const round2 = v => Math.round((Number(v) || 0) * 100) / 100

async function nsQuery(sql, retries = 1) {
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await core.netsuitePost(NS_QUERY, { q: sql })
      return r?.body?.items || r?.items || []
    } catch (err) {
      // Gateway 401/INVALID_LOGIN is transient on warm-up (see ns_suiteql notes).
      if (attempt < retries && /401|INVALID_LOGIN|Unauthorized/i.test(err.message || '')) continue
      throw err
    }
  }
}

function chunkIds(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function emptyNsTotals() {
  return {
    issuedLbs: 0, completedLbs: 0, adjustedNetLbs: 0, wasteWithAdjLbs: 0,
    issueCount: 0, completionCount: 0, unbuildCount: 0, adjustmentCount: 0,
  }
}

/**
 * Pull a single batch's NetSuite transactions (issues / completions / unbuild /
 * adjustments) by the NS ids we recorded, and report NS-posted quantities — the
 * source-of-truth counterpart to the locally-derived figures. On-demand (one
 * batch per call) because it hits live SuiteQL.
 */
async function getBatchNetSuiteTransactions({ kind, id }) {
  const Model = kind === 'blend' ? db.MesBlendTankBatch
    : kind === 'surge' ? db.MesSurgeTankBatch
      : kind === 'separation' ? db.MesSeparationBatch : null
  if (!Model) throw new Error(`unknown batch kind '${kind}'`)
  const batch = await Model.findByPk(Number(id))
  if (!batch) throw new Error(`${kind} batch ${id} not found`)

  const woId = batch.nsWorkOrderId != null ? String(batch.nsWorkOrderId) : null
  const sepBatchId = kind === 'separation' ? batch.batchId : null

  // Collect NS transaction ids from our own records, tagged by category.
  const idToCat = new Map()
  const addId = (nsId, cat) => { if (nsId != null && String(nsId).trim()) idToCat.set(String(nsId), cat) }

  const srcIds = [woId, sepBatchId].filter(Boolean)
  if (srcIds.length) {
    const logs = await db.MesProcessingLog.findAll({
      where: { sourceId: { [Op.in]: srcIds }, nsTransactionId: { [Op.ne]: null } },
      attributes: ['eventType', 'nsTransactionId'], raw: true,
    })
    for (const l of logs) {
      const et = l.eventType || ''
      const cat = /unbuild/.test(et) ? 'unbuild' : /complet/.test(et) ? 'completion' : /issue/.test(et) ? 'issue' : null
      if (cat) addId(l.nsTransactionId, cat)
    }
  }
  if (kind === 'separation' && batch.nsTransactionId) addId(batch.nsTransactionId, 'unbuild')

  const adjOr = []
  if (woId) adjOr.push({ nsWorkOrderId: woId })
  if (sepBatchId) adjOr.push({ mesBatchId: sepBatchId })
  if (adjOr.length) {
    const adjs = await db.MesInventoryAdjustment.findAll({
      where: { nsAdjustmentId: { [Op.ne]: null }, [Op.or]: adjOr },
      attributes: ['nsAdjustmentId'], raw: true,
    })
    for (const a of adjs) addId(a.nsAdjustmentId, 'adjustment')
  }

  const ids = [...idToCat.keys()]
  if (!ids.length) {
    return { kind, id: Number(id), woId, sepBatchId, ids: 0, missing: 0, transactions: [], totals: emptyNsTotals(), note: 'No NetSuite transaction ids recorded for this batch.' }
  }

  // Query NS by id in chunks (createdfrom isn't queryable, so we use the id list).
  const meta = new Map()
  const qty = new Map()
  // Per-bin / per-lot breakdown: where product was issued FROM, completed TO,
  // and adjusted, with quantities. Built from inventory-detail assignments.
  const binAgg = new Map()
  const lotAgg = new Map()
  for (const grp of chunkIds(ids, 200)) {
    const inList = grp.join(',')
    const metas = await nsQuery(`SELECT id, type, tranid, trandate, BUILTIN.DF(status) AS status FROM transaction WHERE id IN (${inList})`)
    for (const m of metas) meta.set(String(m.id), m)
    const qtys = await nsQuery(
      `SELECT tl.transaction AS txn, MAX(ABS(tl.quantity)) AS maxabs, SUM(tl.quantity) AS net, ` +
      `SUM(CASE WHEN tl.quantity > 0 THEN tl.quantity ELSE 0 END) AS possum, ` +
      `SUM(CASE WHEN tl.quantity < 0 THEN tl.quantity ELSE 0 END) AS negsum ` +
      `FROM transactionline tl WHERE tl.transaction IN (${inList}) GROUP BY tl.transaction`
    )
    for (const x of qtys) qty.set(String(x.txn), x)

    // One row per inventory-detail assignment (bin + lot + qty). The bin/qty
    // joins are proven (see scripts/verifyUnbuildBinsItems.js); the lot table
    // join is the only unproven part, so if the full query errors we retry
    // bins-only — a lot-schema hiccup must not cost us the bin breakdown.
    try {
      let lines
      try {
        lines = await nsQuery(
          `SELECT tl.transaction AS txn, tl.item AS item, tl.quantity AS qty, ia.quantity AS assignqty, ` +
          `ia.bin AS bin, b.binnumber AS binnumber, invn.inventorynumber AS lot ` +
          `FROM transactionline tl ` +
          `LEFT JOIN inventoryassignment ia ON ia.transaction = tl.transaction AND ia.transactionline = tl.id ` +
          `LEFT JOIN bin b ON b.id = ia.bin ` +
          `LEFT JOIN inventorynumber invn ON invn.id = ia.inventorynumber ` +
          `WHERE tl.transaction IN (${inList}) AND tl.item IS NOT NULL`
        )
      } catch (lotErr) {
        console.warn('[adjustmentCorrelationService] NS lot join failed, retrying bins-only:', lotErr.message)
        lines = await nsQuery(
          `SELECT tl.transaction AS txn, tl.item AS item, tl.quantity AS qty, ia.quantity AS assignqty, ` +
          `ia.bin AS bin, b.binnumber AS binnumber, NULL AS lot ` +
          `FROM transactionline tl ` +
          `LEFT JOIN inventoryassignment ia ON ia.transaction = tl.transaction AND ia.transactionline = tl.id ` +
          `LEFT JOIN bin b ON b.id = ia.bin ` +
          `WHERE tl.transaction IN (${inList}) AND tl.item IS NOT NULL`
        )
      }
      for (const ln of lines) accumulateBinLot(binAgg, lotAgg, idToCat.get(String(ln.txn)), ln)
    } catch (err) {
      console.warn('[adjustmentCorrelationService] NS bin/lot breakdown query failed:', err.message)
    }
  }

  const totals = emptyNsTotals()
  const transactions = ids.map(tid => {
    const m = meta.get(tid) || {}
    const q = qty.get(tid) || {}
    const cat = idToCat.get(tid)
    const maxabs = Number(q.maxabs) || 0
    const net = Number(q.net) || 0
    const pos = Number(q.possum) || 0
    const neg = Number(q.negsum) || 0
    let lbs = maxabs
    if (cat === 'issue') { totals.issuedLbs += maxabs; totals.issueCount++ }
    else if (cat === 'completion') { totals.completedLbs += maxabs; totals.completionCount++ }
    else if (cat === 'unbuild') { totals.issuedLbs += Math.abs(neg); totals.completedLbs += pos; totals.unbuildCount++; lbs = Math.abs(neg) }
    else if (cat === 'adjustment') { totals.adjustedNetLbs += net; totals.adjustmentCount++; lbs = net }
    return {
      id: tid, category: cat,
      type: m.type || null, tranid: m.tranid || null, date: m.trandate || null, status: m.status || null,
      lbs: round2(lbs), inNetSuite: meta.has(tid),
    }
  })

  for (const k of ['issuedLbs', 'completedLbs', 'adjustedNetLbs']) totals[k] = round2(totals[k])
  totals.wasteWithAdjLbs = round2(totals.issuedLbs + totals.adjustedNetLbs - totals.completedLbs)
  const missing = transactions.filter(t => !t.inNetSuite).length

  const bins = [...binAgg.values()].map(finalizeBinLotRow).sort((a, b) => (b.issuedLbs + b.completedLbs) - (a.issuedLbs + a.completedLbs))
  const lots = [...lotAgg.values()].map(finalizeBinLotRow).sort((a, b) => (b.issuedLbs + b.completedLbs) - (a.issuedLbs + a.completedLbs))

  return { kind, id: Number(id), woId, sepBatchId, ids: ids.length, missing, transactions, totals, bins, lots }
}

// Fold one inventory-detail assignment into the per-bin and per-lot tallies,
// bucketing the quantity by transaction category: issues subtract from a bin
// (issued-from), completions add (completed-to), unbuilds split by line sign
// (assembly consumed = issued, components produced = completed), adjustments
// carry their signed net. `assignqty` (the per-bin/lot detail qty) is preferred
// over the line total so multi-bin lines attribute correctly.
function accumulateBinLot(binAgg, lotAgg, cat, ln) {
  if (!cat) return
  const amount = Number(ln.assignqty != null ? ln.assignqty : ln.qty) || 0
  if (!amount) return
  const binId = ln.bin != null ? Number(ln.bin) : null
  const binNumber = ln.binnumber || null
  const lot = ln.lot || null
  const item = ln.item != null ? String(ln.item) : null

  const addQty = obj => {
    if (cat === 'issue') obj.issuedLbs += Math.abs(amount)
    else if (cat === 'completion') obj.completedLbs += Math.abs(amount)
    else if (cat === 'unbuild') { if (amount < 0) obj.issuedLbs += Math.abs(amount); else obj.completedLbs += amount }
    else if (cat === 'adjustment') obj.adjustedLbs += amount
  }

  const binKey = binId == null ? 'none' : String(binId)
  const b = binAgg.get(binKey) || { key: binNumber || (binId != null ? `bin ${binId}` : '—'), binId, binNumber, items: new Set(), lots: new Set(), issuedLbs: 0, completedLbs: 0, adjustedLbs: 0 }
  if (item) b.items.add(item)
  if (lot) b.lots.add(lot)
  addQty(b)
  binAgg.set(binKey, b)

  if (lot) {
    const l = lotAgg.get(lot) || { key: lot, lotName: lot, items: new Set(), lots: new Set(), issuedLbs: 0, completedLbs: 0, adjustedLbs: 0 }
    if (item) l.items.add(item)
    if (binNumber || binId != null) l.lots.add(binNumber || `bin ${binId}`)
    addQty(l)
    lotAgg.set(lot, l)
  }
}

// Materialize a bin/lot tally: Sets → arrays, lbs rounded. `lots` on a bin row =
// the lots seen there; on a lot row the same field carries the bins seen.
function finalizeBinLotRow(r) {
  return {
    binId: r.binId ?? null, binNumber: r.binNumber ?? null, lotName: r.lotName ?? null,
    items: [...r.items], related: [...r.lots],
    issuedLbs: round2(r.issuedLbs), completedLbs: round2(r.completedLbs), adjustedLbs: round2(r.adjustedLbs),
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
  getBatchesWithAdjustments,
  getBatchDetail,
  getBatchNetSuiteTransactions,
  correlateAdjustmentRows,
  parseMemoTrigger,
  resolveTrigger,
  summarizeBatch,
  fuzzyMatch,
}
