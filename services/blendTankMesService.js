const core = require('../clients/coreClient')
const itemConfig = require('./mesItemConfig')
const productParser = require('./blendTankProductParser')
const lineMapper = require('./lineIngredientMapper')
const nsInventory = require('./nsInventoryLookup')
const inventoryAdjustment = require('./inventoryAdjustmentService')
const batchStartFinder = require('./batchStartFinder')
const costReval = require('./costRevaluationService')
const statusStore = require('./statusStore')
const config = require('../config')
const db = require('../models')
const clock = require('../sim/clock')

// Compact NS error detail for the dashboard event stream — pulls the
// "detail" string out of the wrapped HTTP-400 body so the user sees the
// real message instead of nested escaped JSON. Falls back to the first
// 200 chars of the raw message.
function nsErrShort(err) {
  const msg = String(err?.message || '')
  const m = msg.match(/"detail":"([^"]+)"/)
  return m ? m[1] : msg.slice(0, 200)
}

// Per-process throttle so we attempt a cost-basis revaluation at most once per
// assembly item — needsCostBasis() is also idempotent (it bails once an InvReval
// exists), this just avoids re-querying NS every failed tick.
const _costBasisAttempted = new Set()

// Fallback for the misleading NS error "Inventory Revaluation is no longer the
// first transaction in the item's history". For a STANDARD-cost item with no
// cost basis (cost=0, no InvReval) this means no revaluation ever happened, so
// the assembly can't be issued/built. We post a BOM-rollup inventoryCostRevaluation
// (see costRevaluationService); baselines didn't advance on the failed issue, so
// the next tick re-issues naturally once the basis exists. Alerts either way so a
// human knows. Throttled to one attempt per assembly item per process.
async function remediateCostBasisIfNeeded(batch, err) {
  if (!costReval.isNoCostBasisError(err)) return
  const assemblyItemId = batch?.mesItem
  if (!assemblyItemId) return
  if (_costBasisAttempted.has(assemblyItemId)) return
  _costBasisAttempted.add(assemblyItemId)

  try {
    const result = await costReval.ensureCostBasis({ assemblyItemId })
    if (result.revalued) {
      const msg = `${batch.tankId}: item ${assemblyItemId} had no cost basis — posted revaluation @ ${result.unitCost?.toFixed?.(5)}/unit (tranDate ${result.tranDate}). Issues will retry next tick.`
      console.log(`[BlendTankMesService] ${msg}`)
      statusStore.pushEvent('blendTank.costBasisFixed', msg, { tankId: batch.tankId, assemblyItemId, unitCost: result.unitCost })
      await core.sendStagingNotification('MES: auto-revalued item with no cost basis', msg).catch(() => {})
    } else {
      const msg = `${batch.tankId}: item ${assemblyItemId} issues are failing on a missing cost basis and auto-revaluation did NOT run (${result.reason}). Needs manual standard-cost setup in NetSuite.`
      console.warn(`[BlendTankMesService] ${msg}`)
      statusStore.pushEvent('blendTank.costBasisBlocked', msg, { tankId: batch.tankId, assemblyItemId, reason: result.reason })
      await core.sendStagingNotification('MES: item blocked — no cost basis, manual fix needed', msg).catch(() => {})
    }
  } catch (e) {
    console.error(`[BlendTankMesService] cost-basis remediation for item ${assemblyItemId} failed: ${e.message}`)
    _costBasisAttempted.delete(assemblyItemId) // allow a retry next tick on transient failure
  }
}

// NS rejects a workOrderCompletion with this (wrapped through Core API as a
// 400→500) when its receiptInventoryNumber lot is being created twice at once
// — i.e. two completion transforms raced. The deterministic MMDDYY+WO lot is a
// natural idempotency key, so this error means "another completion for this WO
// already landed", not a real failure. Used to keep the completion path quiet
// and self-correcting instead of looping the same lot and alarming.
function isAlreadyExistsError(err) {
  return /this record already exists/i.test(String(err?.message || ''))
}

// Read how much NS has actually built on a WO so local cumulativeCompletedLbs
// can be reconciled against the source of truth — guards against double-building
// when a completion's HTTP response was lost or two attempts raced.
async function fetchWoBuiltQuantity(nsWorkOrderId) {
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?fields=builtQuantity`)
  const wo = wrap?.body || wrap
  const built = parseFloat(wo?.builtQuantity)
  return Number.isFinite(built) ? built : null
}

// Per-WO in-process completion lock. The periodic tick, the late-naming
// backfill, and the end-of-batch flush all call tickCompletionForBatch on the
// same active batch and can overlap (all run in this one process). Without
// serialization two completions race to create the same lot and one dies with
// "This record already exists" (WO1597, 2026-06-01). Chaining per WO forces
// them sequential; the second one reloads and sees the first already
// completed, so it cleanly no-ops instead of double-firing.
const _completionLocks = new Map()
function withCompletionLock(woId, fn) {
  const key = String(woId)
  const prev = _completionLocks.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  _completionLocks.set(key, next.then(() => {}, () => {}))
  return next
}

// A genuine line totalizer reset wraps to 0 at batch end — a drop of thousands
// of lbs. Anything smaller is sensor jitter, not a reset: treating it as one
// (and issuing the full post-"reset" totalizer) re-counts the same fill every
// tick. Mirrors the surge-side TOTALIZER_RESET_DROP_GAL guard.
const TOTALIZER_RESET_DROP_LBS = 100

// A load-cell reading (lbs) is implausible when it reads ~empty but we just saw
// a substantial level — the replay-overrun signature (future timestamps return
// 0/null). Trusting it would zero arrival and collapse waste to zero, so defer.
function plausibleLevelLbs(curLbs, prevLbs) {
  if (!Number.isFinite(curLbs) || curLbs < 0) return false
  if (curLbs < 1 && prevLbs != null && prevLbs > config.MES_WASTE_RESIDUAL_FLOOR_LBS) return false
  return true
}

// Per-process BOM cache keyed by nsWorkOrderId. Fetched once per WO and reused
// across ticks. Cleared when the batch closes.
const _bomCache = new Map()

async function fetchWoBomLines(nsWorkOrderId) {
  if (_bomCache.has(nsWorkOrderId)) return _bomCache.get(nsWorkOrderId)
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const lines = (wo?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id) }))
  console.log(`[BlendTankMesService] BOM for WO ${nsWorkOrderId}: ${lines.map(l => `line${l.line}=item${l.itemId}`).join(', ') || '(empty)'}`)
  _bomCache.set(nsWorkOrderId, lines)
  return lines
}

function clearBomCache(nsWorkOrderId) {
  _bomCache.delete(nsWorkOrderId)
}

// If targetItemId isn't already on the WO BOM, PATCH the WO to append it at
// qty=0, then refetch to pick up the line number NS assigned. Mutates the
// passed-in bomLines array (and the cache) in place so subsequent issues in
// the same tick see the new line.
// Lifted from scripts/recoverBlendTank2AFill.js — same recipe that produced
// the dynamic raw-FG line operators have been seeing on existing WOs.
async function ensureItemOnWoBom(nsWorkOrderId, targetItemId, bomLines) {
  const targetIdStr = String(targetItemId)
  const existing = bomLines.find(c => String(c.itemId) === targetIdStr)
  if (existing) return existing

  console.log(`[BlendTankMesService] Item ${targetIdStr} not on WO ${nsWorkOrderId} BOM (lines: ${bomLines.map(b => b.itemId).join(', ') || '(empty)'}) — PATCHing to append`)
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const merged = (wo?.item?.items || []).map(c => ({
    item: { id: String(c.item?.id) },
    quantity: c.quantity,
    ...(c.units?.id ? { units: { id: String(c.units.id) } } : {}),
  }))
  merged.push({ item: { id: targetIdStr }, quantity: 0 })
  await core.netsuitePatch(`/record/v1/workOrder/${nsWorkOrderId}`, { item: { items: merged } })

  const refetched = (await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?expandSubResources=true`))?.body
  const newLines = (refetched?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id) }))
  const newRow = newLines.find(c => c.itemId === targetIdStr)
  if (!newRow) throw new Error(`PATCH appended item ${targetIdStr} to WO ${nsWorkOrderId} but it didn't appear on refetch`)
  console.log(`[BlendTankMesService] Item ${targetIdStr} added to WO ${nsWorkOrderId} at line ${newRow.line}`)

  _bomCache.set(nsWorkOrderId, newLines)
  bomLines.length = 0
  bomLines.push(...newLines)
  return newRow
}

// Build the transform body for a workOrderIssue that issues quantity lbs of
// one component (the "target" item) against the named WO BOM line. Returns
// { body, allocations } — body goes to NS, allocations carries per-(lot,bin)
// breakdown for logging / audit.
//
// All non-target BOM lines are OMITTED from the items array entirely. NS's
// transform endpoint auto-populates default qty for unspecified lines but
// only validates lines we touch; sending them at qty=0 (with or without
// empty inventoryassignment) makes NS demand inventory detail for any
// lot/bin tracked aux lines (vitamins, citrate, etc.) and reject the issue
// before getting to inventory-quantity validation.
//
// Field names + ID shape follow what NS actually accepts on this endpoint
// (verified by scripts/probeLotShape.js on 2026-05-19):
//   - lowercase componentinventorydetail / inventoryassignment
//   - raw string IDs for issueinventorynumber / binnumber (no { id } wrapping)
//   - status: 1 ("Good") — silently ignored, kept for parity with manufacturing
//
// See [[ns-wo-issue-shape]] and [[lot-tracked-bom-components]] memories.
async function buildWoIssueBody(nsWorkOrderId, targetItemId, quantity, preferredBinId, bomLines, opts = {}) {
  const tracking = await nsInventory.getItemTracking(targetItemId)
  const targetLine = await ensureItemOnWoBom(nsWorkOrderId, targetItemId, bomLines)

  // Floor the request to 2-decimal lbs precision. Totalizer deltas come in
  // at full float precision (e.g. 20671.83897702), and when we echo that
  // value back into the inventoryAssignment, JS number serialization can
  // drift to a value microscopically higher than NS's stored available —
  // NS then rejects with "You only have N available." Truncating below
  // sensor precision keeps the request strictly under whatever NS has,
  // and a sub-penny remainder doesn't matter for lbs-tracked inventory.
  quantity = Math.floor(quantity * 100) / 100

  let allocations = null
  let resolvedBinId = preferredBinId
  if (tracking.isLot) {
    allocations = await nsInventory.findInventoryAllocations(targetItemId, quantity, preferredBinId)
    let allocatedQty = allocations.reduce((s, a) => s + a.qty, 0)
    if (allocatedQty + 1e-6 < quantity) {
      const shortfall = quantity - allocatedQty + SHORTFALL_BUFFER_LBS
      const adjusted = await tryShortfallAutoAdjust({ nsWorkOrderId, targetItemId, preferredBinId, shortfall })
      if (adjusted) {
        // NS inventorybalance view lags the inventoryAdjustment POST by a
        // few seconds. Poll with backoff before declaring the issue dead;
        // otherwise we adjust over and over while the tick stays at 0 lb.
        const result = await pollAllocations(targetItemId, quantity, preferredBinId)
        allocations = result.allocations
        allocatedQty = result.allocatedQty
      }
      if (allocatedQty + 1e-6 < quantity) {
        const err = new Error(`Insufficient inventory for item ${targetItemId}: need ${quantity}, found ${allocatedQty} across ${allocations.length} lot(s)`)
        err.code = 'INSUFFICIENT_INVENTORY'
        err.itemId = targetItemId
        err.needed = quantity
        err.available = allocatedQty
        err.allocations = allocations
        throw err
      }
    }
  } else if (tracking.useBins) {
    // Pass the requested quantity — findBinForItem returns null if the
    // preferred bin has SOME stock but not enough to cover the issue, so
    // we trigger the shortfall hook instead of posting an issue that NS
    // will reject with "you only have N available."
    resolvedBinId = await nsInventory.findBinForItem(targetItemId, preferredBinId, quantity)
    if (!resolvedBinId) {
      // Compute the actual shortfall using current on-hand (which can be
      // NEGATIVE when prior issues consumed past the bin's real balance).
      // shortfall = quantity - currentOnHand. If on-hand is -20k and we
      // need 21k, the real shortfall is 41k — not 21k. NS otherwise
      // rejects the issue with "Bin not available: On Hand: -20549..."
      const currentOnHand = preferredBinId
        ? await inventoryAdjustment.getBinQtyOnHand(targetItemId, preferredBinId)
        : 0
      const realShortfall = quantity - currentOnHand + SHORTFALL_BUFFER_LBS
      const adjusted = preferredBinId && realShortfall > 0
        ? await tryShortfallAutoAdjust({ nsWorkOrderId, targetItemId, preferredBinId, shortfall: realShortfall })
        : false
      if (adjusted) {
        resolvedBinId = await pollBinForItem(targetItemId, preferredBinId, quantity)
      }
      if (!resolvedBinId) {
        const err = new Error(`Insufficient inventory for item ${targetItemId}: preferred bin ${preferredBinId} has less than ${quantity} lb available (on-hand ${currentOnHand.toFixed(2)})`)
        err.code = 'INSUFFICIENT_INVENTORY'
        err.itemId = targetItemId
        err.needed = quantity
        err.available = currentOnHand
        throw err
      }
    }
  }

  // Bin-only inventory-detail wrapper depends on the WO's tracking mix: blend
  // WOs carry lot-tracked vitamin/citrate lines, so this is true and bin-only
  // lines use the lowercase componentinventorydetail shape (camelCase is
  // silently ignored on a lot-bearing WO). See nsInventory.buildComponentDetail.
  // opts.forceWoHasLotLines overrides the auto-detection — used by the
  // wrapper-mismatch retry (Bug A) when NS rejected our first guess with
  // "configure the inventory detail in line N".
  const woHasLotLines = opts.forceWoHasLotLines != null
    ? opts.forceWoHasLotLines
    : await nsInventory.anyLotTracked(bomLines)
  const { quantity: issueQty, detail } = nsInventory.buildComponentDetail(tracking, quantity, allocations, resolvedBinId, woHasLotLines)

  // issueQty == quantity for bin-only lines; for lot lines it's the sum of the
  // floored per-lot qtys (≤ quantity) so the line matches the assignment total.
  const componentEntry = { lineNumber: targetLine.line, quantity: issueQty }
  if (detail) Object.assign(componentEntry, detail)

  return {
    body: { component: { items: [componentEntry] } },
    allocations,
    tracking,
  }
}

