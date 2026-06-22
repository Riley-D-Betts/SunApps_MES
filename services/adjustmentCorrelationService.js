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
  correlateAdjustmentRows,
  parseMemoTrigger,
  resolveTrigger,
  summarizeBatch,
  fuzzyMatch,
}