// NS rejects a bin-only component line with "Please configure the inventory
// detail in line N" when the issue body used the camelCase `inventoryDetail`
// wrapper but NS treats the WO as lot-bearing (so it silently ignored our
// detail). This is the anyLotTracked() guessing wrong — observed firing on
// EVERY tick of a single WO (4857929) until restart. See Bug A / [[ns-wo-issue-shape]].
function isWrapperMismatch(err) {
  return /configure the inventory detail in line/i.test(err?.message || '')
}

// POST a workOrderIssue, retrying ONCE with the lowercase componentinventorydetail
// wrapper forced on if NS rejects with the wrapper-mismatch signature above.
// Rebuilds the body via buildWoIssueBody with forceWoHasLotLines — an extra NS
// round-trip, but only on the (rare) retry path. Returns { nsResult, body }.
async function postWoIssueWithWrapperRetry({ nsWorkOrderId, targetItemId, quantity, binId, bomLines, body }) {
  try {
    const nsResult = await core.netsuitePost(`/record/v1/workOrder/${nsWorkOrderId}/!transform/workOrderIssue`, body)
    return { nsResult, body }
  } catch (err) {
    if (!isWrapperMismatch(err)) throw err
    console.warn(`[BlendTankMesService] WO ${nsWorkOrderId} rejected bin-only line wrapper ("configure inventory detail in line N") — retrying with lowercase componentinventorydetail`)
    const rebuilt = await buildWoIssueBody(nsWorkOrderId, targetItemId, quantity, binId, bomLines, { forceWoHasLotLines: true })
    const nsResult = await core.netsuitePost(`/record/v1/workOrder/${nsWorkOrderId}/!transform/workOrderIssue`, rebuilt.body)
    return { nsResult, body: rebuilt.body }
  }
}

// Source-bin auto-adjust hook for the WO-issue path. When NS has less on-hand
// in the source bin than the line totalizer says we just consumed, bump the
// source up by exactly the shortfall and signal the caller to retry the
// allocation lookup. Returns true on a successful adjust, false otherwise —
// the caller decides whether to retry the issue or surface INSUFFICIENT_INVENTORY.
// After an auto-adjust POST returns 200, NS's inventorybalance view takes
// a few seconds to reflect the new on-hand. Poll the allocation lookup with
// backoff (1s, 2s, 3s) instead of giving up on the immediate re-query.
const SHORTFALL_POLL_DELAYS_MS = [1000, 2000, 3000]
// When auto-adjusting a source bin up to cover an issue, overshoot by this much
// so the post-adjust available STRICTLY exceeds the request. NS stores available
// at higher precision than our 2dp request, so adjusting to exactly the request
// can leave available a hair under it → "you only have N" / "must be N". The
// extra few lb are reconciled by the at-rest sweep. See [[assemblyunbuild_must_be_n]].
const SHORTFALL_BUFFER_LBS = 5

async function pollAllocations(targetItemId, quantity, preferredBinId) {
  let allocations = []
  let allocatedQty = 0
  for (const delay of SHORTFALL_POLL_DELAYS_MS) {
    await new Promise(r => setTimeout(r, delay))
    allocations = await nsInventory.findInventoryAllocations(targetItemId, quantity, preferredBinId)
    allocatedQty = allocations.reduce((s, a) => s + a.qty, 0)
    if (allocatedQty + 1e-6 >= quantity) break
  }
  return { allocations, allocatedQty }
}

async function pollBinForItem(targetItemId, preferredBinId, neededQty = 0) {
  for (const delay of SHORTFALL_POLL_DELAYS_MS) {
    await new Promise(r => setTimeout(r, delay))
    const bin = await nsInventory.findBinForItem(targetItemId, preferredBinId, neededQty)
    if (bin) return bin
  }
  return null
}

async function tryShortfallAutoAdjust({ nsWorkOrderId, targetItemId, preferredBinId, shortfall }) {
  if (!preferredBinId || !(shortfall > 0)) return false
  let lastWoNumber = null
  let tankName = null
  try {
    const batch = await db.MesBlendTankBatch.findOne({
      where: { nsWorkOrderId: String(nsWorkOrderId) },
      attributes: ['tankId', 'nsWorkOrderNumber'],
    })
    lastWoNumber = batch?.nsWorkOrderNumber || null
    tankName = batch?.tankId || null
  } catch (err) {
    console.warn(`[BlendTankMesService] tryShortfallAutoAdjust DB lookup failed: ${err.message}`)
  }
  const result = await inventoryAdjustment.applyShortfallAdjustment({
    sourceBinId: preferredBinId,
    itemId: targetItemId,
    shortfallQty: shortfall,
    lastWoNumber,
    tankName,
    memo: `Auto-adjust: blend WO ${nsWorkOrderId} issue shortfall (+${shortfall.toFixed(2)} lb)`,
  })
  return !!result?.ok
}

function extractNsIssueId(nsResult) {
  if (nsResult?.body?.id) return String(nsResult.body.id)
  if (nsResult?.id) return String(nsResult.id)
  const loc = nsResult?.headers?.location
  if (loc) {
    const m = String(loc).match(/\/(\d+)$/)
    if (m) return m[1]
  }
  return null
}

async function processWOStart(data, historian) {
  const { tankId, productName, batchSize, fromEntName, toEntName, detectedAt } = data

  if (!tankId) throw new Error('tankId is required')
  if (!productName) throw new Error('productName is required')

  const existing = await db.MesBlendTankBatch.findOne({
    where: { tankId, productName, status: ['active', 'dry_run'] },
  })
  if (existing) {
    console.log(`[BlendTankMesService] "${productName}" on ${tankId} already active (status: ${existing.status}, nsWO: ${existing.nsWorkOrderId || 'none'}) — skipping`)
    return { success: true, duplicate: true, tankId, productName, status: existing.status }
  }

  const COOLDOWN_MINUTES = 5
  const recentBatch = await db.MesBlendTankBatch.findOne({
    where: {
      tankId,
      detectedAt: { [db.Sequelize.Op.gte]: new Date(clock.now() - COOLDOWN_MINUTES * 60 * 1000) },
    },
    order: [['detectedAt', 'DESC']],
  })
  if (recentBatch) {
    const ageSec = Math.round((clock.now() - new Date(recentBatch.detectedAt).getTime()) / 1000)
    console.warn(`[BlendTankMesService] COOLDOWN: "${productName}" on ${tankId} rejected — last batch "${recentBatch.productName}" was ${ageSec}s ago (min ${COOLDOWN_MINUTES * 60}s)`)
    return { success: true, cooldown: true, tankId, productName, lastBatchAge: ageSec }
  }

  // Test-input override: if BLEND_TANK_OVERRIDES has an entry for this tank,
  // use it directly and skip the parser. This is the temporary stand-in for
  // the not-yet-available AVEVA product tag.
  const overrideItemId = config.BLEND_TANK_OVERRIDES?.[tankId]
  let parsed, assemblyItem
  if (overrideItemId) {
    const overrideCatalog = productParser.getProductByNsId(overrideItemId)
    const overrideName = overrideCatalog?.name || `NS item ${overrideItemId}`
    console.log(`[BlendTankMesService] OVERRIDE: ${tankId} → NS item ${overrideItemId} (${overrideName}) — skipping parser`)
    parsed = { nsId: overrideItemId, name: overrideName, confidence: 'override', score: 0, parsed: { override: true, productName } }
    assemblyItem = { id: overrideItemId, name: overrideName, confidence: 'override' }
  } else {
    parsed = productParser.parseProductName(productName)
    assemblyItem = parsed
      ? { id: parsed.nsId, name: parsed.name, confidence: parsed.confidence }
      : { id: null, name: `Unrecognized: "${productName}"`, confidence: 'none' }
  }

  console.log(`[BlendTankMesService] Processing batch start: ${tankId} / "${productName}"`)
  console.log(`  Parsed: ${assemblyItem.name} (NS ${assemblyItem.id}, confidence: ${assemblyItem.confidence})`)
  console.log(`  BatchSize: ${batchSize}, From: ${fromEntName}, To: ${toEntName}`)

  const record = await db.MesBlendTankBatch.create({
    tankId,
    productName,
    mesItem: parsed?.nsId ? String(parsed.nsId) : null,
    batchSize: batchSize || null,
    fromEntName: fromEntName || null,
    toEntName: toEntName || null,
    parserConfidence: assemblyItem.confidence,
    status: 'active',
    detectedAt: detectedAt || new Date(clock.now()),
  })

  let nsResult = null
  try {
    if (config.MES_DRY_RUN) {
      console.log(`[BlendTankMesService] DRY RUN — "${productName}" saved, skipping NS creation`)
      await record.update({ status: 'dry_run' })
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_wo_create', sourceId: `${tankId}:${productName}`,
        nsTransactionType: 'workOrder', payload: JSON.stringify(data),
        result: JSON.stringify({ dryRun: true, parsed }), success: true,
      })
      return { success: true, duplicate: false, tankId, productName, status: 'dry_run', parsed }
    }

    if (!assemblyItem.id) {
      console.log(`[BlendTankMesService] No NS item for "${productName}" — skipping NS WO creation`)
      await record.update({ status: 'pending_ns' })
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_wo_create', sourceId: `${tankId}:${productName}`,
        nsTransactionType: 'workOrder', payload: JSON.stringify(data),
        result: JSON.stringify({ skipped: 'product not recognized', parsed }), success: true,
      })
      return { success: true, duplicate: false, tankId, productName, status: 'pending_ns', parsed }
    }

    // Defensive guard: a blend-tank WO must BUILD a lot-tracked item. If the
    // product resolved to a NON-lot item (e.g. a standardization milk that
    // wasn't repointed to its lot twin), creating the WO would seed the assembly
    // as its own component (circular) and the issue/build would fail on a
    // missing cost basis — the exact failure mode that lost 207k lb over a
    // weekend. Park as pending_ns + alert instead of opening a doomed WO.
    let assemblyTracking
    try {
      assemblyTracking = await nsInventory.getItemTracking(assemblyItem.id)
    } catch (err) {
      console.warn(`[BlendTankMesService] could not read tracking for item ${assemblyItem.id}: ${err.message} — proceeding`)
    }
    if (assemblyTracking && !assemblyTracking.isLot) {
      const msg = `${tankId}: "${productName}" resolved to NON-lot item ${assemblyItem.id} (${assemblyItem.name}). A batch tank must build a lot-tracked item — needs a "(Batch)" lot twin + parser repoint. Parked pending_ns (no WO created).`
      console.warn(`[BlendTankMesService] ${msg}`)
      await record.update({ status: 'pending_ns', errorMessage: `non-lot assembly ${assemblyItem.id}` })
      statusStore.pushEvent('blendTank.nonLotAssembly', msg, { tankId, productName, assemblyItemId: assemblyItem.id })
      await core.sendStagingNotification('MES: batch product is not lot-tracked', msg).catch(() => {})
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_wo_create', sourceId: `${tankId}:${productName}`,
        nsTransactionType: 'workOrder', payload: JSON.stringify(data),
        result: JSON.stringify({ skipped: 'assembly not lot-tracked', assemblyItemId: assemblyItem.id, parsed }),
        success: true,
      })
      return { success: true, duplicate: false, tankId, productName, status: 'pending_ns', parsed }
    }

    const body = {
      assemblyItem: { id: assemblyItem.id },
      quantity: batchSize || 1,
      location: { id: 30 },
      subsidiary: { id: 3 },
      // isWip MUST be true — controls whether NS lets us create
      // workOrderIssue transactions against the WO. Without it, NS rejects
      // every issue with "the work order does not use WIP, or the work
      // order is already closed". Discovered 2026-05-19 via WO1364 (isWip
      // false, every issue 400'd) vs WO1365 (isWip true, issues working).
      isWip: true,
      custbody_mes_tank_id: tankId,
      custbody_mes_product_name: productName,
      custbody_mes_source_entity: fromEntName || null,
      custbody_mes_dest_entity: toEntName || null,
    }

    console.log(`[BlendTankMesService] Creating NS WO for "${productName}" on ${tankId}`)
    try {
      nsResult = await core.netsuitePost('/record/v1/workOrder', body)
    } catch (woCreateErr) {
      // NS rejects WO creation with HTTP 400 "at least one line item" when the
      // assembly item has no BOM configured in NetSuite (newer items added outside
      // the main NS item setup flow). Retry with the assembly item seeded as a
      // 0-qty placeholder component so the WO can be created; ensureItemOnWoBom
      // will patch in the real flowing ingredients at issue time.
      if (woCreateErr.message?.includes('at least one line item')) {
        console.warn(`[BlendTankMesService] NS WO for item ${assemblyItem.id} has no BOM — retrying with seed component`)
        body.item = { items: [{ item: { id: assemblyItem.id }, quantity: 0 }] }
        nsResult = await core.netsuitePost('/record/v1/workOrder', body)
      } else {
        throw woCreateErr
      }
    }
    console.log(`[BlendTankMesService] NS WO response: status=${nsResult?.status}`)

    let nsWorkOrderId = nsResult?.id || null
    let nsWorkOrderNumber = nsResult?.tranid || null

    if (!nsWorkOrderId && nsResult?.headers?.location) {
      const match = nsResult.headers.location.match(/\/(\d+)$/)
      if (match) {
        nsWorkOrderId = match[1]
        try {
          const woDetail = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?fields=tranId`)
          const woBody = woDetail?.body || woDetail
          nsWorkOrderNumber = woBody?.tranId || woBody?.tranid || null
        } catch (e) {
          console.warn(`[BlendTankMesService] Could not fetch WO details: ${e.message}`)
        }
      }
    }

    await record.update({ nsWorkOrderId, nsWorkOrderNumber, status: 'active' })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_wo_create', sourceId: `${tankId}:${productName}`,
      nsTransactionType: 'workOrder', nsTransactionId: nsWorkOrderId,
      payload: JSON.stringify(data), result: JSON.stringify(nsResult), success: true,
    })

    console.log(`[BlendTankMesService] "${productName}" → NS WO ${nsWorkOrderNumber} (${nsWorkOrderId})`)

    // Late-naming recovery: if this tank was filled BEFORE it was named, the
    // line flows landed as status='unmatched'. Attach + issue + complete them
    // now against the WO we just created. Guarded so a backfill hiccup never
    // marks the (successful) WO-create as failed.
    let backfill = null
    try {
      await record.reload()
      backfill = await backfillUnmatchedInflows(record)
      if (backfill.attached > 0) {
        console.log(`[BlendTankMesService] "${productName}" on ${tankId}: backfilled ${backfill.attached} pre-batch inflow(s), ${backfill.issued} issue(s) fired`)
      }
    } catch (err) {
      console.error(`[BlendTankMesService] backfill of unmatched inflows for ${tankId} failed:`, err.message)
    }

    // Fire-and-forget: back-project the actual start time from historian data.
    if (historian) {
      batchStartFinder.findBlendTankActualStart(tankId, new Date(detectedAt || clock.now()), historian, normalizeTankRef)
        .then(result => { if (result) return record.update({ actualStartAt: result.estimatedStartAt }) })
        .catch(err => console.warn(`[BlendTankMesService] actualStart finder failed for ${tankId}: ${err.message}`))
    }

    return { success: true, duplicate: false, tankId, productName, nsWorkOrderId, nsWorkOrderNumber, status: 'active', parsed, backfill }

  } catch (err) {
    console.error(`[BlendTankMesService] Failed to create NS WO for "${productName}":`, err.message)
    await record.update({ status: 'error', errorMessage: err.message })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_wo_create', sourceId: `${tankId}:${productName}`,
      nsTransactionType: 'workOrder', payload: JSON.stringify(data), success: false, errorMessage: err.message,
    })
    throw err
  }
}

/**
 * End-of-batch handler — fired when the blend tank empties or product clears.
 *
 * The tick has been firing incremental issues + completions throughout the
 * batch's life, so by the time we get here cumulativeIssued and
 * cumulativeCompleted are already populated. We just need to flush any final
 * delta (one last completion) and close the batch.
 */
async function processWOEnd(data) {
  const { tankId, productName, detectedAt } = data

  if (!tankId) throw new Error('tankId is required')

  const where = { tankId, status: 'active' }
  if (productName) where.productName = productName

  const record = await db.MesBlendTankBatch.findOne({ where })

  if (!record) {
    console.log(`[BlendTankMesService] No active batch for ${tankId}${productName ? ` / "${productName}"` : ''} — ignoring end event`)
    return { success: true, message: 'No active batch found' }
  }

  // Rollover safety: batches that were started under the legacy code path
  // (before the tick existed) have cumulativeIssuedLbs=0 because nothing has
  // been incrementing it. Their issue history lives in MesBlendTankInflow
  // rows with status='completed'. If we don't backfill, tickCompletionForBatch
  // will compute target=0 and the batch will close with no FG completion.
  if ((parseFloat(record.cumulativeIssuedLbs) || 0) === 0) {
    const legacyIssued = await db.MesBlendTankInflow.sum('totalLbs', {
      where: { blendTankBatchId: record.id, status: 'completed' },
    }) || 0
    if (legacyIssued > 0) {
      console.log(`[BlendTankMesService] Backfilling cumulativeIssuedLbs from legacy inflows for batch ${record.id}: ${legacyIssued.toFixed(1)} lb`)
      await record.update({ cumulativeIssuedLbs: legacyIssued })
      await record.reload()
    }
  }

  // Legacy / no-arrival fallback: completion is now driven by measured arrival
  // (cumulativeOutputLbs). Batches that predate arrival tracking — or where the
  // load cell never reported during the batch (lastDestLevelLbs still null) —
  // have output=0 and would strand their completion. Don't claim phantom waste
  // for them: fall back to completing everything issued (1:1, waste unmeasured).
  if ((parseFloat(record.cumulativeOutputLbs) || 0) <= 0 &&
      record.lastDestLevelLbs == null &&
      (parseFloat(record.cumulativeIssuedLbs) || 0) > 0) {
    console.log(`[BlendTankMesService] ${tankId}: no arrival measured this batch — completing issued 1:1 (no waste claim)`)
    await record.update({ cumulativeOutputLbs: parseFloat(record.cumulativeIssuedLbs) || 0 })
    await record.reload()
  }

  const flushed = await tickCompletionForBatch(record).catch(err => {
    console.error(`[BlendTankMesService] Final completion flush failed for ${tankId}:`, err.message)
    return false
  })
  await record.reload()

  // Waste = issued (line-totalizer inflow) − output (measured weight arrival).
  // The gap is the leg loss into this tank, left as implicit NS shrinkage.
  const issuedLbs = parseFloat(record.cumulativeIssuedLbs) || 0
  const outputLbs = parseFloat(record.cumulativeOutputLbs) || 0
  const wasteLbs = Math.max(0, issuedLbs - outputLbs)
  const wastePercent = issuedLbs >= 10
    ? Math.max(0, Math.min(999999.99, (wasteLbs / issuedLbs) * 100))
    : null

  await record.update({
    status: 'completed',
    completedAt: detectedAt || new Date(clock.now()),
    wasteLbs,
    wastePercent,
  })
  statusStore.recordClosedBlendBatch(record)
  if (record.nsWorkOrderId) clearBomCache(record.nsWorkOrderId)
  await db.MesProcessingLog.create({
    eventType: 'blend_tank_wo_complete',
    sourceId: `${tankId}:${record.productName}`,
    nsTransactionType: 'workOrderCompletion',
    nsTransactionId: record.nsWorkOrderId,
    payload: JSON.stringify(data),
    result: JSON.stringify({
      completed: true,
      cumulativeIssuedLbs: issuedLbs,
      cumulativeOutputLbs: outputLbs,
      cumulativeCompletedLbs: parseFloat(record.cumulativeCompletedLbs) || 0,
      wasteLbs,
      wastePercent,
      finalCompletionFired: flushed,
    }),
    success: true,
  })

  if (wastePercent != null && wastePercent > itemConfig.WASTE_ALERT_THRESHOLD) {
    console.warn(`[BlendTankMesService] High waste alert: ${wastePercent.toFixed(1)}% on ${tankId}`)
    await core.sendStagingNotification(
      'MES Blend Tank: High Waste Alert',
      `Batch "${record.productName}" on ${tankId}\nWaste: ${wasteLbs.toFixed(1)} LBS (${wastePercent.toFixed(1)}%)\nIssued ${issuedLbs.toFixed(0)} | Reached tank ${outputLbs.toFixed(0)}\nThreshold: ${itemConfig.WASTE_ALERT_THRESHOLD}%`
    ).catch(e => console.warn(`[BlendTankMesService] waste alert send failed: ${e.message}`))
  }

  console.log(`[BlendTankMesService] Batch "${record.productName}" on ${tankId} closed — issued ${issuedLbs.toFixed(0)} lb, reached ${outputLbs.toFixed(0)} lb, completed ${parseFloat(record.cumulativeCompletedLbs).toFixed(0)} lb, waste ${wasteLbs.toFixed(0)} lb (${wastePercent != null ? wastePercent.toFixed(1) + '%' : 'n/a'})`)
  return {
    success: true,
    tankId,
    productName: record.productName,
    status: 'completed',
    cumulativeIssuedLbs: issuedLbs,
    cumulativeOutputLbs: outputLbs,
    cumulativeCompletedLbs: parseFloat(record.cumulativeCompletedLbs) || 0,
    wasteLbs,
    wastePercent,
  }
}

/**
 * Late-naming backfill — fired from processWOStart the moment a batch opens
 * with an NS WO. Operators sometimes fill a tank and only name it hours later;
 * every line.flowComplete that fired before the name existed was saved as
 * status='unmatched' (blendTankBatchId=null) because no active batch matched
 * the destination at the time. Without this sweep the new WO is created empty
 * and never issued or completed.
 *
 * Sweeps recent unmatched inflows (within MES_INFLOW_BACKFILL_LOOKBACK_HOURS),
 * matches them to this batch by canonical destination (BT2A ↔ BlendTank2A),
 * falling back to siloName ↔ fromEntName only when the inflow had no
 * destination. Re-resolves the NS item from the stored product name and the
 * bin from the stored silo (unmatched rows were saved with nsItemId=null),
 * groups by (bin, item), fires one workOrderIssue per group, then flushes a
 * completion so the WO closes out the full filled amount.
 *
 * Every matched row leaves the 'unmatched' pool (attached to this batch with a
 * terminal status) so a second batch opening later can't double-grab it.
 */
/**
 * Find recent status='unmatched' inflows (within MES_INFLOW_BACKFILL_LOOKBACK_HOURS)
 * that belong to the given tank — matched by canonical destination
 * (BT2A ↔ BlendTank2A), falling back to siloName ↔ fromEntName only when the
 * inflow had no destination. Returns the matching MesBlendTankInflow rows
 * (empty array if none). Shared by backfillUnmatchedInflows (to issue them)
 * and blendTankJob's named-late START trigger (to decide whether to open a
 * batch for a tank that was filled before it was named).
 */
async function findMatchableUnmatchedInflows(tankId, fromEntName) {
  const lookbackMs = config.MES_INFLOW_BACKFILL_LOOKBACK_HOURS * 60 * 60 * 1000
  const since = new Date(clock.now() - lookbackMs)
  const orphans = await db.MesBlendTankInflow.findAll({
    where: {
      status: 'unmatched',
      blendTankBatchId: null,
      createdAt: { [db.Sequelize.Op.gte]: since },
    },
    order: [['createdAt', 'ASC']],
  })
  if (orphans.length === 0) return []

  const tankCanonical = normalizeTankRef(tankId)
  const batchSilo = itemConfig.normalizeSiloName(fromEntName)
  return orphans.filter(o => {
    const destCanon = normalizeTankRef(o.destination)
    if (destCanon) return destCanon === tankCanonical
    // Inflow had no destination (REQUESTEDBY was empty) — fall back to the
    // line's source silo vs this batch's fromEntName.
    if (o.siloName && batchSilo) return itemConfig.normalizeSiloName(o.siloName) === batchSilo
    return false
  })
}

async function backfillUnmatchedInflows(batch) {
  if (!batch.nsWorkOrderId) return { attached: 0, issued: 0 }

  const matched = await findMatchableUnmatchedInflows(batch.tankId, batch.fromEntName)
  if (matched.length === 0) return { attached: 0, issued: 0 }

  console.log(`[BlendTankMesService] backfill: ${matched.length} unmatched inflow(s) match ${batch.tankId} (WO ${batch.nsWorkOrderId})`)
  statusStore.pushEvent(
    'blendTank.backfill',
    `${batch.tankId}: attaching ${matched.length} pre-batch line flow(s) to WO ${batch.nsWorkOrderNumber || batch.nsWorkOrderId}`,
    { tankId: batch.tankId, nsWorkOrderId: batch.nsWorkOrderId, count: matched.length }
  )

  // Resolve NS item (from stored product name) + bin (from stored silo) for
  // each. Rows we can't route are still attached to the batch so they leave
  // the unmatched pool, but parked at pending_ns instead of being issued.
  const routed = []
  for (const o of matched) {
    const component = resolveLineComponent({ line: o.line, productName: o.ingredientType })
    const binId = itemConfig.getBinId(o.siloName)
    const lbs = parseFloat(o.totalLbs) || 0
    if (!component?.id || !binId || lbs < config.MES_MIN_ISSUE_LBS) {
      const reason = !component?.id
        ? `no NS item for "${o.ingredientType}"`
        : !binId ? `no bin for silo "${o.siloName}"` : `below min issue (${lbs.toFixed(1)} lb)`
      console.warn(`[BlendTankMesService] backfill skip inflow ${o.id} (${o.line}, ${lbs.toFixed(1)} lb): ${reason}`)
      await o.update({ blendTankBatchId: batch.id, status: 'pending_ns', errorMessage: `backfill: ${reason}` })
      continue
    }
    routed.push({ inflow: o, component, binId, lbs })
  }
  if (routed.length === 0) return { attached: matched.length, issued: 0 }

  if (config.MES_DRY_RUN) {
    let total = 0
    for (const r of routed) {
      await r.inflow.update({ blendTankBatchId: batch.id, nsItemId: String(r.component.id), status: 'dry_run' })
      total += r.lbs
    }
    // Backfilled inflows physically reached the tank before it was named, so the
    // tick never saw their weight rise. Mirror into cumulativeOutputLbs so they
    // complete 1:1 and don't surface as phantom waste (no loss to claim here).
    await batch.increment({ cumulativeIssuedLbs: total, cumulativeOutputLbs: total })
    console.log(`[BlendTankMesService] DRY RUN backfill ${batch.tankId}: ${total.toFixed(1)} lb across ${routed.length} inflow(s)`)
    return { attached: matched.length, issued: 0 }
  }

  // Group by (source bin, item) — one workOrderIssue per tuple, same rule the
  // tick uses (memory [[bt-wo-issue-grouping]]).
  const groups = new Map()
  for (const r of routed) {
    const key = `${r.binId}:${r.component.id}`
    if (!groups.has(key)) groups.set(key, { binId: r.binId, component: r.component, totalLbs: 0, members: [] })
    const g = groups.get(key)
    g.totalLbs += r.lbs
    g.members.push(r)
  }

  const bomLines = await fetchWoBomLines(batch.nsWorkOrderId)
  let issued = 0
  for (const g of groups.values()) {
    const memberLabel = g.members.map(m => m.inflow.line).join('+')

    let body
    try {
      ;({ body } = await buildWoIssueBody(batch.nsWorkOrderId, g.component.id, g.totalLbs, g.binId, bomLines))
    } catch (err) {
      console.error(`[BlendTankMesService] backfill ${memberLabel} → WO ${batch.nsWorkOrderId}: buildWoIssueBody failed — ${err.message}`)
      statusStore.pushEvent(
        'blendTank.backfillFailed',
        `${batch.tankId} ${memberLabel}: backfill buildWoIssueBody failed (${g.totalLbs.toFixed(0)} lb, item ${g.component.id}) — ${nsErrShort(err)}`,
        { tankId: batch.tankId, nsWorkOrderId: batch.nsWorkOrderId, phase: 'buildWoIssueBody', itemId: g.component.id, binId: g.binId, totalLbs: g.totalLbs, error: err.message.slice(0, 500) }
      )
      for (const m of g.members) await m.inflow.update({ blendTankBatchId: batch.id, nsItemId: String(g.component.id), status: 'pending_ns', errorMessage: err.message })
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_backfill_issue', sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue',
        payload: JSON.stringify({ batchId: batch.id, totalLbs: g.totalLbs, targetItem: g.component.id, preferredBinId: g.binId }),
        success: false, errorMessage: err.message,
      })
      continue
    }

    try {
      const posted = await postWoIssueWithWrapperRetry({
        nsWorkOrderId: batch.nsWorkOrderId, targetItemId: g.component.id,
        quantity: g.totalLbs, binId: g.binId, bomLines, body,
      })
      body = posted.body
      const nsResult = posted.nsResult
      const nsIssueId = extractNsIssueId(nsResult)
      for (const m of g.members) {
        await m.inflow.update({
          blendTankBatchId: batch.id,
          nsItemId: String(g.component.id),
          nsIssueId: nsIssueId ? String(nsIssueId) : null,
          status: 'completed',
        })
      }
      // Mirror into cumulativeOutputLbs: backfilled pre-batch mass already
      // reached the tank (arrival untrackable via the tick), so complete it 1:1
      // without claiming phantom waste.
      await batch.increment({ cumulativeIssuedLbs: g.totalLbs, cumulativeOutputLbs: g.totalLbs })
      await batch.update({ lastIssueAt: new Date(clock.now()) })
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_backfill_issue', sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue', nsTransactionId: nsIssueId,
        payload: JSON.stringify({ batchId: batch.id, members: g.members.map(m => ({ inflowId: m.inflow.id, line: m.inflow.line, lbs: m.lbs })), totalLbs: g.totalLbs, component: g.component, binId: g.binId }),
        result: JSON.stringify({ nsIssueId }), success: true,
      })
      console.log(`[BlendTankMesService] backfill issue ${memberLabel} → WO ${batch.nsWorkOrderId} (${batch.tankId}): ${g.totalLbs.toFixed(1)} lb "${g.component.name}" (NS ${g.component.id})`)
      issued++
    } catch (err) {
      console.error(`[BlendTankMesService] backfill issue failed ${memberLabel} → WO ${batch.nsWorkOrderId}: ${err.message}`)
      statusStore.pushEvent(
        'blendTank.backfillFailed',
        `${batch.tankId} ${memberLabel}: backfill workOrderIssue POST failed (${g.totalLbs.toFixed(0)} lb, prefBin=${g.binId}) — ${nsErrShort(err)}`,
        { tankId: batch.tankId, nsWorkOrderId: batch.nsWorkOrderId, phase: 'netsuitePost', itemId: g.component.id, binId: g.binId, totalLbs: g.totalLbs, error: err.message.slice(0, 500) }
      )
      for (const m of g.members) await m.inflow.update({ blendTankBatchId: batch.id, nsItemId: String(g.component.id), status: 'error', errorMessage: err.message })
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_backfill_issue', sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue',
        payload: JSON.stringify({ batchId: batch.id, totalLbs: g.totalLbs, binId: g.binId }),
        success: false, errorMessage: err.message,
      })
      await remediateCostBasisIfNeeded(batch, err)
    }
  }

  // Flush a completion for the freshly-issued amount so the WO closes out the
  // full filled quantity (reload first so the increments above are visible).
  await batch.reload()
  await tickCompletionForBatch(batch).catch(err => {
    console.error(`[BlendTankMesService] backfill completion flush failed for ${batch.tankId}: ${err.message}`)
  })

  return { attached: matched.length, issued }
}

/**
 * Tail-catcher: fired by blendTankJob the moment the line totalizer resets
 * (or the line's product clears). The reset value is the totalizer's peak
 * for this batch on this line. The 5-min tick may have already issued part
 * of it; we only fire NS for the remaining delta vs MesPipeIssueState.
 *
 * Without this safety net, a fill that completes inside one 5-min tick
 * window is invisible to the tick — the totalizer goes 0 → peak → 0
 * between two consecutive ticks and we never see the peak. This handler
 * captures it the moment blendTankJob detects the reset.
 */
async function processLineFlow(data) {
  const { line, totalLbs, lineProductName, productCode, ingredientType, siloName, destination, resetTime } = data

  if (!line) throw new Error('line is required')
  if (!totalLbs || totalLbs <= 0) return { success: true, skipped: 'no flow' }

  if (resetTime) {
    const existing = await db.MesBlendTankInflow.findOne({ where: { line, resetTime } })
    if (existing) {
      return { success: true, duplicate: true, inflowId: existing.id, status: existing.status }
    }
  }

  // Match the tank using the canonical normalizer (BT2A ↔ BlendTank2A)
  const activeBatches = await db.MesBlendTankBatch.findAll({ where: { status: 'active' } })
  let targetBatch = null
  if (activeBatches.length > 0 && destination) {
    const destCanonical = normalizeTankRef(destination)
    if (destCanonical) {
      targetBatch = activeBatches.find(b => normalizeTankRef(b.tankId) === destCanonical)
    }
    if (!targetBatch) {
      const destNorm = destination.toLowerCase().replace(/[^a-z0-9]/g, '')
      targetBatch = activeBatches.find(b => {
        const tankNorm = b.tankId.toLowerCase().replace(/[^a-z0-9]/g, '')
        return tankNorm === destNorm || tankNorm.includes(destNorm) || destNorm.includes(tankNorm)
      })
    }
  }

  // Silo fallback: when REQUESTEDBY was empty (destination=''), match by the
  // line's source silo vs the batch's stored fromEntName. Restricted to an
  // unambiguous 1-to-1 mapping to avoid double-issuing.
  if (!targetBatch && siloName && activeBatches.length > 0) {
    const siloCanon = itemConfig.normalizeSiloName(siloName)
    if (siloCanon) {
      const matched = activeBatches.filter(b => {
        const batchSilo = itemConfig.normalizeSiloName(b.fromEntName)
        return batchSilo !== null && batchSilo === siloCanon
      })
      if (matched.length === 1) {
        targetBatch = matched[0]
        console.log(`[BlendTankMesService] processLineFlow ${line}: matched ${targetBatch.tankId} via siloName="${siloName}" (REQUESTEDBY was empty)`)
      } else if (matched.length > 1) {
        console.warn(`[BlendTankMesService] processLineFlow ${line}: silo "${siloName}" matches ${matched.length} active batches — cannot route`)
      }
    }
  }

  if (!targetBatch) {
    const record = await db.MesBlendTankInflow.create({
      blendTankBatchId: null, line,
      ingredientType: lineProductName || ingredientType || 'unknown',
      totalLbs, nsItemId: null, status: 'unmatched', resetTime,
      destination: destination || null, siloName: siloName || null,
    })
    console.log(`[BlendTankMesService] processLineFlow ${line} reset (${totalLbs.toFixed(1)} lb) — no active batch matched destination "${destination}"`)
    return { success: true, inflowId: record.id, status: 'unmatched' }
  }

  // Compute the tail delta — totalizer's peak minus what the tick already issued
  const pipeState = await db.MesPipeIssueState.findOne({
    where: { blendTankBatchId: targetBatch.id, line },
  })
  const lastIssued = pipeState ? (parseFloat(pipeState.lastIssuedTotalizerLbs) || 0) : 0
  const delta = totalLbs - lastIssued

  if (delta < config.MES_MIN_ISSUE_LBS) {
    const record = await db.MesBlendTankInflow.create({
      blendTankBatchId: targetBatch.id, line,
      ingredientType: lineProductName || ingredientType || 'unknown',
      totalLbs, nsItemId: null, status: 'tick_already_issued', resetTime,
      destination: destination || null, siloName: siloName || null,
    })
    console.log(`[BlendTankMesService] processLineFlow ${line} reset (${totalLbs.toFixed(1)} lb): tick already issued ${lastIssued.toFixed(1)} — no tail to catch`)
    return { success: true, inflowId: record.id, status: 'tick_already_issued' }
  }

  const component = resolveLineComponent({ line, productName: lineProductName, productCode })
  const binId = itemConfig.getBinId(siloName)

  const inflowRecord = await db.MesBlendTankInflow.create({
    blendTankBatchId: targetBatch.id,
    line,
    ingredientType: lineProductName || ingredientType || (line.startsWith('CL') ? 'cream' : 'skim'),
    totalLbs: delta,
    nsItemId: component?.id ? String(component.id) : null,
    status: 'pending',
    resetTime,
    destination: destination || null,
    siloName: siloName || null,
  })

  if (config.MES_DRY_RUN) {
    await inflowRecord.update({ status: 'dry_run' })
    console.log(`[BlendTankMesService] DRY RUN tail-catcher ${line} → ${targetBatch.tankId}: ${delta.toFixed(1)} lb`)
    return { success: true, inflowId: inflowRecord.id, status: 'dry_run' }
  }
  if (!targetBatch.nsWorkOrderId || !component?.id || !binId) {
    await inflowRecord.update({ status: 'pending_ns' })
    console.warn(`[BlendTankMesService] tail-catcher ${line} → ${targetBatch.tankId}: missing ${!targetBatch.nsWorkOrderId ? 'NS WO' : !component?.id ? 'NS item' : 'bin'} — saved as pending_ns (delta ${delta.toFixed(1)})`)
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_tail_issue', sourceId: targetBatch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue', payload: JSON.stringify(data),
      result: JSON.stringify({ skipped: 'gap', siloName, component, binId }),
      success: true,
    })
    return { success: true, inflowId: inflowRecord.id, status: 'pending_ns' }
  }

  const bomLines = await fetchWoBomLines(targetBatch.nsWorkOrderId)
  let body, allocations
  try {
    const built = await buildWoIssueBody(targetBatch.nsWorkOrderId, component.id, delta, binId, bomLines)
    body = built.body
    allocations = built.allocations
  } catch (err) {
    console.error(`[BlendTankMesService] tail-catcher ${line}: buildWoIssueBody failed — ${err.message}`)
    statusStore.pushEvent(
      'blendTail.issueFailed',
      `${targetBatch.tankId} ${line}: tail-catcher buildWoIssueBody failed (${delta.toFixed(0)} lb, item ${component?.id}) — ${nsErrShort(err)}`,
      {
        tankId: targetBatch.tankId,
        line,
        nsWorkOrderId: targetBatch.nsWorkOrderId,
        phase: 'buildWoIssueBody',
        code: err.code || null,
        itemId: component?.id || null,
        binId,
        delta,
        error: err.message.slice(0, 500),
      }
    )
    await inflowRecord.update({ status: 'pending_ns' })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_tail_issue', sourceId: targetBatch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue', payload: JSON.stringify(data),
      result: null, success: false, errorMessage: err.message,
    })
    return { success: true, inflowId: inflowRecord.id, status: 'pending_ns', error: err.message }
  }

  try {
    const allocSummary = allocations
      ? ` via ${allocations.map(a => `lot ${a.lotName}@${a.binName} ${a.qty.toFixed(1)}`).join(' + ')}`
      : ''
    console.log(`[BlendTankMesService] tail-catcher ${line} → WO ${targetBatch.nsWorkOrderId} (${targetBatch.tankId}): ${delta.toFixed(1)} lb (peak ${totalLbs.toFixed(1)}, tick had issued ${lastIssued.toFixed(1)})${allocSummary}`)
    const issued = await postWoIssueWithWrapperRetry({
      nsWorkOrderId: targetBatch.nsWorkOrderId, targetItemId: component.id,
      quantity: delta, binId, bomLines, body,
    })
    body = issued.body
    const nsResult = issued.nsResult
    const nsIssueId = extractNsIssueId(nsResult)

    await inflowRecord.update({ nsIssueId: nsIssueId ? String(nsIssueId) : null, status: 'completed' })
    // Bring the pipe state up to the peak so the next tick doesn't re-issue
    if (pipeState) {
      await pipeState.update({ lastIssuedTotalizerLbs: totalLbs, lastIssueAt: new Date(clock.now()) })
    } else {
      await db.MesPipeIssueState.create({
        blendTankBatchId: targetBatch.id, line,
        lastIssuedTotalizerLbs: totalLbs, lastIssueAt: new Date(clock.now()),
        lastTotalizerLbs: totalLbs, lastObservedAt: new Date(clock.now()),
      })
    }
    await targetBatch.increment({ cumulativeIssuedLbs: delta })
    await targetBatch.update({ lastIssueAt: new Date(clock.now()) })

    await db.MesProcessingLog.create({
      eventType: 'blend_tank_tail_issue', sourceId: targetBatch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue', nsTransactionId: nsIssueId,
      payload: JSON.stringify({ ...data, delta, lastIssued }),
      result: JSON.stringify({ nsIssueId }),
      success: true,
    })

    return { success: true, inflowId: inflowRecord.id, nsIssueId, status: 'completed' }
  } catch (err) {
    console.error(`[BlendTankMesService] tail-catcher ${line} → WO ${targetBatch.nsWorkOrderId} failed:`, err.message)
    statusStore.pushEvent(
      'blendTail.issueFailed',
      `${targetBatch.tankId} ${line}: NS workOrderIssue POST failed (${delta.toFixed(0)} lb) — ${nsErrShort(err)}`,
      {
        tankId: targetBatch.tankId,
        line,
        nsWorkOrderId: targetBatch.nsWorkOrderId,
        phase: 'netsuitePost',
        delta,
        error: err.message.slice(0, 500),
      }
    )
    await inflowRecord.update({ status: 'error', errorMessage: err.message })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_tail_issue', sourceId: targetBatch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue', payload: JSON.stringify(data),
      success: false, errorMessage: err.message,
    })
    await remediateCostBasisIfNeeded(targetBatch, err)
    return { success: true, inflowId: inflowRecord.id, status: 'error', error: err.message }
  }
}

async function getActiveBatches() {
  const batches = await db.MesBlendTankBatch.findAll({
    where: { status: 'active' },
    order: [['createdAt', 'DESC']],
  })
  return { success: true, batches }
}

async function getBatchComponents(batchId) {
  const batch = await db.MesBlendTankBatch.findByPk(batchId)
  if (!batch) throw new Error(`Batch ${batchId} not found`)

  const inflows = await db.MesBlendTankInflow.findAll({
    where: { blendTankBatchId: batchId },
    order: [['createdAt', 'ASC']],
  })

  let bomComponents = []
  if (batch.nsWorkOrderId && !config.MES_DRY_RUN) {
    try {
      const nsResult = await core.netsuiteGet(`/record/v1/workOrder/${batch.nsWorkOrderId}?expandSubResources=true`)
      bomComponents = nsResult?.component?.items || []
    } catch (err) {
      console.error('[BlendTankMesService] Failed to fetch NS WO components:', err.message)
    }
  }

  return { success: true, batch, bomComponents, inflows }
}

async function issueIngredient(batchId, data) {
  const { nsItemId, quantity, lot, siloName, binId: explicitBinId } = data

  if (!nsItemId) throw new Error('nsItemId is required')
  if (!quantity || quantity <= 0) throw new Error('quantity must be greater than 0')

  const batch = await db.MesBlendTankBatch.findByPk(batchId)
  if (!batch) throw new Error(`Batch ${batchId} not found`)
  if (!batch.nsWorkOrderId) throw new Error(`Batch ${batchId} has no NS work order — cannot issue`)

  const resolvedBinId = explicitBinId || (siloName ? itemConfig.getBinId(siloName) : null)

  const inventoryDetailItems = [{ quantity }]
  if (lot) inventoryDetailItems[0].issueinventorynumber = { id: lot }
  if (resolvedBinId) inventoryDetailItems[0].binnumber = { id: resolvedBinId }

  const itemEntry = { item: { id: nsItemId }, quantity }
  if (lot || resolvedBinId) {
    itemEntry.inventorydetail = { inventoryassignment: { items: inventoryDetailItems } }
  }

  const body = {
    transaction: { id: batch.nsWorkOrderId },
    item: { items: [itemEntry] },
  }

  const nsResult = await core.netsuitePost('/record/v1/workOrderIssue', body)

  let nsIssueId = nsResult?.id || null
  if (!nsIssueId && nsResult?.headers?.location) {
    const match = nsResult.headers.location.match(/\/(\d+)$/)
    if (match) nsIssueId = match[1]
  }

  await db.MesProcessingLog.create({
    eventType: 'blend_tank_manual_issue', sourceId: batch.nsWorkOrderId,
    nsTransactionType: 'workOrderIssue', nsTransactionId: nsIssueId,
    payload: JSON.stringify({ batchId, ...data }), result: JSON.stringify(nsResult), success: true,
  })

  console.log(`[BlendTankMesService] Manual issue to WO ${batch.nsWorkOrderId}: item ${nsItemId}, qty ${quantity}`)
  return { success: true, nsIssueId }
}

/**
 * Resolve the NS component item for a line reading. Prefer the historian-reported
 * product name (most accurate), fall back to line prefix (CL = cream, ML = skim)
 * only when no productName is available at all.
 */
function resolveLineComponent(reading) {
  // Prefer the standardized AVEVA source Product Type code (exact-match) over
  // the legacy free-text productName. Only when it resolves to a real item — a
  // null (None/Water/Blowback/unmapped) falls through so an explicit skip code
  // doesn't silently mis-issue via the free-text path.
  if (reading.productCode != null) {
    const m = lineMapper.resolveSourceProductCode(reading.productCode)
    if (m) return { ...m, resolvedFrom: 'product-code' }
  }
  if (reading.productName) {
    const m = lineMapper.resolveLineProduct(reading.productName)
    if (m) return { ...m, resolvedFrom: 'scada' }
    // productName known but no mapper match — return null so callers skip gracefully
    // rather than issuing against the wrong BOM item.
    return { id: null, name: reading.productName, resolvedFrom: 'unknown' }
  }
  // No productName at all — last-resort line-prefix guess
  const fallback = reading.line.startsWith('CL') ? itemConfig.CREAM_ITEM_CONV : itemConfig.SKIM_ITEM_CONV
  return { ...fallback, resolvedFrom: 'line-prefix' }
}

/**
 * Map any tank reference SCADA might write — "BlendTank2A", "BT2A", "Tank2A",
 * "Blend2A", "2A" — to a canonical short form ("2a"). The line tags use the
 * abbreviated "BT2A" form in `requestedBy` while our MesBlendTankBatch.tankId
 * stores the full "BlendTank2A" form, so we normalize both before comparing.
 *
 * Returns null for inputs that don't look like a blend-tank reference.
 */
function normalizeTankRef(raw) {
  if (!raw || typeof raw !== 'string') return null
  let s = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!s) return null
  s = s.replace(/^blendtank/, '').replace(/^bt/, '').replace(/^blend/, '').replace(/^tank/, '')
  return /^[12][ab]$/.test(s) ? s : null
}

/**
 * Match a line reading to one active batch. Four paths in order:
 *   1. UHT-direct virtual batches (tankId encoded as "{line}→{destination}")
 *   2. Canonical-form match between reading.requestedBy and batch.tankId
 *      (handles the BT2A ↔ BlendTank2A abbreviation)
 *   3. Loose substring match on raw normalized strings (legacy path)
 *   4. Source-silo fallback: when REQUESTEDBY is empty, match the line's
 *      siloName against batch.fromEntName. Covers AVEVA configs that write
 *      FromEntName on the blend tank but don't write REQUESTEDBY on the line.
 *      Restricted to an unambiguous 1-to-1 silo-to-batch mapping to avoid
 *      double-issuing when multiple batches share the same source silo.
 */
function findBatchForLine(reading, activeBatches) {
  for (const batch of activeBatches) {
    if (batch.tankId.startsWith(`${reading.line}→`)) return batch
  }
  if (!reading.requestedBy) {
    // Silo fallback: match by line.siloName ↔ batch.fromEntName
    if (reading.siloName) {
      const siloCanon = itemConfig.normalizeSiloName(reading.siloName)
      if (siloCanon) {
        const matched = activeBatches.filter(b => {
          const batchSilo = itemConfig.normalizeSiloName(b.fromEntName)
          return batchSilo !== null && batchSilo === siloCanon
        })
        if (matched.length === 1) return matched[0]
        if (matched.length > 1) {
          console.warn(`[BlendTankMesService] findBatchForLine ${reading.line}: silo "${reading.siloName}" matches ${matched.length} active batches — skipping to avoid double-issue`)
        }
      }
    }
    return null
  }

  const destCanonical = normalizeTankRef(reading.requestedBy)
  if (destCanonical) {
    for (const batch of activeBatches) {
      if (normalizeTankRef(batch.tankId) === destCanonical) return batch
    }
  }

  const destNorm = reading.requestedBy.toLowerCase().replace(/[^a-z0-9]/g, '')
  for (const batch of activeBatches) {
    const tankNorm = batch.tankId.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (tankNorm === destNorm || tankNorm.includes(destNorm) || destNorm.includes(tankNorm)) return batch
  }
  return null
}

/**
 * One tick. For every active blend tank batch:
 *   1. Read current line totalizers from historian.
 *   2. For each line feeding this batch, fire a workOrderIssue for the delta
 *      since the last tick (or batch start). Update MesPipeIssueState.
 *   3. After issues, fire a workOrderCompletion for any unaccounted-for
 *      cumulative inflow (mass-balance accounting). Many small completions
 *      sum to the batch total — this is intentional, matches SunTado practice.
 *
 * Returns { batchesProcessed, issuesFired, completionsFired, errors }.
 */
/**
 * Measure how much milk REACHED this blend tank and accumulate it into
 * cumulativeOutputLbs — the value that drives workOrderCompletion. Arrival =
 * positive load-cell weight rise, summed across ticks. `cumulativeIssued −
 * cumulativeOutput` is the loss on the leg into this tank. In Phase 1 the issue
 * side is still the line totalizer (≈ pipe flow at the blend inlet), so this
 * gap captures foam/inlet loss; in Phase 2 the issue side becomes the silo
 * level drop, making the gap the true silo→blend transfer loss (the user's
 * "silo 100 → tank 90"). Independent sensors straddle the leg, so it does NOT
 * collapse to zero the way a single-vessel level balance would.
 */
async function tickArrivalForBatch(batch, curWeightLbs) {
  const curLbs = Number.isFinite(curWeightLbs) ? curWeightLbs : NaN
  const prevLbs = batch.lastDestLevelLbs != null ? parseFloat(batch.lastDestLevelLbs) : null
  if (!plausibleLevelLbs(curLbs, prevLbs)) return

  const issued = parseFloat(batch.cumulativeIssuedLbs) || 0
  const output = parseFloat(batch.cumulativeOutputLbs) || 0
  const updates = { lastDestLevelLbs: curLbs }

  if (prevLbs == null) {
    // FIRST arrival observation. Two sub-cases:
    //
    // A) Batch named while tank is part-full (typical late-naming): issued ≈ curLbs.
    //    Credit curLbs so the standing milk doesn't show as phantom waste.
    //
    // B) Batch named after a full fill-and-drain cycle (operator names late, tank
    //    already pumped to UHT before first tick runs): issued >> curLbs.
    //    The pre-naming milk DID arrive — it just passed through before arrival
    //    tracking started. Credit the full issued amount; we cannot measure
    //    blend-leg waste retroactively for pre-naming volume.
    //
    // Combining: credit = max(curLbs, issued) — whichever is larger. Because
    // issued >= 0 and output starts at 0, this simplifies to `issued`.
    const credit = Math.min(issued, Math.max(output, issued))
    if (credit > output) {
      updates.cumulativeOutputLbs = credit
      const why = credit > curLbs ? 'pre-naming fill already drained to UHT' : 'tank level at batch open'
      console.log(`[BlendTankMesService] arrival ${batch.tankId}: initial credit ${credit.toFixed(0)} lb reached (${why}; tank ${curLbs.toFixed(0)} lb, issued ${issued.toFixed(0)})`)
    }
  } else {
    const rise = curLbs - prevLbs
    if (rise > config.MES_WASTE_RISE_FLOOR_LBS) {
      // Clamp so output never exceeds issued: completed ≤ output ≤ issued.
      const next = Math.min(issued, output + rise)
      if (next > output) {
        updates.cumulativeOutputLbs = next
        console.log(`[BlendTankMesService] arrival ${batch.tankId}: +${(next - output).toFixed(1)} lb reached (weight ${prevLbs.toFixed(0)}→${curLbs.toFixed(0)}); output ${output.toFixed(0)}→${next.toFixed(0)} of issued ${issued.toFixed(0)}`)
      }
    }
  }

  // Level-floor correction: when the first tick fired before issued had fully
  // accumulated, the initial credit was capped at the issued-at-that-time and
  // lastDestLevelLbs was set to the current level — leaving cumulativeOutputLbs
  // stuck below the actual tank level even though issued has since grown to cover
  // it. Once issued ≥ curLbs, min(issued, curLbs) = curLbs is provably arrived.
  const levelFloor = Math.min(issued, curLbs)
  const postOutput = parseFloat(updates.cumulativeOutputLbs) || output
  if (levelFloor > postOutput) {
    updates.cumulativeOutputLbs = levelFloor
    console.log(`[BlendTankMesService] arrival ${batch.tankId}: level-floor +${(levelFloor - output).toFixed(1)} lb (issued ${issued.toFixed(0)}, tank ${curLbs.toFixed(0)}, was ${output.toFixed(0)}→${levelFloor.toFixed(0)})`)
  }

  await batch.update(updates)
}

async function tickAllActiveBatches(historian) {
  const activeBatches = await db.MesBlendTankBatch.findAll({ where: { status: 'active' } })
  const summary = { batchesProcessed: 0, issuesFired: 0, completionsFired: 0, errors: [] }
  if (activeBatches.length === 0) return summary

  let lineReadings
  try {
    lineReadings = await historian.getMilkLineStatus()
  } catch (err) {
    console.error('[BlendTankMesService] tick: getMilkLineStatus failed:', err.message)
    summary.errors.push({ phase: 'historian', error: err.message })
    return summary
  }

  // Load-cell weights drive arrival (cumulativeOutputLbs → completion). Read once
  // for all tanks; a failure here is non-fatal (completion just won't advance).
  let blendReadings = []
  try {
    blendReadings = await historian.getBlendTankStatus()
  } catch (err) {
    console.warn('[BlendTankMesService] tick: getBlendTankStatus failed (arrival skipped):', err.message)
  }

  for (const batch of activeBatches) {
    summary.batchesProcessed++
    try {
      const issued = await tickIssuesForBatch(batch, lineReadings)
      summary.issuesFired += issued
    } catch (err) {
      console.error(`[BlendTankMesService] tick issues failed for batch ${batch.id} (${batch.tankId}):`, err.message)
      summary.errors.push({ phase: 'issues', batchId: batch.id, error: err.message })
    }
    try {
      // Reload to pick up cumulativeIssuedLbs increments from the issue phase
      await batch.reload()
      // Measure arrival (load-cell weight rise) → cumulativeOutputLbs before completing.
      const bs = blendReadings.find(s => normalizeTankRef(s.tankId) === normalizeTankRef(batch.tankId))
      if (bs) await tickArrivalForBatch(batch, parseFloat(bs.weightLbs))
      await batch.reload()
      const completed = await tickCompletionForBatch(batch)
      if (completed) summary.completionsFired++
    } catch (err) {
      console.error(`[BlendTankMesService] tick completion failed for batch ${batch.id} (${batch.tankId}):`, err.message)
      summary.errors.push({ phase: 'completion', batchId: batch.id, error: err.message })
    }
  }

  return summary
}

async function tickIssuesForBatch(batch, lineReadings) {
  const matchingLines = lineReadings.filter(r => findBatchForLine(r, [batch]) !== null)

  // Diagnostic: log REQUESTEDBY state for each line so we can tell whether
  // AVEVA is populating it (helps diagnose the silo-fallback path being taken).
  if (batch.nsWorkOrderId) {
    // Only alarm when flow is ADDRESSED TO THIS TANK but didn't match — that's a
    // real routing/normalization bug. Flow on a line bound for another tank
    // (e.g. ML1 requestedBy="BT1B" while this batch is BlendTank2A) is none of
    // this batch's business and previously tripped a false noMatchingLines
    // alarm on every concurrently-active tank. Gate on MES_MIN_ISSUE_LBS too so
    // 1-lb residual sensor noise right after a line.flowComplete reset is ignored.
    const tankCanonical = normalizeTankRef(batch.tankId)
    const flowDestinedHere = lineReadings.filter(r =>
      r.totalizerLbs >= config.MES_MIN_ISSUE_LBS &&
      normalizeTankRef(r.requestedBy) === tankCanonical
    )
    if (flowDestinedHere.length > 0 && matchingLines.length === 0) {
      const lineSnapshot = flowDestinedHere
        .map(r => `${r.line}(tot=${Math.round(r.totalizerLbs)}lb requestedBy="${r.requestedBy}" silo="${r.siloName}")`)
        .join(', ')
      console.warn(`[BlendTankMesService] tick ${batch.tankId} (WO ${batch.nsWorkOrderId}): no matching lines despite flow addressed here — ${lineSnapshot}`)
      statusStore.pushEvent(
        'blendTick.noMatchingLines',
        `${batch.tankId}: no lines matched batch despite flow — ${lineSnapshot}`,
        { tankId: batch.tankId, nsWorkOrderId: batch.nsWorkOrderId, lineSnapshot }
      )
    } else if (matchingLines.length > 0) {
      const viaSilo = matchingLines.filter(r => !r.requestedBy).map(r => r.line)
      if (viaSilo.length > 0) {
        console.log(`[BlendTankMesService] tick ${batch.tankId}: lines matched via silo fallback: ${viaSilo.join(', ')}`)
      }
    }
  }

  const observedAt = new Date(clock.now())
  const candidates = []
  const activeLines = new Set()

  // ── Phase 1: build candidates for current-tick matching lines ─────────
  for (const reading of matchingLines) {
    activeLines.add(reading.line)

    let pipeState = await db.MesPipeIssueState.findOne({
      where: { blendTankBatchId: batch.id, line: reading.line },
    })
    if (!pipeState) {
      pipeState = await db.MesPipeIssueState.create({
        blendTankBatchId: batch.id,
        line: reading.line,
        lastIssuedTotalizerLbs: 0,
        lastTotalizerLbs: reading.totalizerLbs,
        lastObservedAt: observedAt,
      })
    }

    const lastIssued = parseFloat(pipeState.lastIssuedTotalizerLbs) || 0
    let delta
    if (reading.totalizerLbs >= lastIssued) {
      delta = reading.totalizerLbs - lastIssued
    } else if (lastIssued - reading.totalizerLbs > TOTALIZER_RESET_DROP_LBS) {
      // Genuine totalizer reset between ticks (totalizer wraps to 0 at batch
      // end — a drop of thousands). Pre-reset growth is lost; issue only the
      // post-reset value.
      delta = reading.totalizerLbs
      console.warn(`[BlendTankMesService] tick: ${reading.line} totalizer reset between ticks (was ${lastIssued.toFixed(1)}, now ${reading.totalizerLbs.toFixed(1)}) — issuing post-reset value only`)
    } else {
      // Small backward step — sensor jitter, NOT a reset and NOT new milk.
      // Treating any dip as a reset (issuing the full totalizer) re-counts the
      // same fill every tick — the surge-side WO1598 534k bug. Hold the baseline.
      delta = 0
    }

    // Update the always-track-rate fields even when we don't fire an issue, so
    // the frontend has a fresh "current totalizer" snapshot. Also persist the
    // product/silo context so a restart can recover a missed reset.
    const contextUpdate = { lastTotalizerLbs: reading.totalizerLbs, lastObservedAt: observedAt }
    if (reading.productName) contextUpdate.lastProductName = reading.productName
    if (reading.siloName) contextUpdate.lastSiloName = reading.siloName
    await pipeState.update(contextUpdate)

    if (delta < config.MES_MIN_ISSUE_LBS) continue

    const component = resolveLineComponent(reading)
    if (!component.id) {
      console.warn(`[BlendTankMesService] tick: no NS item for "${reading.productName}" on ${reading.line} — skipping`)
      statusStore.pushEvent(
        'blendTick.skipped',
        `${batch.tankId} ${reading.line}: no NS item for "${reading.productName}" — ${delta.toFixed(0)} lb dropped`,
        { tankId: batch.tankId, line: reading.line, reason: 'no-ns-item', productName: reading.productName, delta }
      )
      continue
    }
    const binId = itemConfig.getBinId(reading.siloName)
    if (!binId) {
      console.warn(`[BlendTankMesService] tick: no bin for silo "${reading.siloName}" on ${reading.line} — skipping (delta ${delta.toFixed(1)})`)
      statusStore.pushEvent(
        'blendTick.skipped',
        `${batch.tankId} ${reading.line}: no bin for silo "${reading.siloName}" — ${delta.toFixed(0)} lb dropped`,
        { tankId: batch.tankId, line: reading.line, reason: 'no-bin', siloName: reading.siloName, delta }
      )
      continue
    }

    candidates.push({
      kind: 'current',
      line: reading.line,
      delta,
      pipeState,
      component,
      binId,
      productName: reading.productName,
      newBaseline: reading.totalizerLbs,
      destination: reading.requestedBy || null,
      siloName: reading.siloName || null,
    })
  }

  // ── Phase 2: catch-up candidates for lines that weren't in this tick ──
  // Same gating as before: only run when the batch has an NS WO.
  if (batch.nsWorkOrderId) {
    const allPipeStates = await db.MesPipeIssueState.findAll({ where: { blendTankBatchId: batch.id } })
    for (const ps of allPipeStates) {
      if (activeLines.has(ps.line)) continue
      const stored = parseFloat(ps.lastTotalizerLbs) || 0
      const issued = parseFloat(ps.lastIssuedTotalizerLbs) || 0
      const catchUpDelta = stored - issued
      if (catchUpDelta < config.MES_MIN_ISSUE_LBS) continue
      if (!ps.lastProductName || !ps.lastSiloName) {
        console.warn(`[BlendTankMesService] tick catch-up ${ps.line} → ${batch.tankId}: ${catchUpDelta.toFixed(1)} lb unissued but no stored product/silo — skipping`)
        statusStore.pushEvent(
          'blendTick.skipped',
          `${batch.tankId} ${ps.line} catch-up: ${catchUpDelta.toFixed(0)} lb unissued, no stored product/silo`,
          { tankId: batch.tankId, line: ps.line, reason: 'catchup-no-context', delta: catchUpDelta }
        )
        continue
      }
      const syntheticReading = { line: ps.line, productName: ps.lastProductName, siloName: ps.lastSiloName, totalizerLbs: stored }
      const component = resolveLineComponent(syntheticReading)
      if (!component.id) {
        console.warn(`[BlendTankMesService] tick catch-up ${ps.line}: no NS item for "${ps.lastProductName}" — skipping`)
        statusStore.pushEvent(
          'blendTick.skipped',
          `${batch.tankId} ${ps.line} catch-up: no NS item for "${ps.lastProductName}" — ${catchUpDelta.toFixed(0)} lb dropped`,
          { tankId: batch.tankId, line: ps.line, reason: 'catchup-no-ns-item', productName: ps.lastProductName, delta: catchUpDelta }
        )
        continue
      }
      const binId = itemConfig.getBinId(ps.lastSiloName)
      if (!binId) {
        console.warn(`[BlendTankMesService] tick catch-up ${ps.line}: no bin for "${ps.lastSiloName}" — skipping`)
        statusStore.pushEvent(
          'blendTick.skipped',
          `${batch.tankId} ${ps.line} catch-up: no bin for "${ps.lastSiloName}" — ${catchUpDelta.toFixed(0)} lb dropped`,
          { tankId: batch.tankId, line: ps.line, reason: 'catchup-no-bin', siloName: ps.lastSiloName, delta: catchUpDelta }
        )
        continue
      }
      candidates.push({
        kind: 'catchup',
        line: ps.line,
        delta: catchUpDelta,
        pipeState: ps,
        component,
        binId,
        productName: ps.lastProductName,
        newBaseline: stored,
        destination: null,
        siloName: ps.lastSiloName || null,
      })
    }
  }

  let issuesFired = 0

  // Dry-run: keep per-line baseline advancement (lets developers see state
  // evolve as if NS calls succeeded). No grouping needed since there's no
  // outbound call to consolidate.
  if (config.MES_DRY_RUN) {
    for (const c of candidates) {
      await c.pipeState.update({ lastIssuedTotalizerLbs: c.newBaseline, lastIssueAt: observedAt })
      await batch.increment({ cumulativeIssuedLbs: c.delta })
      await batch.update({ lastIssueAt: observedAt })
      console.log(`[BlendTankMesService] DRY RUN tick issue ${c.line} → ${batch.tankId}: ${c.delta.toFixed(1)} lb${c.kind === 'catchup' ? ' (catch-up)' : ''}`)
    }
    return 0
  }

  if (!batch.nsWorkOrderId) {
    if (candidates.length > 0) {
      console.log(`[BlendTankMesService] tick: batch ${batch.id} has no NS WO — skipping ${candidates.length} candidate(s)`)
    }
    return 0
  }

  // ── Phase 3: group candidates by (source bin, item) ──────────────────
  // Per BATCH_LIFECYCLE_PLAN.md §3 + memory [[bt-wo-issue-grouping]]:
  // emit one workOrderIssue per (source bin, item) tuple. Two lines
  // pulling from the same silo with the same item collapse into one;
  // lines with distinct bins or items each get their own issue.
  const groups = new Map()
  for (const c of candidates) {
    const key = `${c.binId}:${c.component.id}`
    if (!groups.has(key)) {
      groups.set(key, { binId: c.binId, component: c.component, totalDelta: 0, members: [] })
    }
    const g = groups.get(key)
    g.totalDelta += c.delta
    g.members.push(c)
  }

  const bomLines = await fetchWoBomLines(batch.nsWorkOrderId)

  for (const g of groups.values()) {
    const memberLabel = g.members
      .map(m => m.kind === 'catchup' ? `${m.line}(catch-up)` : m.line)
      .join('+')

    let body, allocations, tracking
    try {
      const built = await buildWoIssueBody(batch.nsWorkOrderId, g.component.id, g.totalDelta, g.binId, bomLines)
      body = built.body
      allocations = built.allocations
      tracking = built.tracking
    } catch (err) {
      console.error(`[BlendTankMesService] tick issue ${memberLabel} → WO ${batch.nsWorkOrderId}: buildWoIssueBody failed — ${err.message}`)
      statusStore.pushEvent(
        'blendTick.issueFailed',
        `${batch.tankId} ${memberLabel}: buildWoIssueBody failed (${g.totalDelta.toFixed(0)} lb, item ${g.component.id}) — ${nsErrShort(err)}`,
        {
          tankId: batch.tankId,
          nsWorkOrderId: batch.nsWorkOrderId,
          phase: 'buildWoIssueBody',
          code: err.code || null,
          itemId: g.component.id,
          binId: g.binId,
          totalDelta: g.totalDelta,
          error: err.message.slice(0, 500),
        }
      )
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_tick_issue',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue',
        payload: JSON.stringify({
          batchId: batch.id,
          members: g.members.map(m => ({ line: m.line, kind: m.kind, delta: m.delta })),
          totalDelta: g.totalDelta,
          targetItem: g.component.id,
          preferredBinId: g.binId,
        }),
        success: false,
        errorMessage: err.message,
      })
      continue
    }

    try {
      const allocSummary = allocations
        ? ` via ${allocations.map(a => `lot ${a.lotName}@${a.binName} ${a.qty.toFixed(1)}`).join(' + ')}`
        : ''
      console.log(`[BlendTankMesService] tick issue ${memberLabel} → WO ${batch.nsWorkOrderId} (${batch.tankId}): ${g.totalDelta.toFixed(1)} lb "${g.component.name}" (NS ${g.component.id})${allocSummary}`)
      const issued = await postWoIssueWithWrapperRetry({
        nsWorkOrderId: batch.nsWorkOrderId, targetItemId: g.component.id,
        quantity: g.totalDelta, binId: g.binId, bomLines, body,
      })
      body = issued.body
      const nsResult = issued.nsResult
      const nsIssueId = extractNsIssueId(nsResult)

      for (const m of g.members) {
        await m.pipeState.update({ lastIssuedTotalizerLbs: m.newBaseline, lastIssueAt: observedAt })
        await batch.increment({ cumulativeIssuedLbs: m.delta })
        await db.MesBlendTankInflow.create({
          blendTankBatchId: batch.id,
          line: m.line,
          ingredientType: m.productName || (m.line.startsWith('CL') ? 'cream' : 'skim'),
          totalLbs: m.delta,
          nsItemId: String(g.component.id),
          nsIssueId: nsIssueId ? String(nsIssueId) : null,
          status: 'completed',
          resetTime: observedAt,
          destination: m.destination || null,
          siloName: m.siloName || null,
        })
      }
      await batch.update({ lastIssueAt: observedAt })

      await db.MesProcessingLog.create({
        eventType: 'blend_tank_tick_issue',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue',
        nsTransactionId: nsIssueId,
        payload: JSON.stringify({
          batchId: batch.id,
          members: g.members.map(m => ({ line: m.line, kind: m.kind, delta: m.delta, newBaseline: m.newBaseline })),
          totalDelta: g.totalDelta,
          component: g.component,
          binId: g.binId,
        }),
        result: JSON.stringify({ nsIssueId }),
        success: true,
      })

      issuesFired++
    } catch (err) {
      console.error(`[BlendTankMesService] tick issue failed for ${memberLabel} → WO ${batch.nsWorkOrderId}:`, err.message)
      // Log the exact body NS rejected so a "configure inventory detail in
      // line N" / "must be N" mismatch can be diagnosed without guessing at the
      // shape (mirrors the surge-tick diagnostic). The component entry's
      // lineNumber + inventoryDetail are the usual suspects.
      console.error(`[BlendTankMesService] rejected body: ${JSON.stringify(body)}`)
      console.error(`[BlendTankMesService] failed issue context — item ${g.component.id}, tracking=${JSON.stringify(tracking)}, prefBin=${g.binId}`)
      const allocSummary = (allocations || [])
        .map(a => `lot ${a.lotName}(id=${a.lotId})@bin ${a.binName}(id=${a.binId}) take=${a.qty.toFixed(2)}`)
        .join('; ') || '(no lots)'
      statusStore.pushEvent(
        'blendTick.issueFailed',
        `${batch.tankId} ${memberLabel}: NS workOrderIssue POST failed (${g.totalDelta.toFixed(0)} lb, prefBin=${g.binId}) — ${nsErrShort(err)} [allocs: ${allocSummary}]`,
        {
          tankId: batch.tankId,
          nsWorkOrderId: batch.nsWorkOrderId,
          phase: 'netsuitePost',
          itemId: g.component.id,
          binId: g.binId,
          totalDelta: g.totalDelta,
          allocations: allocations || [],
          requestBody: body,
          tracking: tracking || null,
          error: err.message.slice(0, 500),
        }
      )
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_tick_issue',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderIssue',
        payload: JSON.stringify({
          batchId: batch.id,
          members: g.members.map(m => ({ line: m.line, kind: m.kind, delta: m.delta })),
          totalDelta: g.totalDelta,
          binId: g.binId,
        }),
        success: false,
        errorMessage: err.message,
      })
      // If this is the "no cost basis" failure, post a revaluation so the next
      // tick's retry can succeed (baselines deliberately not advanced below).
      await remediateCostBasisIfNeeded(batch, err)
      // Don't advance any baselines — every member's delta retries on next tick
    }
  }

  return issuesFired
}

async function tickCompletionForBatch(batch) {
  // Completion is driven by measured ARRIVAL (cumulativeOutputLbs), not issued —
  // issued − output is left as implicit NS shrinkage (the waste). See
  // tickArrivalForBatch / [[ns-wo-completion-pattern]].
  if (config.MES_DRY_RUN) {
    const target = (parseFloat(batch.cumulativeOutputLbs) || 0) - (parseFloat(batch.cumulativeCompletedLbs) || 0)
    if (target < config.MES_MIN_COMPLETION_LBS) return false
    await batch.update({ cumulativeCompletedLbs: parseFloat(batch.cumulativeOutputLbs) || 0, lastCompletionAt: new Date(clock.now()) })
    console.log(`[BlendTankMesService] DRY RUN tick completion ${batch.tankId}: ${target.toFixed(1)} lb (arrival-driven)`)
    return true
  }
  if (!batch.nsWorkOrderId) return false

  // Cheap pre-check before taking the lock so idle batches don't serialize.
  if ((parseFloat(batch.cumulativeOutputLbs) || 0) - (parseFloat(batch.cumulativeCompletedLbs) || 0) < config.MES_MIN_COMPLETION_LBS) {
    return false
  }

  // Serialize all completions for this WO. Concurrent callers (tick / backfill /
  // end-flush) would otherwise race to create the same lot and one would die
  // with "This record already exists" — see [[ns-wo-completion-pattern]].
  return withCompletionLock(batch.nsWorkOrderId, async () => {
    // Reload to pick up a completion a concurrent caller already committed
    // while we waited for the lock.
    await batch.reload()
    const cumulativeIssued = parseFloat(batch.cumulativeIssuedLbs) || 0
    const cumulativeOutput = parseFloat(batch.cumulativeOutputLbs) || 0
    const cumulativeCompleted = parseFloat(batch.cumulativeCompletedLbs) || 0
    const target = cumulativeOutput - cumulativeCompleted

    if (target < config.MES_MIN_COMPLETION_LBS) {
      console.log(`[BlendTankMesService] completion ${batch.tankId}: already satisfied (reached ${cumulativeOutput.toFixed(1)}, completed ${cumulativeCompleted.toFixed(1)}, issued ${cumulativeIssued.toFixed(1)}) — skipping`)
      return false
    }

    // Same destination-bin logic as processWOEnd: UHT-direct WOs land in a surge
    // tank (toEntName = ST81-84); blend tanks land in the tank itself.
    const completionDest = (batch.toEntName && /^ST\d+$/.test(batch.toEntName))
      ? batch.toEntName
      : batch.tankId
    const completionBinId = itemConfig.getBinId(completionDest)

    const now = new Date(clock.now())
    const mm = String(now.getMonth() + 1).padStart(2, '0')
    const dd = String(now.getDate()).padStart(2, '0')
    const yy = String(now.getFullYear()).slice(-2)
    const woNum = String(batch.nsWorkOrderNumber || '').replace(/\D/g, '')
    const lotNumber = `${mm}${dd}${yy}${woNum}`
    const roundedTarget = Math.round(target * 1000) / 1000
    const assignmentEntry = { quantity: roundedTarget, receiptInventoryNumber: lotNumber }
    if (completionBinId) assignmentEntry.binnumber = String(completionBinId)

    const body = {
      quantity: roundedTarget,
      inventorydetail: {
        inventoryassignment: {
          items: [assignmentEntry],
        },
      },
    }

    console.log(`[BlendTankMesService] tick completion inventory: 1 lot (${target.toFixed(1)} lb) → bin ${completionBinId || 'none'}`)

    try {
      console.log(`[BlendTankMesService] tick completion WO ${batch.nsWorkOrderId} (${batch.tankId}): ${target.toFixed(1)} lb (completed ${cumulativeCompleted.toFixed(1)} → ${cumulativeOutput.toFixed(1)} reached, issued ${cumulativeIssued.toFixed(1)})`)
      const nsResult = await core.netsuitePost(
        `/record/v1/workOrder/${batch.nsWorkOrderId}/!transform/workOrderCompletion`,
        body
      )

      let nsCompletionId = nsResult?.id || null
      if (!nsCompletionId && nsResult?.headers?.location) {
        const m = nsResult.headers.location.match(/\/(\d+)$/)
        if (m) nsCompletionId = m[1]
      }

      await batch.update({
        cumulativeCompletedLbs: cumulativeOutput,
        lastCompletionAt: new Date(clock.now()),
      })

      await db.MesProcessingLog.create({
        eventType: 'blend_tank_tick_completion',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderCompletion',
        nsTransactionId: nsCompletionId,
        payload: JSON.stringify({ batchId: batch.id, target, cumulativeIssued, cumulativeOutput, cumulativeCompleted }),
        result: JSON.stringify({ nsCompletionId, lotNumber }),
        success: true,
      })
      return true
    } catch (err) {
      // "This record already exists" = a completion for this WO+day already
      // landed (a prior attempt whose response we lost, or a race that slipped
      // past the lock across a process restart). Reconcile against NS's real
      // built quantity instead of alarming or re-firing into a double build.
      if (isAlreadyExistsError(err)) {
        const built = await fetchWoBuiltQuantity(batch.nsWorkOrderId).catch(e => {
          console.warn(`[BlendTankMesService] builtQuantity lookup failed for WO ${batch.nsWorkOrderId}: ${e.message}`)
          return null
        })
        console.warn(`[BlendTankMesService] completion lot "${lotNumber}" already exists on WO ${batch.nsWorkOrderId} (NS built=${built ?? '?'}, reached=${cumulativeOutput.toFixed(1)}) — reconciling, not re-firing`)
        // If NS shows it built at least what's reached the tank (within a lb),
        // the FG is already there: mark complete so we stop retrying. If NS is
        // behind (or unreadable), advance only to the known-built amount and let
        // a later tick complete the genuine remainder. Clamp to reached output,
        // never issued — issued − output is the waste, not extra FG to build.
        const reconciledCompleted = built != null
          ? Math.max(cumulativeCompleted, Math.min(built, cumulativeOutput))
          : cumulativeOutput
        await batch.update({ cumulativeCompletedLbs: reconciledCompleted, lastCompletionAt: new Date(clock.now()) })
        await db.MesProcessingLog.create({
          eventType: 'blend_tank_tick_completion',
          sourceId: batch.nsWorkOrderId,
          nsTransactionType: 'workOrderCompletion',
          payload: JSON.stringify({ batchId: batch.id, target, cumulativeIssued, cumulativeOutput, cumulativeCompleted }),
          result: JSON.stringify({ reconciled: true, nsBuiltQuantity: built, reconciledCompleted }),
          success: true,
        })
        statusStore.pushEvent(
          'blendTick.completionReconciled',
          `${batch.tankId}: completion already present in NS (built ${built != null ? built.toFixed(0) : '?'} lb of ${cumulativeOutput.toFixed(0)} reached) — reconciled, no double build`,
          { tankId: batch.tankId, nsWorkOrderId: batch.nsWorkOrderId, nsBuiltQuantity: built, cumulativeIssued, cumulativeOutput, reconciledCompleted }
        )
        return cumulativeOutput - reconciledCompleted < config.MES_MIN_COMPLETION_LBS
      }

      console.error(`[BlendTankMesService] tick completion failed for WO ${batch.nsWorkOrderId}:`, err.message)
      statusStore.pushEvent(
        'blendTick.completionFailed',
        `${batch.tankId}: NS workOrderCompletion POST failed (${target.toFixed(0)} lb) — ${nsErrShort(err)}`,
        {
          tankId: batch.tankId,
          nsWorkOrderId: batch.nsWorkOrderId,
          target,
          cumulativeIssued,
          cumulativeCompleted,
          error: err.message.slice(0, 500),
        }
      )
      await db.MesProcessingLog.create({
        eventType: 'blend_tank_tick_completion',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderCompletion',
        payload: JSON.stringify({ batchId: batch.id, target, cumulativeIssued, cumulativeCompleted }),
        success: false,
        errorMessage: err.message,
      })
      return false
    }
  })
}

const RETRYABLE_BLEND_STATUSES = ['pending_ns', 'error']

async function getAllBatches({ status, limit = 200 } = {}) {
  const where = {}
  if (status) {
    const statuses = String(status).split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length === 1) where.status = statuses[0]
    else if (statuses.length > 1) where.status = { [db.Sequelize.Op.in]: statuses }
  }
  const batches = await db.MesBlendTankBatch.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit: Math.min(Number(limit) || 200, 500),
  })
  return { success: true, batches }
}

async function retryBlendBatch(id, { nsItemId, decidedBy } = {}) {
  const batch = await db.MesBlendTankBatch.findByPk(id)
  if (!batch) throw new Error(`Batch ${id} not found`)
  if (!RETRYABLE_BLEND_STATUSES.includes(batch.status)) {
    throw new Error(`Batch ${id} has status '${batch.status}' — only ${RETRYABLE_BLEND_STATUSES.join('/')} are retryable`)
  }

  if (nsItemId) await batch.update({ mesItem: String(nsItemId) })
  await batch.reload()

  const itemId = batch.mesItem
  if (!itemId) throw new Error(`No NS item set for batch ${id} — provide nsItemId`)

  if (config.MES_DRY_RUN) {
    await batch.update({ status: 'active', errorMessage: null })
    await batch.reload()
    return { success: true, batch }
  }

  const body = {
    assemblyItem: { id: Number(itemId) },
    quantity: batch.batchSize || 1,
    location: { id: 30 },
    subsidiary: { id: 3 },
    isWip: true,
    custbody_mes_tank_id: batch.tankId,
    custbody_mes_product_name: batch.productName,
    custbody_mes_source_entity: batch.fromEntName || null,
    custbody_mes_dest_entity: batch.toEntName || null,
  }

  try {
    let nsResult
    try {
      nsResult = await core.netsuitePost('/record/v1/workOrder', body)
    } catch (woCreateErr) {
      if (woCreateErr.message?.includes('at least one line item')) {
        console.warn(`[BlendTankMesService] retry: item ${itemId} has no BOM — seeding component`)
        body.item = { items: [{ item: { id: Number(itemId) }, quantity: 0 }] }
        nsResult = await core.netsuitePost('/record/v1/workOrder', body)
      } else {
        throw woCreateErr
      }
    }

    let nsWorkOrderId = nsResult?.id || null
    let nsWorkOrderNumber = nsResult?.tranid || null
    if (!nsWorkOrderId && nsResult?.headers?.location) {
      const match = nsResult.headers.location.match(/\/(\d+)$/)
      if (match) {
        nsWorkOrderId = match[1]
        try {
          const woDetail = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?fields=tranId`)
          const woBody = woDetail?.body || woDetail
          nsWorkOrderNumber = woBody?.tranId || woBody?.tranid || null
        } catch (e) {
          console.warn(`[BlendTankMesService] retry: could not fetch WO details: ${e.message}`)
        }
      }
    }

    await batch.update({ nsWorkOrderId, nsWorkOrderNumber, status: 'active', errorMessage: null })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_wo_retry', sourceId: `${batch.tankId}:${batch.productName}`,
      nsTransactionType: 'workOrder', nsTransactionId: nsWorkOrderId,
      payload: JSON.stringify({ batchId: id, nsItemId, decidedBy }),
      result: JSON.stringify({ nsWorkOrderId, nsWorkOrderNumber }), success: true,
    })
    console.log(`[BlendTankMesService] retry: "${batch.productName}" on ${batch.tankId} → NS WO ${nsWorkOrderNumber} (${nsWorkOrderId})`)
    await batch.reload()
    return { success: true, batch }
  } catch (err) {
    console.error(`[BlendTankMesService] retry: failed for batch ${id}:`, err.message)
    await batch.update({ status: 'error', errorMessage: err.message })
    await db.MesProcessingLog.create({
      eventType: 'blend_tank_wo_retry', sourceId: `${batch.tankId}:${batch.productName}`,
      nsTransactionType: 'workOrder',
      payload: JSON.stringify({ batchId: id, nsItemId, decidedBy }),
      success: false, errorMessage: err.message,
    })
    await batch.reload()
    return { success: false, batch, error: err.message }
  }
}

async function rejectBlendBatch(id, { decidedBy, reason } = {}) {
  const batch = await db.MesBlendTankBatch.findByPk(id)
  if (!batch) throw new Error(`Batch ${id} not found`)
  if (!RETRYABLE_BLEND_STATUSES.includes(batch.status)) {
    throw new Error(`Batch ${id} has status '${batch.status}' — only ${RETRYABLE_BLEND_STATUSES.join('/')} can be rejected`)
  }
  const msg = [decidedBy ? `Rejected by ${decidedBy}` : 'Rejected', reason].filter(Boolean).join(': ')
  await batch.update({ status: 'rejected', errorMessage: msg })
  await batch.reload()
  return { success: true, batch }
}

function getBlendProductOptions() {
  const byNsId = new Map()
  for (const [name, nsId] of Object.entries(productParser.RAW_FG_ITEM_MAP)) {
    if (!byNsId.has(nsId)) byNsId.set(nsId, name)
  }
  for (const p of productParser.PRODUCT_CATALOG) {
    if (!byNsId.has(p.nsId)) byNsId.set(p.nsId, p.name)
  }
  return {
    success: true,
    options: Array.from(byNsId.entries())
      .map(([nsId, name]) => ({ nsId, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }
}

async function clearStaleBatches() {
  const stale = await db.MesBlendTankBatch.findAll({
    where: { status: ['active', 'dry_run'], nsWorkOrderId: null },
  })

  for (const batch of stale) {
    console.log(`[BlendTankMesService] Cancelling stale batch: ${batch.tankId} / "${batch.productName}" (id=${batch.id})`)
    await batch.update({ status: 'cancelled', completedAt: new Date(clock.now()) })
  }

  console.log(`[BlendTankMesService] Cleared ${stale.length} stale batch(es)`)
  return { success: true, cleared: stale.length }
}

function clearCaches() {
  _bomCache.clear()
}

module.exports = {
  processWOStart,
  processWOEnd,
  processLineFlow,
  getActiveBatches,
  getAllBatches,
  getBatchComponents,
  issueIngredient,
  tickAllActiveBatches,
  clearStaleBatches,
  retryBlendBatch,
  rejectBlendBatch,
  getBlendProductOptions,
  normalizeTankRef,
  findMatchableUnmatchedInflows,
  clearCaches,
}
