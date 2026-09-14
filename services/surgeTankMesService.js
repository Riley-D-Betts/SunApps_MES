const core = require('../clients/coreClient')
const itemConfig = require('./mesItemConfig')
const productParser = require('./surgeTankProductParser')
const blendProductParser = require('./blendTankProductParser')
const lineMapper = require('./lineIngredientMapper')
const nsInventory = require('./nsInventoryLookup')
const inventoryAdjustment = require('./inventoryAdjustmentService')
const batchStartFinder = require('./batchStartFinder')
const statusStore = require('./statusStore')
const config = require('../config')
const db = require('../models')
const clock = require('../sim/clock')
const notifyService = require('./notifyService')

function nsErrShort(err) {
  const msg = String(err?.message || '')
  const m = msg.match(/"detail":"([^"]+)"/)
  return m ? m[1] : msg.slice(0, 200)
}

// NS rejects a workOrderCompletion with this when its receiptInventoryNumber
// lot is being created twice at once — two completion transforms raced. The
// deterministic MMDDYY+WO lot is a natural idempotency key, so this means
// "another completion for this WO already landed", not a real failure.
function isAlreadyExistsError(err) {
  return /this record already exists/i.test(String(err?.message || ''))
}

// Read NS's actual built quantity on a WO to reconcile local accounting and
// guard against double-building after a lost response or a race.
async function fetchWoBuiltQuantity(nsWorkOrderId) {
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?fields=builtQuantity`)
  const wo = wrap?.body || wrap
  const built = parseFloat(wo?.builtQuantity)
  return Number.isFinite(built) ? built : null
}

// Per-WO in-process completion lock — the tick and the end-of-batch flush both
// call tickCompletionForBatch on the same active batch and can overlap.
// Serializing prevents the same-lot race that dies with "This record already
// exists" (mirrors the blend-tank fix).
const _completionLocks = new Map()
function withCompletionLock(woId, fn) {
  const key = String(woId)
  const prev = _completionLocks.get(key) || Promise.resolve()
  const next = prev.then(fn, fn)
  _completionLocks.set(key, next.then(() => {}, () => {}))
  return next
}

// UHT software totalizer is gallons; NS workOrder lines run in lbs. Use a
// single density constant — UHT throughput is mixed during product changes,
// and the FG mass-balance accounting doesn't need per-product precision.
// Lives in mesItemConfig (SD-729) so the loss report converts with it too.
const GAL_TO_LBS = itemConfig.LBS_PER_GAL

// A genuine UHT totalizer reset (IDLE/CIP→PROCESS wipes the in-memory
// _uhtMilkGal accumulator to 0) drops the reading by thousands of gallons.
// Anything smaller than this is sub-gal float jitter or a concurrent-poll race
// on the shared accumulator — NOT a reset and NOT new milk. Treating every
// backward step as a reset (issuing the full currentGal) re-counted one ~55k-lb
// fill into 534k lb on WO1598 (a 0.03-gal blip, 7966.10 vs 7966.13, re-issued
// ~68k lb per tick). See [[uht-milk-totalizer-gating]].
const TOTALIZER_RESET_DROP_GAL = 50

// Max backfill window for pre-seeding the issue-state baseline. If the
// estimated actual start is more than this before detection, the level signal
// likely found an old fill rather than the current batch — skip seeding.
const BACKFILL_MAX_GAP_MS = 30 * 60 * 1000

// A level reading (lbs) is implausible when it reads ~empty but we just saw a
// substantial level. That's the replay-overrun signature (future timestamps
// return 0/null) — treating it as a real drain would zero out arrival and make
// waste collapse to zero. Defer those ticks rather than trust the read.
function plausibleLevelLbs(curLbs, prevLbs) {
  if (!Number.isFinite(curLbs) || curLbs < 0) return false
  if (curLbs < 1 && prevLbs != null && prevLbs > config.MES_WASTE_RESIDUAL_FLOOR_LBS) return false
  return true
}

// Per-process BOM cache, keyed by nsWorkOrderId. Mirrors blendTankMesService.
const _bomCache = new Map()

async function fetchWoBomLines(nsWorkOrderId) {
  if (_bomCache.has(nsWorkOrderId)) return _bomCache.get(nsWorkOrderId)
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const lines = (wo?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id) }))
  console.log(`[SurgeTankMesService] BOM for WO ${nsWorkOrderId}: ${lines.map(l => `line${l.line}=item${l.itemId}`).join(', ') || '(empty)'}`)
  _bomCache.set(nsWorkOrderId, lines)
  return lines
}

function clearBomCache(nsWorkOrderId) {
  _bomCache.delete(nsWorkOrderId)
}

// Mirror of blendTankMesService.ensureItemOnWoBom — see that file for the
// detailed rationale. PATCHes the WO to append targetItemId at qty=0 when
// missing from the BOM, refetches for the line number, and mutates bomLines
// + cache in place.
async function ensureItemOnWoBom(nsWorkOrderId, targetItemId, bomLines) {
  const targetIdStr = String(targetItemId)
  const existing = bomLines.find(c => String(c.itemId) === targetIdStr)
  if (existing) return existing

  console.log(`[SurgeTankMesService] Item ${targetIdStr} not on WO ${nsWorkOrderId} BOM (lines: ${bomLines.map(b => b.itemId).join(', ') || '(empty)'}) — PATCHing to append`)
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
  console.log(`[SurgeTankMesService] Item ${targetIdStr} added to WO ${nsWorkOrderId} at line ${newRow.line}`)

  _bomCache.set(nsWorkOrderId, newLines)
  bomLines.length = 0
  bomLines.push(...newLines)
  return newRow
}

// Mirror of blendTankMesService.buildWoIssueBody — see that file for the
// detailed rationale. Lowercase componentinventorydetail + omit non-target
// lines + raw string IDs. Looks up tracking class (lot / bin / both) and
// allocations from NS via nsInventoryLookup.
async function buildWoIssueBody(nsWorkOrderId, targetItemId, quantity, preferredBinId, bomLines, opts = {}) {
  const tracking = await nsInventory.getItemTracking(targetItemId)
  const targetLine = await ensureItemOnWoBom(nsWorkOrderId, targetItemId, bomLines)

  // Floor request to 2-decimal lbs precision so JS float serialization
  // can't drift the assignment qty above NS's stored available. See the
  // matching block in blendTankMesService.buildWoIssueBody for details.
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
        // Poll with backoff — NS inventorybalance lags the adjustment POST.
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
    // Bin-tracked component (raw silo milk like NS 5403 Raw Organic A2 Milk).
    // Mirror the blend-tank path: if the preferred bin can't cover the issue,
    // auto-adjust the source bin up by the real shortfall before issuing —
    // otherwise NS rejects with "you only have N available." Surge was missing
    // this branch entirely, so bin-tracked components never got the auto-adjust
    // and every short issue failed at the NS POST (ST81 WO4812137).
    resolvedBinId = await nsInventory.findBinForItem(targetItemId, preferredBinId, quantity)
    if (!resolvedBinId) {
      // Current on-hand can be NEGATIVE after prior over-draws, so the real
      // shortfall is quantity - currentOnHand, not just quantity.
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

  // woHasLotLines selects the bin-only line's inventory-detail wrapper:
  // true → lowercase componentinventorydetail, false → camelCase inventoryDetail.
  // The correct case differs by NS ACCOUNT, so the DEFAULT is keyed off
  // ENVIRONMENT (SD-597, ported to surge for SD-708): production wants the
  // camelCase wrapper on a bin-only line REGARDLESS of the WO's lot mix.
  // The old lot-mix auto-detect assumed "surge WOs are pure bin-only" — false
  // for UHT-direct-from-silo WOs, whose NS-defaulted multi-line BOM carries
  // lot-tracked lines (WO2060/WO2062: 246 consecutive prod rejections,
  // "total inventory detail quantity must be N", ~219k lb never booked).
  // Sandbox/dev keeps the auto-detect. opts.forceWoHasLotLines overrides —
  // used by the wrapper-mismatch retry, so a wrong default still self-heals.
  const woHasLotLines = opts.forceWoHasLotLines != null
    ? opts.forceWoHasLotLines
    : config.ENVIRONMENT === 'prod'
      ? false
      : await nsInventory.anyLotTracked(bomLines)
  const { quantity: issueQty, detail } = nsInventory.buildComponentDetail(tracking, quantity, allocations, resolvedBinId, woHasLotLines)

  // issueQty == quantity for bin-only lines; for lot lines it's the sum of the
  // floored per-lot qtys (≤ quantity) so the line matches the assignment total.
  const componentEntry = { lineNumber: targetLine.line, quantity: issueQty }
  if (detail) Object.assign(componentEntry, detail)

  return {
    body: { custbody_liquid_milk_wo: true, component: { items: [componentEntry] } },
    allocations,
    tracking,
    resolvedBinId,
    woHasLotLines,
  }
}

// Backoff-poll the allocations after an auto-adjust — NS inventorybalance
// view lags the inventoryAdjustment POST by a few seconds. See
// blendTankMesService.pollAllocations for the rationale.
const SHORTFALL_POLL_DELAYS_MS = [1000, 2000, 3000]
// Overshoot auto-adjusts so post-adjust available STRICTLY exceeds the request
// (NS stores available at higher precision than our 2dp request). The extra few
// lb are reconciled by the at-rest sweep. See [[assemblyunbuild_must_be_n]].
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

// Bin-path equivalent of pollAllocations — re-check the preferred bin after an
// auto-adjust until it can cover the issue (NS inventorybalance lags the POST).
async function pollBinForItem(targetItemId, preferredBinId, neededQty = 0) {
  for (const delay of SHORTFALL_POLL_DELAYS_MS) {
    await new Promise(r => setTimeout(r, delay))
    const bin = await nsInventory.findBinForItem(targetItemId, preferredBinId, neededQty)
    if (bin) return bin
  }
  return null
}

// Source-bin auto-adjust hook for the surge-WO issue path. Mirror of
// blendTankMesService.tryShortfallAutoAdjust — see that file for rationale.
async function tryShortfallAutoAdjust({ nsWorkOrderId, targetItemId, preferredBinId, shortfall }) {
  if (!preferredBinId || !(shortfall > 0)) return false
  let lastWoNumber = null
  let tankName = null
  try {
    const batch = await db.MesSurgeTankBatch.findOne({
      where: { nsWorkOrderId: String(nsWorkOrderId) },
      attributes: ['tankId', 'nsWorkOrderNumber'],
    })
    lastWoNumber = batch?.nsWorkOrderNumber || null
    tankName = batch?.tankId || null
  } catch (err) {
    console.warn(`[SurgeTankMesService] tryShortfallAutoAdjust DB lookup failed: ${err.message}`)
  }
  const result = await inventoryAdjustment.applyShortfallAdjustment({
    sourceBinId: preferredBinId,
    itemId: targetItemId,
    shortfallQty: shortfall,
    lastWoNumber,
    tankName,
    triggerKind: 'wo', nsWorkOrderId: String(nsWorkOrderId), batchKind: 'surge',
    memo: `Auto-adjust: surge WO ${nsWorkOrderId} issue shortfall (+${shortfall.toFixed(2)} lb)`,
  })
  return !!result?.ok
}

// NS rejects a lot-tracked issue with "The following Inventory numbers are not
// available: [Item:…, Number:<lot>, Quantity:N, On Hand:-N, …]" when the lot the
// body pinned went negative BETWEEN allocation and POST — the surge totalizer
// consuming raw-FG faster than the blend tank completes it into that lot. See Bug B.
function isInventoryUnavailable(err) {
  return /Inventory numbers are not available/i.test(err?.message || '')
}

// Mirror of blendTankMesService.isWrapperMismatch (SD-597). NS silently ignores
// a bin-only line's inventory-detail wrapper when it's the wrong CASE for that
// NS account, then rejects with one of two signatures — both meaning "your
// detail was dropped": "configure the inventory detail in line N" or
// "total inventory detail quantity must be N" (the exact WO2060/WO2062 error).
function isWrapperMismatch(err) {
  const m = err?.message || ''
  return /configure the inventory detail in line/i.test(m)
    || /total inventory detail quantity must be/i.test(m)
}

// Pull each unavailable lot's (name, requested qty, current on-hand) out of the
// NS error. The error conveniently carries the exact lot name we must top up
// plus the on-hand to compute by how much.
function parseUnavailableLots(err) {
  const msg = err?.message || ''
  const re = /Number:\s*([^,\]]+?)\s*,\s*Quantity:\s*(-?[\d.]+)\s*,\s*On Hand:\s*(-?[\d.]+)/gi
  const out = []
  let m
  while ((m = re.exec(msg)) !== null) {
    out.push({ lotName: m[1].trim(), needed: parseFloat(m[2]), onHand: parseFloat(m[3]) })
  }
  return out
}

// POST a surge workOrderIssue, retrying ONCE on the inventory-unavailable
// signature above. The retry TOPS UP the exact pinned lot(s) — adjusting each up
// by (needed − onHand) so on-hand reaches the issue qty — then re-posts the SAME
// body. We fabricate onto the real lot the issue references (not a phantom new
// lot): if blend later completes that lot, the at-rest sweep reconciles the
// overshoot. See Bug B + [[downstream_waste_tracking]]. Returns { nsResult, body }.
async function postSurgeIssueWithShortfallRetry({ nsWorkOrderId, targetItemId, binId, body, tankName, quantity, bomLines, woHasLotLines, tracking }) {
  try {
    const nsResult = await core.netsuitePost(`/record/v1/workOrder/${nsWorkOrderId}/!transform/workOrderIssue`, body)
    return { nsResult, body }
  } catch (err) {
    // Wrapper-mismatch on a bin-only line: flip the wrapper case and retry ONCE
    // (SD-597 pattern, ported for SD-708 — the WO2060/WO2062 failure mode).
    // The flip only changes bin-only lines; lot lines always use the lowercase
    // shape, so no retry for those. Signatures are disjoint from the
    // inventory-unavailable branch below.
    if (isWrapperMismatch(err) && tracking && tracking.useBins && !tracking.isLot
        && bomLines && quantity != null) {
      const flipped = !woHasLotLines
      console.warn(`[SurgeTankMesService] WO ${nsWorkOrderId} item ${targetItemId} rejected with wrapper-mismatch ("${(err.message || '').replace(/\s+/g, ' ').slice(0, 90)}…") — retrying with ${flipped ? 'lowercase componentinventorydetail' : 'camelCase inventoryDetail'} wrapper`)
      const rebuilt = await buildWoIssueBody(nsWorkOrderId, targetItemId, quantity, binId, bomLines, { forceWoHasLotLines: flipped })
      const nsResult = await core.netsuitePost(`/record/v1/workOrder/${nsWorkOrderId}/!transform/workOrderIssue`, rebuilt.body)
      return { nsResult, body: rebuilt.body }
    }
    if (!isInventoryUnavailable(err)) throw err
    const shorts = parseUnavailableLots(err)
    if (!binId || shorts.length === 0) throw err

    let adjusted = 0
    let totalNeeded = 0
    for (const s of shorts) {
      totalNeeded += s.needed || 0
      const upBy = s.needed - s.onHand + SHORTFALL_BUFFER_LBS // onHand negative ⇒ upBy > needed; +buffer so available strictly exceeds the issue
      if (!(upBy > 0)) continue
      const res = await inventoryAdjustment.applyTargetedLotUpAdjustment({
        binId,
        itemId: targetItemId,
        lotName: s.lotName,
        upBy,
        tankName,
        triggerKind: 'wo', nsWorkOrderId: String(nsWorkOrderId), batchKind: 'surge',
        memo: `Auto-adjust: surge WO ${nsWorkOrderId} top up lot ${s.lotName} to cover issue (on-hand ${s.onHand} → +${upBy.toFixed(2)} lb)`,
      })
      if (res?.ok) {
        adjusted++
        console.warn(`[SurgeTankMesService] WO ${nsWorkOrderId} topped up lot ${s.lotName} by ${upBy.toFixed(2)} lb (was ${s.onHand} on-hand)`)
      } else {
        console.warn(`[SurgeTankMesService] WO ${nsWorkOrderId} top-up of lot ${s.lotName} failed: ${res?.error || res?.skipped}`)
      }
    }
    if (!adjusted) throw err

    // NS inventorybalance lags the adjustment POST — wait (with backoff) until the
    // bin can cover the issue before re-posting the same body.
    for (const delay of SHORTFALL_POLL_DELAYS_MS) {
      await new Promise(r => setTimeout(r, delay))
      const onHand = await inventoryAdjustment.getBinQtyOnHand(targetItemId, binId)
      if (onHand + 1e-6 >= totalNeeded) break
    }
    console.warn(`[SurgeTankMesService] WO ${nsWorkOrderId} retrying issue after topping up ${adjusted} lot(s)`)
    const nsResult = await core.netsuitePost(`/record/v1/workOrder/${nsWorkOrderId}/!transform/workOrderIssue`, body)
    return { nsResult, body }
  }
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

function isBlendTankRef(name) {
  return typeof name === 'string' && /^blendtank[12][ab]$/i.test(name.replace(/\s+/g, ''))
}

function isSiloRef(name) {
  if (!name) return false
  if (/^[MC]Silo\d+$/i.test(name)) return true
  return !!itemConfig.normalizeSiloName(name)
}

/**
 * Decide the single component item that the surge tank's Layer-3 WO should
 * consume, based on what's physically feeding the UHT at WO-create time, and
 * tag the (FG, component) pairing as approved or pending review by looking it
 * up in MesFgInputPairings.
 *
 * The result is pinned to MesSurgeTankBatch (componentItemId/Bin/From,
 * layerSkipReason, pairingStatus) and the component is also sent as a custom
 * one-line list on the workOrder create body — every subsequent tick issue
 * runs against this same item. Returns null if the source can't be resolved
 * yet (caller defers).
 *
 *   fgItem    — Layer-3 assembly we're about to build (FG, e.g. 4498 Kirkland 2%)
 *   data      — { feedingFromEntName, feedingUhtId } from the surge-tank job
 *   historian — provider for getMilkLineStatus()
 *
 * Pairing semantics: any (fgItemId, componentItemId) combo not present in
 * MesFgInputPairings is auto-inserted as status='pending' and the batch is
 * flagged pending_review. WO + ticks still fire — physical milk flow happened.
 * Ops reviews pending rows via the /api/mes/fg-pairings UI and either approves
 * or leaves them pending forever (no blocklist).
 */
async function resolveLayer3Component(data, historian, fgItem) {
  const resolved = await _resolveLayer3Source(data, historian)
  if (!resolved) return null

  const fgItemId = fgItem?.id ? Number(fgItem.id) : null
  if (!fgItemId) return { ...resolved, pairingStatus: null }

  const rawInputItemId = Number(resolved.itemId)
  const pair = await db.MesFgInputPairing.findOne({
    where: { fgItemId, rawInputItemId },
  })

  let pairingStatus
  if (pair?.status === 'approved') {
    pairingStatus = 'ok'
  } else if (pair?.status === 'rejected') {
    // Operator marked this (FG ⇐ raw) combo bad. Signal the caller to HOLD the
    // surge WO instead of auto-posting — the combo stays blocked until someone
    // approves it (or fixes it to the correct raw input). See fgPairingService.
    pairingStatus = 'blocked'
    console.warn(`[SurgeTankMesService] Pairing BLOCKED (rejected): FG ${fgItemId} ← raw ${rawInputItemId} (id=${pair.id}) — surge WO will be held`)
  } else {
    pairingStatus = 'pending_review'
    if (!pair) {
      try {
        await db.MesFgInputPairing.create({
          fgItemId,
          rawInputItemId,
          status: 'pending',
          fgName: fgItem.name || null,
          rawInputName: resolved.itemName || null,
          createdBy: 'auto',
        })
        console.log(`[SurgeTankMesService] New pairing flagged for review: FG ${fgItemId} (${fgItem.name}) ← raw ${rawInputItemId} (${resolved.itemName})`)
      } catch (err) {
        // Race: a concurrent batch inserted the same pairing first — fine.
        if (err.name !== 'SequelizeUniqueConstraintError') {
          console.warn(`[SurgeTankMesService] Failed to log pending pairing: ${err.message}`)
        }
      }
    } else {
      console.log(`[SurgeTankMesService] Pairing still pending review: FG ${fgItemId} ← raw ${rawInputItemId} (id=${pair.id})`)
    }
  }
  return { ...resolved, pairingStatus }
}

// Inner: resolve which NS item feeds the surge WO, agnostic of pairing status.
// Returns { itemId, itemName, binId, resolvedFrom, layerSkipReason } or null.
async function _resolveLayer3Source(data, historian) {
  const feedingFromEntName = data.feedingFromEntName
  const feedingUhtId = data.feedingUhtId
  if (!feedingFromEntName) {
    // Silo→TSTAT→UHT bypass (A2 Whole): the job has no blend-tank/silo source
    // because no blend valve is open. Resolve straight from the line feeding
    // this UHT's TSTAT and carry sourceSilo so the batch can display the real
    // silo instead of "?".
    const fromLine = await resolveComponentFromUhtFeedLine(feedingUhtId, historian)
    return fromLine ? { ...fromLine, layerSkipReason: 'layer-1-and-2-skip' } : null
  }

  if (isBlendTankRef(feedingFromEntName)) {
    let blendBatch = await db.MesBlendTankBatch.findOne({
      where: { tankId: feedingFromEntName, status: 'active' },
      order: [['detectedAt', 'DESC']],
    })
    if (!blendBatch?.mesItem) {
      // Blend tank may have finished before the surge batch resolved. Fall back
      // to the most recent batch on that tank within 48 h that actually completed
      // some product (cumulativeCompletedLbs > 0). Phantom batches (9-second
      // NOTE_STRING transients with 0 lbs) are explicitly excluded — they have
      // no NS inventory and would cause every surge tick to fail with
      // "Insufficient inventory".
      blendBatch = await db.MesBlendTankBatch.findOne({
        where: {
          tankId: feedingFromEntName,
          status: 'completed',
          mesItem: { [db.Sequelize.Op.ne]: null },
          cumulativeCompletedLbs: { [db.Sequelize.Op.gt]: 0 },
          detectedAt: { [db.Sequelize.Op.gte]: new Date(clock.now() - 72 * 60 * 60 * 1000) },
        },
        order: [['detectedAt', 'DESC']],
      })
    }
    if (!blendBatch?.mesItem) {
      console.warn(`[SurgeTankMesService] _resolveLayer3Source: no blend batch (active or recent with completions) on ${feedingFromEntName} — deferring`)
      return null
    }
    const resolvedFrom = blendBatch.status === 'active' ? 'blend-tank' : 'blend-tank-recent'
    return {
      itemId: String(blendBatch.mesItem),
      itemName: blendBatch.productName,
      binId: itemConfig.getBinId(feedingFromEntName),
      resolvedFrom,
      layerSkipReason: null,
    }
  }

  if (isSiloRef(feedingFromEntName)) {
    const silo = itemConfig.normalizeSiloName(feedingFromEntName) || feedingFromEntName
    if (feedingUhtId) {
      try {
        const tokens = uhtFeedTokens(feedingUhtId)
        const lineReadings = await historian.getMilkLineStatus()
        const feedingLine = lineReadings.find(r => {
          const dest = String(r.requestedBy || '').toUpperCase()
          return tokens.some(t => dest.includes(t))
        })
        if (feedingLine?.productName) {
          const lineItem = lineMapper.resolveLineProduct(feedingLine.productName)
          if (lineItem?.id) {
            const skipReason = itemConfig.isBulkRawId(lineItem.id) ? 'layer-1-and-2-skip' : 'layer-2-skip'
            return {
              itemId: String(lineItem.id),
              itemName: lineItem.name,
              binId: itemConfig.getBinId(feedingLine.siloName || silo),
              resolvedFrom: 'silo-line-product',
              layerSkipReason: skipReason,
            }
          }
        }
      } catch (err) {
        console.warn(`[SurgeTankMesService] _resolveLayer3Source: line lookup failed — ${err.message}`)
      }
    }
    // No live feeding-line product → do NOT guess from a static silo item.
    // Silos are product-flexible, so any guess could mislabel the issue.
    // Return null; the caller defers the tick and the batch surfaces on the
    // Surge Tank Review backlog for an operator to resolve.
    console.warn(`[SurgeTankMesService] _resolveLayer3Source: no live product for silo ${silo} — deferring to Surge Tank Review`)
    return null
  }

  console.warn(`[SurgeTankMesService] _resolveLayer3Source: unknown feeding source: ${feedingFromEntName}`)
  return null
}

/**
 * Resolve the NS component item to issue against the surge-tank WO.
 *
 * Two paths:
 *   - feedingFromEntName is a blend tank → fetch active MesBlendTankBatch and
 *     use its `mesItem`. Source bin is TANK_BIN_MAP[blendTankId].
 *   - feedingFromEntName is a silo → fetch the milk-line reading whose
 *     destination contains the UHT, then run lineMapper.resolveLineProduct
 *     on that line's productName. Returns null (no static silo guess) if no
 *     line is currently feeding the UHT, so the batch defers to Surge Tank
 *     Review rather than issuing against a guessed item.
 *
 * Returns { itemId, itemName, binId, resolvedFrom } or null when nothing
 * resolves (caller will defer the tick and try again next time).
 */
// UHT1 is fed by TSTAT-1, UHT2 by TSTAT-2 (the blend→TSTAT valve map in
// restProvider). When a product bypasses the blend tanks (A2 Whole: silo →
// TSTAT → UHT → surge), no blend-tank valve is open, so the UHT reports no
// fromEntName and the feeding milk line addresses the TSTAT — not the UHT — in
// requestedBy. Match both so the bypass route still resolves.
function uhtFeedTokens(uhtId) {
  const tokens = [String(uhtId || '').toUpperCase()].filter(Boolean)
  const m = String(uhtId || '').match(/(\d+)/)
  if (m) tokens.push(`TSTAT${m[1]}`, `TSTAT-${m[1]}`)
  return tokens
}

// Resolve the surge component from the milk line currently feeding this UHT
// (directly, or via its TSTAT balance tank). Covers the silo→TSTAT→UHT bypass
// where feedingFromEntName never resolves to a blend tank or silo.
async function resolveComponentFromUhtFeedLine(feedingUhtId, historian) {
  if (!feedingUhtId || !historian) return null
  try {
    const tokens = uhtFeedTokens(feedingUhtId)
    const lineReadings = await historian.getMilkLineStatus()
    const feedingLine = lineReadings.find(r => {
      const dest = String(r.requestedBy || '').toUpperCase()
      return r.productName && tokens.some(t => dest.includes(t))
    })
    if (!feedingLine?.productName) return null
    const lineItem = lineMapper.resolveLineProduct(feedingLine.productName)
    if (!lineItem?.id) return null
    return {
      itemId: String(lineItem.id),
      itemName: lineItem.name,
      binId: itemConfig.getBinId(feedingLine.siloName),
      resolvedFrom: 'uht-feed-line',
      sourceSilo: feedingLine.siloName || null,
    }
  } catch (err) {
    console.warn(`[SurgeTankMesService] resolveComponentFromUhtFeedLine ${feedingUhtId} failed — ${err.message}`)
    return null
  }
}

async function resolveSurgeTankComponent(batch, historian) {
  // New path: tick uses the component pinned at WO-create. Skip every
  // historian/blend-batch lookup the legacy resolver did — the answer is on
  // the row already, and the WO's BOM has exactly this item.
  if (batch.componentItemId) {
    return {
      itemId: String(batch.componentItemId),
      itemName: batch.productName,
      binId: batch.componentBinId != null ? Number(batch.componentBinId) : null,
      resolvedFrom: batch.componentResolvedFrom || 'pinned',
    }
  }

  let feedingFromEntName = batch.feedingFromEntName
  const feedingUhtId = batch.feedingUhtId
  if (!feedingFromEntName) {
    // Retroactive recovery: batches started before the feedingFromEntName fix
    // have null here. Try the live valve-based value from the current UHT status.
    if (!feedingUhtId || !historian) return null
    try {
      const uhtList = await historian.getUhtStatus()
      const uhtStatus = uhtList.find(u => u.uhtId === feedingUhtId)
      feedingFromEntName = uhtStatus?.fromEntName || null
    } catch (err) {
      console.warn(`[SurgeTankMesService] resolveSurgeTankComponent: live UHT lookup failed — ${err.message}`)
    }
    if (!feedingFromEntName) {
      // Silo→TSTAT→UHT bypass (A2 Whole: MSilo3 → TSTAT1 → UHT1 → ST81). No
      // blend-tank valve is open, so the UHT has no fromEntName to recover.
      // Resolve the component straight from the line feeding this UHT's TSTAT.
      const fromLine = await resolveComponentFromUhtFeedLine(feedingUhtId, historian)
      if (fromLine) {
        // Backfill the source silo onto the batch so the UI stops showing
        // "Source ?" — and so future ticks take the stable isSiloRef path.
        if (fromLine.sourceSilo && batch.feedingFromEntName !== fromLine.sourceSilo) {
          try {
            await batch.update({ feedingFromEntName: fromLine.sourceSilo })
            console.log(`[SurgeTankMesService] Backfilled feedingFromEntName="${fromLine.sourceSilo}" on batch ${batch.id} (${batch.tankId}) from UHT feed line`)
          } catch (err) {
            console.warn(`[SurgeTankMesService] Failed to backfill feedingFromEntName on batch ${batch.id}: ${err.message}`)
          }
        }
        console.log(`[SurgeTankMesService] resolveSurgeTankComponent: ${batch.tankId} fed via UHT ${feedingUhtId} bypass — component "${fromLine.itemName}" (NS ${fromLine.itemId}) from feed line`)
        return fromLine
      }
      return null
    }
    // Pin it so future ticks skip this lookup.
    await batch.update({ feedingFromEntName })
    console.log(`[SurgeTankMesService] Retroactively pinned feedingFromEntName="${feedingFromEntName}" on batch ${batch.id} (${batch.tankId})`)
  }

  if (isBlendTankRef(feedingFromEntName)) {
    let blendBatch = await db.MesBlendTankBatch.findOne({
      where: { tankId: feedingFromEntName, status: 'active' },
      order: [['detectedAt', 'DESC']],
    })
    if (!blendBatch?.mesItem) {
      // Same phantom-exclusion filter as _resolveLayer3Source: require > 0 lbs
      // completed and extend to 48h so real older batches aren't missed.
      blendBatch = await db.MesBlendTankBatch.findOne({
        where: {
          tankId: feedingFromEntName,
          status: 'completed',
          mesItem: { [db.Sequelize.Op.ne]: null },
          cumulativeCompletedLbs: { [db.Sequelize.Op.gt]: 0 },
          detectedAt: { [db.Sequelize.Op.gte]: new Date(clock.now() - 72 * 60 * 60 * 1000) },
        },
        order: [['detectedAt', 'DESC']],
      })
    }
    if (!blendBatch?.mesItem) {
      // No MES blend batch on the feeding tank — it was filled before this
      // replay window, named without a fill to open a batch, or a reset wiped
      // it (BlendTank1B post-reset, 2026-06-01). Fall back to the tank's LIVE
      // SCADA product name and parse it to the same raw blend item a batch
      // would carry — exactly what the dashboard shows (e.g. "Marcels 1%" →
      // NS 8340). Lets the surge WO resolve its component without depending on
      // a blend batch existing.
      if (historian) {
        try {
          const tankStatuses = await historian.getBlendTankStatus()
          const tank = (tankStatuses || []).find(t => t.tankId === feedingFromEntName)
          const parsed = tank?.productName ? blendProductParser.parseProductName(tank.productName) : null
          if (parsed?.nsId) {
            console.log(`[SurgeTankMesService] resolveSurgeTankComponent: no batch on ${feedingFromEntName}; resolved component from live product "${tank.productName}" → NS ${parsed.nsId}`)
            return {
              itemId: String(parsed.nsId),
              itemName: parsed.name,
              binId: itemConfig.getBinId(feedingFromEntName),
              resolvedFrom: 'blend-tank-live-product',
            }
          }
        } catch (err) {
          console.warn(`[SurgeTankMesService] resolveSurgeTankComponent: live blend product lookup for ${feedingFromEntName} failed — ${err.message}`)
        }
      }
      console.warn(`[SurgeTankMesService] No blend-tank batch (active or recent) and no parseable live product on ${feedingFromEntName} — cannot resolve component`)
      return null
    }
    const resolvedFrom = blendBatch.status === 'active' ? 'blend-tank-batch' : 'blend-tank-batch-recent'
    return {
      itemId: String(blendBatch.mesItem),
      itemName: blendBatch.productName,
      binId: itemConfig.getBinId(feedingFromEntName),
      resolvedFrom,
    }
  }

  if (isSiloRef(feedingFromEntName)) {
    const silo = itemConfig.normalizeSiloName(feedingFromEntName) || feedingFromEntName
    let resolved = null
    if (feedingUhtId) {
      try {
        const tokens = uhtFeedTokens(feedingUhtId)
        const lineReadings = await historian.getMilkLineStatus()
        const feedingLine = lineReadings.find(r => {
          const dest = String(r.requestedBy || '').toUpperCase()
          return tokens.some(t => dest.includes(t))
        })
        if (feedingLine?.productName) {
          const lineItem = lineMapper.resolveLineProduct(feedingLine.productName)
          if (lineItem?.id) {
            resolved = {
              itemId: String(lineItem.id),
              itemName: lineItem.name,
              binId: itemConfig.getBinId(feedingLine.siloName || silo),
              resolvedFrom: 'silo-line-product',
            }
          }
        }
      } catch (err) {
        console.warn(`[SurgeTankMesService] resolveSurgeTankComponent: line lookup failed — ${err.message}`)
      }
    }
    if (resolved) return resolved
    // No live feeding-line product → do NOT guess from a static silo item
    // (silos are product-flexible). Return null so the tick defers and the
    // batch surfaces on the Surge Tank Review backlog.
    console.warn(`[SurgeTankMesService] resolveSurgeTankComponent: no live product for silo ${silo} — deferring to Surge Tank Review`)
    return null
  }

  console.warn(`[SurgeTankMesService] Unknown feeding source: ${feedingFromEntName}`)
  return null
}

async function processWOStart(data, historian) {
  const { tankId, productName, fgItemId, feedingUhtId, feedingFromEntName, detectedAt } = data

  if (!tankId) throw new Error('tankId is required')
  if (!productName) throw new Error('productName is required')

  const existing = await db.MesSurgeTankBatch.findOne({
    where: { tankId, productName, status: ['active', 'dry_run'] },
  })
  if (existing) {
    console.log(`[SurgeTankMesService] "${productName}" on ${tankId} already active (status: ${existing.status}, nsWO: ${existing.nsWorkOrderId || 'none'}) — skipping`)
    return { success: true, duplicate: true, tankId, productName, status: existing.status }
  }

  const COOLDOWN_MINUTES = 5
  const recentBatch = await db.MesSurgeTankBatch.findOne({
    where: {
      tankId,
      detectedAt: { [db.Sequelize.Op.gte]: new Date(clock.now() - COOLDOWN_MINUTES * 60 * 1000) },
    },
    order: [['detectedAt', 'DESC']],
  })
  if (recentBatch) {
    const ageSec = Math.round((clock.now() - new Date(recentBatch.detectedAt).getTime()) / 1000)
    console.warn(`[SurgeTankMesService] COOLDOWN: "${productName}" on ${tankId} rejected — last batch "${recentBatch.productName}" was ${ageSec}s ago (min ${COOLDOWN_MINUTES * 60}s)`)
    return { success: true, cooldown: true, tankId, productName, lastBatchAge: ageSec }
  }

  // Override path — config or caller can pin an FG item ID directly, skipping
  // the parser (used by SURGE_TANK_OVERRIDES for sandbox testing).
  const overrideItemId = fgItemId || config.SURGE_TANK_OVERRIDES?.[tankId]
  let parsed, assemblyItem
  if (overrideItemId) {
    const overrideCatalog = productParser.getProductByNsId(overrideItemId)
    const overrideName = overrideCatalog?.name || `NS item ${overrideItemId}`
    console.log(`[SurgeTankMesService] OVERRIDE: ${tankId} → NS item ${overrideItemId} (${overrideName}) — skipping parser`)
    parsed = { nsId: overrideItemId, name: overrideName, confidence: 'override', score: 0, parsed: { override: true, productName } }
    assemblyItem = { id: overrideItemId, name: overrideName, confidence: 'override' }
  } else {
    parsed = productParser.parseProductName(productName)
    assemblyItem = parsed
      ? { id: parsed.nsId, name: parsed.name, confidence: parsed.confidence }
      : { id: null, name: `Unrecognized: "${productName}"`, confidence: 'none' }
  }

  console.log(`[SurgeTankMesService] Processing batch start: ${tankId} / "${productName}"`)
  console.log(`  Parsed: ${assemblyItem.name} (NS ${assemblyItem.id}, confidence: ${assemblyItem.confidence})`)
  console.log(`  Feeding: ${feedingFromEntName || '?'} via ${feedingUhtId || '?'}`)

  // Resolve the Layer-3 component (the single raw FG / silo-direct item this WO
  // will consume). Pinning at create-time means the tick never re-resolves and
  // the WO body carries a custom one-line component list scoped to exactly this.
  let resolvedComponent = null
  if (assemblyItem.id && historian) {
    try {
      resolvedComponent = await resolveLayer3Component(data, historian, assemblyItem)
    } catch (err) {
      console.warn(`[SurgeTankMesService] resolveLayer3Component threw — proceeding without pin: ${err.message}`)
    }
  }
  if (resolvedComponent) {
    console.log(`  Layer-3 component: NS ${resolvedComponent.itemId} (${resolvedComponent.itemName}) from ${resolvedComponent.resolvedFrom}${resolvedComponent.layerSkipReason ? ` [${resolvedComponent.layerSkipReason}]` : ''} (pairing: ${resolvedComponent.pairingStatus || 'n/a'})`)
  }

  // Bypass batches arrive with no feedingFromEntName; the Layer-3 resolver
  // recovers the real source silo from the UHT feed line. Use it as the
  // display/source-entity so the batch shows e.g. "MSilo3 via UHT1", not "?".
  const sourceEntity = feedingFromEntName || resolvedComponent?.sourceSilo || null

  const record = await db.MesSurgeTankBatch.create({
    tankId,
    productName,
    mesItem: parsed?.nsId ? String(parsed.nsId) : null,
    feedingUhtId: feedingUhtId || null,
    feedingFromEntName: sourceEntity,
    componentItemId: resolvedComponent?.itemId || null,
    componentBinId: resolvedComponent?.binId || null,
    componentResolvedFrom: resolvedComponent?.resolvedFrom || null,
    layerSkipReason: resolvedComponent?.layerSkipReason || null,
    pairingStatus: resolvedComponent?.pairingStatus || null,
    parserConfidence: assemblyItem.confidence,
    status: 'active',
    detectedAt: detectedAt || new Date(clock.now()),
  })

  let nsResult = null
  try {
    if (config.MES_DRY_RUN) {
      console.log(`[SurgeTankMesService] DRY RUN — "${productName}" saved, skipping NS creation`)
      await record.update({ status: 'dry_run' })
      await db.MesProcessingLog.create({
        eventType: 'surge_tank_wo_create', sourceId: `${tankId}:${productName}`,
        nsTransactionType: 'workOrder', payload: JSON.stringify(data),
        result: JSON.stringify({ dryRun: true, parsed }), success: true,
      })
      return { success: true, duplicate: false, tankId, productName, status: 'dry_run', parsed }
    }

    // Held by a rejected FG⇐raw pairing: don't create the WO. Park the batch in
    // 'error' so it lands on the Surge Tank Review backlog, where ops can retry
    // after approving/fixing the pairing, or reject the batch outright.
    if (resolvedComponent?.pairingStatus === 'blocked') {
      const msg = `FG⇐raw pairing rejected (FG ${assemblyItem.id} ⇐ raw ${resolvedComponent.itemId}) — WO held. Approve or fix the pairing, then retry.`
      console.warn(`[SurgeTankMesService] ${msg}`)
      await record.update({ status: 'error', errorMessage: msg })
      await db.MesProcessingLog.create({
        eventType: 'surge_tank_wo_create', sourceId: `${tankId}:${productName}`,
        nsTransactionType: 'workOrder', payload: JSON.stringify(data),
        result: JSON.stringify({ blocked: 'pairing rejected', parsed }), success: false,
      })
      return { success: true, duplicate: false, tankId, productName, status: 'error', blocked: true, parsed }
    }

    if (!assemblyItem.id) {
      console.log(`[SurgeTankMesService] No NS item for "${productName}" — skipping NS WO creation`)
      await record.update({ status: 'pending_ns' })
      await db.MesProcessingLog.create({
        eventType: 'surge_tank_wo_create', sourceId: `${tankId}:${productName}`,
        nsTransactionType: 'workOrder', payload: JSON.stringify(data),
        result: JSON.stringify({ skipped: 'product not recognized', parsed }), success: true,
      })
      return { success: true, duplicate: false, tankId, productName, status: 'pending_ns', parsed }
    }

    const body = {
      assemblyItem: { id: assemblyItem.id },
      quantity: 1,
      location: { id: 30 },
      subsidiary: { id: 3 },
      // isWip MUST be true — see blendTankMesService.processWOStart for the
      // discovery context. NS rejects every workOrderIssue against a WO with
      // isWip=false ("the work order does not use WIP, or the work order is
      // already closed").
      isWip: true,
      custbody_liquid_milk_wo: true,
      custbody_mes_tank_id: tankId,
      custbody_mes_product_name: productName,
      custbody_mes_source_entity: sourceEntity,
      custbody_mes_dest_entity: tankId,
    }
    // Custom one-line component list pins the WO's BOM to the resolved Layer-3
    // component (raw FG / silo-direct). Without this, NS would default-populate
    // the assembly's static BOM, which won't match in skip-paths.
    if (resolvedComponent?.itemId) {
      body.item = {
        items: [{
          item: { id: Number(resolvedComponent.itemId) },
          quantity: 1,
        }],
      }
    }

    console.log(`[SurgeTankMesService] Creating NS WO for "${productName}" on ${tankId}`)
    nsResult = await core.netsuitePost('/record/v1/workOrder', body)
    console.log(`[SurgeTankMesService] NS WO response: status=${nsResult?.status}`)

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
          console.warn(`[SurgeTankMesService] Could not fetch WO details: ${e.message}`)
        }
      }
    }

    await record.update({ nsWorkOrderId, nsWorkOrderNumber, status: 'active' })
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_wo_create', sourceId: `${tankId}:${productName}`,
      nsTransactionType: 'workOrder', nsTransactionId: nsWorkOrderId,
      payload: JSON.stringify(data), result: JSON.stringify(nsResult), success: true,
    })

    console.log(`[SurgeTankMesService] "${productName}" → NS WO ${nsWorkOrderNumber} (${nsWorkOrderId})`)

    // Snapshot the UHT totalizer at WO creation — the fire-and-forget below
    // uses it to seed the issue-state baseline so the first tick catches up
    // milk that flowed between actual batch start and detection.
    const _seedGalAtCreate = feedingUhtId
      ? await historian.getUhtMilkTotalizer(feedingUhtId).catch(() => null)
      : null
    const _seedBatchId  = record.id
    const _seedUhtId    = feedingUhtId
    const _seedDetected = new Date(detectedAt || clock.now())

    // Fire-and-forget: back-project the actual start time from historian data,
    // then pre-seed MesSurgeTankIssueState so the first tick issues from
    // actual start (not from detection time).
    batchStartFinder.findSurgeTankActualStart(tankId, _seedDetected, historian)
      .then(async result => {
        if (!result) return
        await record.update({ actualStartAt: result.estimatedStartAt })

        if (_seedGalAtCreate == null || !_seedUhtId) return
        const gapMs = _seedDetected.getTime() - result.estimatedStartAt.getTime()
        // Suspicious if gap is negative or > 30 min (likely matched an old fill)
        if (gapMs <= 0 || gapMs > BACKFILL_MAX_GAP_MS) return

        const backfillGal = await batchStartFinder.integrateFt1102BackfillGal(
          _seedUhtId, result.estimatedStartAt, _seedDetected, historian
        )
        if (!(backfillGal > 0)) return

        // Only pre-seed if the first tick hasn't already created the state row
        const existing = await db.MesSurgeTankIssueState.findOne({
          where: { surgeTankBatchId: _seedBatchId, uhtId: _seedUhtId }
        })
        if (existing) return

        const seedBaselineGal = Math.max(0, _seedGalAtCreate - backfillGal)
        await db.MesSurgeTankIssueState.create({
          surgeTankBatchId: _seedBatchId,
          uhtId: _seedUhtId,
          lastIssuedUhtGal: seedBaselineGal,
          lastTotalizerGal: seedBaselineGal,
          lastObservedAt: _seedDetected,
          lastFromEntName: record.feedingFromEntName || null,
        })
        console.log(`[SurgeTankMesService] ${tankId}: pre-seeded issue baseline ${seedBaselineGal.toFixed(1)} gal (backfill ${backfillGal.toFixed(1)} gal from ${result.estimatedStartAt.toISOString()})`)
      })
      .catch(err => console.warn(`[SurgeTankMesService] actualStart/seed failed for ${tankId}: ${err.message}`))

    return { success: true, duplicate: false, tankId, productName, nsWorkOrderId, nsWorkOrderNumber, status: 'active', parsed }

  } catch (err) {
    console.error(`[SurgeTankMesService] Failed to create NS WO for "${productName}":`, err.message)
    await record.update({ status: 'error', errorMessage: err.message })
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_wo_create', sourceId: `${tankId}:${productName}`,
      nsTransactionType: 'workOrder', payload: JSON.stringify(data), success: false, errorMessage: err.message,
    })
    throw err
  }
}

/**
 * End-of-batch — fired when the surge tank product clears or empties out.
 * Flush any final issue + completion delta, then close.
 */
async function processWOEnd(data, historian) {
  const { tankId, productName, detectedAt } = data
  if (!tankId) throw new Error('tankId is required')

  const where = { tankId, status: 'active' }
  if (productName) where.productName = productName

  const record = await db.MesSurgeTankBatch.findOne({ where })
  if (!record) {
    console.log(`[SurgeTankMesService] No active batch for ${tankId}${productName ? ` / "${productName}"` : ''} — ignoring end event`)
    return { success: true, message: 'No active batch found' }
  }

  // Legacy / no-arrival fallback: completion is driven by measured arrival
  // (cumulativeOutputLbs). Batches that predate arrival tracking — or where the
  // surge level never reported during the batch (lastDestLevelLbs still null) —
  // have output=0 and would strand their completion. Don't claim phantom UHT
  // loss: complete everything issued (1:1, waste unmeasured).
  if ((parseFloat(record.cumulativeOutputLbs) || 0) <= 0 &&
      record.lastDestLevelLbs == null &&
      (parseFloat(record.cumulativeIssuedLbs) || 0) > 0) {
    console.log(`[SurgeTankMesService] ${tankId}: no arrival measured this batch — completing issued 1:1 (no waste claim)`)
    await record.update({ cumulativeOutputLbs: parseFloat(record.cumulativeIssuedLbs) || 0 })
    await record.reload()
  }

  // Final flush — pull any last UHT-totalizer delta into NS, capture any last
  // surge arrival, then close.
  let flushedIssue = false
  let flushedCompletion = false
  try {
    flushedIssue = await tickIssueForBatch(record, historian)
    if (flushedIssue) await record.reload()
    await tickArrivalForBatch(record, historian, 'issue', flushedIssue)
    await record.reload()
    flushedCompletion = await tickCompletionForBatch(record)
  } catch (err) {
    console.error(`[SurgeTankMesService] Final flush failed for ${tankId}:`, err.message)
  }
  await record.reload()

  // Waste = issued (UHT FT1102 inlet) − output (measured surge arrival). The gap
  // is the UHT-leg loss, left as implicit NS shrinkage (issued > completed).
  // It is a conservative UPPER bound: concurrent fill+drain under-counts arrival.
  const issuedLbs = parseFloat(record.cumulativeIssuedLbs) || 0
  const outputLbs = parseFloat(record.cumulativeOutputLbs) || 0
  const wasteLbs = Math.max(0, issuedLbs - outputLbs)
  const wastePercent = issuedLbs >= 10
    ? Math.max(0, Math.min(999999.99, (wasteLbs / issuedLbs) * 100))
    : null

  // Zero-issue close guard (SD-708 / WO2060 incident): a batch can close
  // 'completed' with essentially nothing issued while the UHT totalizer
  // observed real flow — every NS issue was rejected or skipped, and because
  // wastePercent is null below 10 lb issued, no alert would ever fire. Shout
  // (error-level survives the prod log silencer) and stamp the close record so
  // the review/analytics surfaces can show what the books are missing.
  let closedZeroIssued = false
  let unIssuedLbs = 0
  try {
    const issueState = await db.MesSurgeTankIssueState.findOne({ where: { surgeTankBatchId: record.id } })
    if (issueState) {
      unIssuedLbs = Math.max(0, (parseFloat(issueState.lastTotalizerGal) || 0) - (parseFloat(issueState.lastIssuedUhtGal) || 0)) * GAL_TO_LBS
    }
    if (issuedLbs < 10 && unIssuedLbs > 1000) {
      closedZeroIssued = true
      console.error(`[SurgeTankMesService] ${tankId} (WO ${record.nsWorkOrderNumber || record.nsWorkOrderId}) closed with ~0 lb issued but ~${unIssuedLbs.toFixed(0)} lb of UHT flow un-issued — NetSuite is missing this production. Last issue error: ${String(record.lastIssueError || 'n/a').replace(/\s+/g, ' ').slice(0, 200)}`)
      statusStore.pushEvent(
        'surgeBatch.closedZeroIssued',
        `${tankId}: batch closed with ~0 lb issued, ~${unIssuedLbs.toFixed(0)} lb un-issued (WO ${record.nsWorkOrderNumber || record.nsWorkOrderId})`,
        { tankId, nsWorkOrderId: record.nsWorkOrderId, nsWorkOrderNumber: record.nsWorkOrderNumber || null, unIssuedLbs, lastIssueError: record.lastIssueError || null }
      )
    }
  } catch (e) {
    console.warn(`[SurgeTankMesService] zero-issue close check failed: ${e.message}`)
  }

  // When the tank filled and drained at once, the net-rise arrival under-counts,
  // so the waste figure above is a loose upper bound — UNLESS every concurrent
  // tick was metered by the Filler 1 inlet meter (SD-708) and the drain credit
  // is actually applied (MES_METERED_DRAIN), in which case waste is measured.
  const concurrent = !!record.concurrentFillDrain
  const concurrentTicks = Number(record.concurrentTickCount) || 0
  const meteredDrainLbs = parseFloat(record.meteredDrainLbs) || 0
  const meteredTicks = Number(record.meteredDrainTickCount) || 0
  const outputWithDrainLbs = record.outputWithDrainLbs != null ? parseFloat(record.outputWithDrainLbs) : null
  const wasteWithDrainLbs = outputWithDrainLbs != null ? Math.max(0, issuedLbs - outputWithDrainLbs) : null
  const wasteWithDrainPercent = wasteWithDrainLbs != null && issuedLbs >= 10
    ? Math.max(0, Math.min(999999.99, (wasteWithDrainLbs / issuedLbs) * 100))
    : null
  // Fully metered = every concurrent tick had a measurable, unambiguous meter
  // read AND the only latched line was 1 (the metered Filler 1 leg — a Filler 2
  // draw on the shared Sel1 leg keeps waste an upper bound).
  const drainFullyMetered = concurrent && concurrentTicks > 0
    && meteredTicks === concurrentTicks && record.drainFillerLines === '1'
  const concurrentNote = concurrent
    ? (drainFullyMetered && config.MES_METERED_DRAIN
        ? ` — drain metered via Filler 1 inlet (${meteredDrainLbs.toFixed(1)} lb over ${meteredTicks} tick(s)); waste is measured`
        : ` ⚠ concurrent fill+drain on ${record.concurrentTickCount} tick(s) (filler line(s) ${record.drainFillerLines || '?'}) — waste is an upper bound, not a measured value (metered ${meteredTicks} of ${concurrentTicks} concurrent tick(s))`)
    : ''

  await record.update({
    status: 'completed',
    completedAt: detectedAt || new Date(clock.now()),
    wasteLbs,
    wastePercent,
  })
  statusStore.recordClosedSurgeBatch(record)
  if (record.nsWorkOrderId) clearBomCache(record.nsWorkOrderId)
  await db.MesProcessingLog.create({
    eventType: 'surge_tank_wo_complete',
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
      note: 'waste = UHT-leg loss (issued − reached); upper bound under concurrent fill+drain unless drain fully metered',
      concurrentFillDrain: concurrent,
      concurrentTickCount: concurrentTicks,
      drainFillerLines: record.drainFillerLines || null,
      meteredDrainLbs,
      meteredDrainTickCount: meteredTicks,
      outputWithDrainLbs,
      wasteWithDrainLbs,
      wasteWithDrainPercent,
      drainFullyMetered,
      meteredDrainApplied: config.MES_METERED_DRAIN,
      closedZeroIssued,
      unIssuedLbs,
      flushedIssue,
      flushedCompletion,
    }),
    success: true,
  })

  if (wastePercent != null && wastePercent > itemConfig.WASTE_ALERT_THRESHOLD) {
    console.warn(`[SurgeTankMesService] High waste alert: ${wastePercent.toFixed(1)}% on ${tankId}`)
    await notifyService.sendAlert(
      'MES Surge Tank: High Waste Alert',
      `Batch "${record.productName}" on ${tankId}\nWaste: ${wasteLbs.toFixed(1)} LBS (${wastePercent.toFixed(1)}%) — UHT-leg loss\nIssued ${issuedLbs.toFixed(0)} | Reached surge ${outputLbs.toFixed(0)}\nThreshold: ${itemConfig.WASTE_ALERT_THRESHOLD}%${concurrent ? `\n${concurrentNote.trim()}` : ''}`
    )
  }

  console.log(`[SurgeTankMesService] Batch "${record.productName}" on ${tankId} closed — issued ${issuedLbs.toFixed(0)} lb, reached ${outputLbs.toFixed(0)} lb, completed ${parseFloat(record.cumulativeCompletedLbs).toFixed(0)} lb, waste ${wasteLbs.toFixed(0)} lb (${wastePercent != null ? wastePercent.toFixed(1) + '%' : 'n/a'})${concurrentNote}`)
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
    concurrentFillDrain: concurrent,
    concurrentTickCount: concurrentTicks,
    drainFillerLines: record.drainFillerLines || null,
    meteredDrainLbs,
    meteredDrainTickCount: meteredTicks,
    outputWithDrainLbs,
    wasteWithDrainLbs,
    wasteWithDrainPercent,
    drainFullyMetered,
    meteredDrainApplied: config.MES_METERED_DRAIN,
  }
}

/**
 * Read the UHT software totalizer, compute delta vs the last fire baseline,
 * and POST a workOrderIssue for the new flow. Component is resolved per-tick
 * because the UHT may swap from one blend tank to another mid-batch (uncommon,
 * but the architecture supports it).
 */
async function tickIssueForBatch(batch, historian, issueMode = 'issue') {
  if (!batch.feedingUhtId) {
    console.warn(`[SurgeTankMesService] batch ${batch.id} (${batch.tankId}) has no feedingUhtId — skip`)
    return false
  }

  const currentGal = await historian.getUhtMilkTotalizer(batch.feedingUhtId)
  const observedAt = new Date(clock.now())

  let state = await db.MesSurgeTankIssueState.findOne({
    where: { surgeTankBatchId: batch.id, uhtId: batch.feedingUhtId },
  })
  if (!state) {
    // Baseline on the current totalizer so the first tick only issues the
    // delta that accumulates AFTER this batch started, not the entire UHT
    // run history since the last IDLE→PROCESS reset. The accumulator
    // (_uhtMilkGal) is in-memory and never resets between consecutive surge
    // batches, so initialising to 0 would try to issue hundreds of thousands
    // of gallons on the very first tick and always fail for insufficient inventory.
    state = await db.MesSurgeTankIssueState.create({
      surgeTankBatchId: batch.id,
      uhtId: batch.feedingUhtId,
      lastIssuedUhtGal: currentGal,
      lastTotalizerGal: currentGal,
      lastObservedAt: observedAt,
      lastFromEntName: batch.feedingFromEntName || null,
    })
  }

  const lastIssued = parseFloat(state.lastIssuedUhtGal) || 0

  // A real milk totalizer is monotonic and non-negative. A negative baseline
  // or reading means the in-memory accumulator was corrupted — historically a
  // concurrent-poll race in getUhtStatus drove _uhtMilkGal to ~-394k gal, and
  // a stored-negative baseline against a fresh (post-restart) reading computes
  // as a six-figure positive delta and dumps millions of phantom lbs onto the
  // WO. Re-baseline to the current reading and issue nothing this tick. The
  // restProvider integration is now floored to forward flow so the totalizer
  // can't re-enter this state; this just neutralises rows carried over from
  // before that fix.
  if (lastIssued < 0 || currentGal < 0) {
    console.warn(`[SurgeTankMesService] tick: UHT ${batch.feedingUhtId} totalizer baseline invalid (lastIssued=${lastIssued.toFixed(1)} gal, current=${currentGal.toFixed(1)} gal) — re-baselining, no issue this tick`)
    await state.update({ lastIssuedUhtGal: Math.max(currentGal, 0), lastTotalizerGal: currentGal, lastObservedAt: observedAt })
    return false
  }

  // --- Single-claimant gate -------------------------------------------------
  // A UHT sterilizes milk for exactly ONE surge tank at a time, but two batches
  // on the same UHT are 'active' simultaneously whenever one tank drains to the
  // filler while the next fills (e.g. ST81+ST82 both on UHT1). They share this
  // one software totalizer, so without a gate BOTH batches issue the same
  // gallons and the draining tank's WO double-counts flow that physically went
  // to the filling tank (observed on WO1635/WO1636). The caller passes issueMode
  // after consulting equipmentJob's hysteresis fill-target designation:
  //   'issue'   — sole/active claimant on this UHT: issue normally.
  //   'forfeit' — a sibling tank is the active fill tank: advance the baseline so
  //               this batch never (re)claims gallons that went elsewhere.
  //   'hold'    — fill target ambiguous (no tank designated): issue nothing and
  //               DON'T advance, so the accumulated delta lands on whichever tank
  //               becomes the clear fill target on a later tick.
  if (issueMode === 'forfeit') {
    const skippedLbs = Math.max(0, currentGal - lastIssued) * GAL_TO_LBS
    await state.update({ lastIssuedUhtGal: currentGal, lastTotalizerGal: currentGal, lastObservedAt: observedAt })
    if (skippedLbs >= config.MES_MIN_ISSUE_LBS) {
      console.log(`[SurgeTankMesService] tick: ${batch.tankId} is not the active fill tank on ${batch.feedingUhtId} — forfeiting ${skippedLbs.toFixed(0)} lb to the filling tank (no double-count)`)
    }
    return false
  }
  if (issueMode === 'hold') {
    const heldLbs = Math.max(0, currentGal - lastIssued) * GAL_TO_LBS
    await state.update({ lastTotalizerGal: currentGal, lastObservedAt: observedAt })
    if (heldLbs >= config.MES_MIN_ISSUE_LBS) {
      console.log(`[SurgeTankMesService] tick: ${batch.feedingUhtId} fill target ambiguous — holding ${heldLbs.toFixed(0)} lb on ${batch.tankId} until a clear fill tank emerges`)
    }
    return false
  }

  let deltaGal
  if (currentGal >= lastIssued) {
    deltaGal = currentGal - lastIssued
  } else if (lastIssued - currentGal > TOTALIZER_RESET_DROP_GAL) {
    // Genuine totalizer reset (IDLE/CIP→PROCESS wiped the accumulator to 0).
    // Pre-reset milk is already issued; issue only the post-reset value.
    deltaGal = currentGal
    console.warn(`[SurgeTankMesService] tick: UHT ${batch.feedingUhtId} totalizer reset (was ${lastIssued.toFixed(1)} gal, now ${currentGal.toFixed(1)} gal) — issuing post-reset value only`)
  } else {
    // Tiny backward step — float jitter / concurrent-poll race on the shared
    // _uhtMilkGal accumulator, NOT a reset and NOT new milk. Hold the baseline
    // and issue nothing this tick (prevents the WO1598 534k re-count).
    deltaGal = 0
    console.warn(`[SurgeTankMesService] tick: UHT ${batch.feedingUhtId} totalizer dipped ${(lastIssued - currentGal).toFixed(2)} gal (${lastIssued.toFixed(1)}→${currentGal.toFixed(1)}) — jitter, not a reset; issuing nothing`)
  }

  await state.update({ lastTotalizerGal: currentGal, lastObservedAt: observedAt })

  const deltaLbs = deltaGal * GAL_TO_LBS
  if (deltaLbs < config.MES_MIN_ISSUE_LBS) return false

  if (config.MES_DRY_RUN) {
    await state.update({ lastIssuedUhtGal: currentGal, lastIssueAt: observedAt })
    await batch.increment({ cumulativeIssuedLbs: deltaLbs })
    await batch.update({ lastIssueAt: observedAt, consecutiveIssueFailures: 0, lastIssueError: null, lastIssueErrorAt: null })
    console.log(`[SurgeTankMesService] DRY RUN tick issue UHT ${batch.feedingUhtId} → ${batch.tankId}: ${deltaLbs.toFixed(1)} lb (${deltaGal.toFixed(1)} gal)`)
    return true
  }

  if (!batch.nsWorkOrderId) {
    console.log(`[SurgeTankMesService] tick: batch ${batch.id} (${batch.tankId}) has no NS WO — skipping ${deltaLbs.toFixed(1)} lb delta`)
    return false
  }

  const component = await resolveSurgeTankComponent(batch, historian)
  if (!component?.itemId) {
    console.warn(`[SurgeTankMesService] tick: cannot resolve component for ${batch.tankId} (from ${batch.feedingFromEntName}) — deferring`)
    statusStore.pushEvent(
      'surgeTick.skipped',
      `${batch.tankId}: cannot resolve component (from ${batch.feedingFromEntName}) — ${deltaLbs.toFixed(0)} lb deferred`,
      { tankId: batch.tankId, reason: 'no-component', from: batch.feedingFromEntName, deltaLbs }
    )
    return false
  }
  if (!component.binId) {
    console.warn(`[SurgeTankMesService] tick: no bin for component source on ${batch.tankId} — deferring (${deltaLbs.toFixed(1)} lb)`)
    statusStore.pushEvent(
      'surgeTick.skipped',
      `${batch.tankId}: no bin for component source — ${deltaLbs.toFixed(0)} lb deferred`,
      { tankId: batch.tankId, reason: 'no-bin', component, deltaLbs }
    )
    return false
  }

  const bomLines = await fetchWoBomLines(batch.nsWorkOrderId)
  // Membership check intentionally removed: the WO was created with a custom
  // one-line component list scoped to component.itemId in processWOStart, so
  // by construction the BOM contains exactly this item. Legacy batches without
  // a pinned component fall through to today's re-resolver path above.

  let body, allocations, tracking, resolvedBin, woHasLotLines
  try {
    const built = await buildWoIssueBody(batch.nsWorkOrderId, component.itemId, deltaLbs, component.binId, bomLines)
    body = built.body
    allocations = built.allocations
    tracking = built.tracking
    resolvedBin = built.resolvedBinId
    woHasLotLines = built.woHasLotLines
  } catch (err) {
    console.error(`[SurgeTankMesService] tick issue ${batch.tankId} → WO ${batch.nsWorkOrderId}: buildWoIssueBody failed — ${err.message}`)
    statusStore.pushEvent(
      'surgeTick.issueFailed',
      `${batch.tankId}: buildWoIssueBody failed (${deltaLbs.toFixed(0)} lb, item ${component.itemId}) — ${nsErrShort(err)}`,
      {
        tankId: batch.tankId,
        nsWorkOrderId: batch.nsWorkOrderId,
        phase: 'buildWoIssueBody',
        code: err.code || null,
        itemId: component.itemId,
        binId: component.binId,
        deltaLbs,
        error: err.message.slice(0, 500),
      }
    )
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_tick_issue',
      sourceId: batch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue',
      payload: JSON.stringify({ batchId: batch.id, uhtId: batch.feedingUhtId, deltaGal, deltaLbs, component }),
      success: false,
      errorMessage: err.message,
    })
    await noteIssueFailure(batch, err, state)
    return false
  }

  try {
    const allocSummary = allocations
      ? ` via ${allocations.map(a => `lot ${a.lotName}@${a.binName} ${a.qty.toFixed(1)}`).join(' + ')}`
      : ''
    console.log(`[SurgeTankMesService] tick issue UHT ${batch.feedingUhtId} → WO ${batch.nsWorkOrderId} (${batch.tankId}): ${deltaLbs.toFixed(1)} lb "${component.itemName}" (NS ${component.itemId}, ${component.resolvedFrom})${allocSummary}`)
    const issued = await postSurgeIssueWithShortfallRetry({
      nsWorkOrderId: batch.nsWorkOrderId, targetItemId: component.itemId,
      binId: component.binId, body, tankName: batch.tankId,
      quantity: deltaLbs, bomLines, woHasLotLines, tracking,
    })
    body = issued.body
    const nsResult = issued.nsResult
    const nsIssueId = extractNsIssueId(nsResult)

    await state.update({
      lastIssuedUhtGal: currentGal,
      lastIssueAt: observedAt,
      lastFromEntName: batch.feedingFromEntName || null,
      lastProductName: component.itemName,
    })
    await batch.increment({ cumulativeIssuedLbs: deltaLbs })
    await batch.update({
      lastIssueAt: observedAt,
      consecutiveIssueFailures: 0,
      lastIssueError: null,
      lastIssueErrorAt: null,
    })

    await db.MesProcessingLog.create({
      eventType: 'surge_tank_tick_issue',
      sourceId: batch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue',
      nsTransactionId: nsIssueId,
      payload: JSON.stringify({ batchId: batch.id, uhtId: batch.feedingUhtId, deltaGal, deltaLbs, currentGal, component }),
      result: JSON.stringify({ nsIssueId }),
      success: true,
    })
    return true
  } catch (err) {
    // Read the resolved bin's actual on-hand so the failure shows whether NS
    // rejected because the bin can't cover the assignment (detail clamped below
    // the line) vs. because the item is really lot-tracked and the bin-only
    // detail carries no lot. tracking tells which assignment shape we sent.
    let binOnHand = null
    try {
      if (resolvedBin) binOnHand = await inventoryAdjustment.getBinQtyOnHand(component.itemId, resolvedBin)
    } catch (_) { /* diagnostic only */ }
    console.error(`[SurgeTankMesService] tick issue failed for ${batch.tankId} (WO ${batch.nsWorkOrderId}):`, err.message)
    console.error(`[SurgeTankMesService] failed workOrderIssue request body (WO ${batch.nsWorkOrderId}):`, JSON.stringify(body))
    console.error(`[SurgeTankMesService] failed issue context: item=${component.itemId} tracking=${JSON.stringify(tracking)} resolvedBin=${resolvedBin} binOnHand=${binOnHand} deltaLbs=${deltaLbs}`)
    statusStore.pushEvent(
      'surgeTick.issueFailed',
      `${batch.tankId}: NS workOrderIssue POST failed (${deltaLbs.toFixed(0)} lb) — ${nsErrShort(err)}`,
      {
        tankId: batch.tankId,
        nsWorkOrderId: batch.nsWorkOrderId,
        phase: 'netsuitePost',
        deltaLbs,
        error: err.message.slice(0, 500),
        requestBody: body,
        tracking,
        woHasLotLines,
        resolvedBin,
        binOnHand,
      }
    )
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_tick_issue',
      sourceId: batch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue',
      payload: JSON.stringify({ batchId: batch.id, uhtId: batch.feedingUhtId, deltaGal, deltaLbs, currentGal, requestBody: body }),
      success: false,
      errorMessage: err.message,
    })
    // Don't advance lastIssuedUhtGal — same delta retries next tick.
    await noteIssueFailure(batch, err, state)
    return false
  }
}

// A batch whose NS issues fail back-to-back is "stuck": milk keeps flowing and
// the cursor keeps holding, but nothing reaches the books — the WO2060/WO2062
// failure mode that ran silent for 11 hours. Track the streak on the batch row
// (survives restarts, flows into live-status/analytics/review), and escalate
// quietly: console.error (pm2-visible in prod) + an ordinary statusStore event.
// Deliberately NO email/Teams — report-only, per SD-708 rollout decisions.
const STUCK_ISSUE_FAILURE_THRESHOLD = 5 // ~25 min at the prod 5-min tick

async function noteIssueFailure(batch, err, state) {
  try {
    const count = (Number(batch.consecutiveIssueFailures) || 0) + 1
    await batch.update({
      consecutiveIssueFailures: count,
      lastIssueError: String(err.message || err).slice(0, 500),
      lastIssueErrorAt: new Date(clock.now()),
    })
    // First shout at the threshold, then at most ~hourly (every 12th tick).
    if (count === STUCK_ISSUE_FAILURE_THRESHOLD
        || (count > STUCK_ISSUE_FAILURE_THRESHOLD && count % 12 === 0)) {
      const heldLbs = state
        ? Math.max(0, (parseFloat(state.lastTotalizerGal) || 0) - (parseFloat(state.lastIssuedUhtGal) || 0)) * GAL_TO_LBS
        : null
      console.error(`[SurgeTankMesService] STUCK: ${batch.tankId} (WO ${batch.nsWorkOrderNumber || batch.nsWorkOrderId}) — ${count} consecutive NS issue failures${heldLbs != null ? `, ~${heldLbs.toFixed(0)} lb held` : ''}. Last error: ${String(err.message || '').replace(/\s+/g, ' ').slice(0, 200)}`)
      statusStore.pushEvent(
        'surgeTick.stuck',
        `${batch.tankId}: ${count} consecutive NS issue failures${heldLbs != null ? ` — ~${heldLbs.toFixed(0)} lb held` : ''} (WO ${batch.nsWorkOrderNumber || batch.nsWorkOrderId})`,
        { tankId: batch.tankId, nsWorkOrderId: batch.nsWorkOrderId, nsWorkOrderNumber: batch.nsWorkOrderNumber || null, count, heldLbs }
      )
    }
  } catch (e) {
    console.warn(`[SurgeTankMesService] noteIssueFailure bookkeeping failed: ${e.message}`)
  }
}

async function tickCompletionForBatch(batch) {
  // Completion is driven by measured ARRIVAL (cumulativeOutputLbs), not issued —
  // issued − output is left as implicit NS shrinkage (the waste). See
  // tickArrivalForBatch / [[ns-wo-completion-pattern]].
  if (config.MES_DRY_RUN) {
    const target = (parseFloat(batch.cumulativeOutputLbs) || 0) - (parseFloat(batch.cumulativeCompletedLbs) || 0)
    if (target < config.MES_MIN_COMPLETION_LBS) return false
    await batch.update({ cumulativeCompletedLbs: parseFloat(batch.cumulativeOutputLbs) || 0, lastCompletionAt: new Date(clock.now()) })
    console.log(`[SurgeTankMesService] DRY RUN tick completion ${batch.tankId}: ${target.toFixed(1)} lb (arrival-driven)`)
    return true
  }
  if (!batch.nsWorkOrderId) return false

  // Cheap pre-check before taking the lock so idle batches don't serialize.
  if ((parseFloat(batch.cumulativeOutputLbs) || 0) - (parseFloat(batch.cumulativeCompletedLbs) || 0) < config.MES_MIN_COMPLETION_LBS) {
    return false
  }

  // Serialize completions per WO so the tick and the end-of-batch flush can't
  // race to create the same lot ("This record already exists").
  return withCompletionLock(batch.nsWorkOrderId, async () => {
    await batch.reload()
    const cumulativeIssued = parseFloat(batch.cumulativeIssuedLbs) || 0
    const cumulativeOutput = parseFloat(batch.cumulativeOutputLbs) || 0
    const cumulativeCompleted = parseFloat(batch.cumulativeCompletedLbs) || 0
    const target = cumulativeOutput - cumulativeCompleted

    if (target < config.MES_MIN_COMPLETION_LBS) {
      console.log(`[SurgeTankMesService] completion ${batch.tankId}: already satisfied (reached ${cumulativeOutput.toFixed(1)}, completed ${cumulativeCompleted.toFixed(1)}, issued ${cumulativeIssued.toFixed(1)}) — skipping`)
      return false
    }

    const completionBinId = itemConfig.getBinId(batch.tankId)
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
      custbody_liquid_milk_wo: true,
      inventorydetail: {
        inventoryassignment: { items: [assignmentEntry] },
      },
    }

    try {
      console.log(`[SurgeTankMesService] tick completion WO ${batch.nsWorkOrderId} (${batch.tankId}): ${target.toFixed(1)} lb → bin ${completionBinId || 'none'} (completed ${cumulativeCompleted.toFixed(1)} → ${cumulativeOutput.toFixed(1)} reached, issued ${cumulativeIssued.toFixed(1)})`)
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
        eventType: 'surge_tank_tick_completion',
        sourceId: batch.nsWorkOrderId,
        nsTransactionType: 'workOrderCompletion',
        nsTransactionId: nsCompletionId,
        payload: JSON.stringify({ batchId: batch.id, target, cumulativeIssued, cumulativeOutput, cumulativeCompleted }),
        result: JSON.stringify({ nsCompletionId, lotNumber }),
        success: true,
      })
      return true
    } catch (err) {
      if (isAlreadyExistsError(err)) {
        const built = await fetchWoBuiltQuantity(batch.nsWorkOrderId).catch(e => {
          console.warn(`[SurgeTankMesService] builtQuantity lookup failed for WO ${batch.nsWorkOrderId}: ${e.message}`)
          return null
        })
        console.warn(`[SurgeTankMesService] completion lot "${lotNumber}" already exists on WO ${batch.nsWorkOrderId} (NS built=${built ?? '?'}, reached=${cumulativeOutput.toFixed(1)}) — reconciling, not re-firing`)
        const reconciledCompleted = built != null
          ? Math.max(cumulativeCompleted, Math.min(built, cumulativeOutput))
          : cumulativeOutput
        await batch.update({ cumulativeCompletedLbs: reconciledCompleted, lastCompletionAt: new Date(clock.now()) })
        await db.MesProcessingLog.create({
          eventType: 'surge_tank_tick_completion',
          sourceId: batch.nsWorkOrderId,
          nsTransactionType: 'workOrderCompletion',
          payload: JSON.stringify({ batchId: batch.id, target, cumulativeIssued, cumulativeOutput, cumulativeCompleted }),
          result: JSON.stringify({ reconciled: true, nsBuiltQuantity: built, reconciledCompleted }),
          success: true,
        })
        statusStore.pushEvent(
          'surgeTick.completionReconciled',
          `${batch.tankId}: completion already present in NS (built ${built != null ? built.toFixed(0) : '?'} lb of ${cumulativeOutput.toFixed(0)} reached) — reconciled, no double build`,
          { tankId: batch.tankId, nsWorkOrderId: batch.nsWorkOrderId, nsBuiltQuantity: built, cumulativeIssued, cumulativeOutput, reconciledCompleted }
        )
        return cumulativeOutput - reconciledCompleted < config.MES_MIN_COMPLETION_LBS
      }

      console.error(`[SurgeTankMesService] tick completion failed for WO ${batch.nsWorkOrderId}:`, err.message)
      statusStore.pushEvent(
        'surgeTick.completionFailed',
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
        eventType: 'surge_tank_tick_completion',
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

/**
 * Decide, per active batch, whether it may claim its feeding UHT's totalizer
 * delta this tick. A UHT feeds one tank at a time but can have two open batches
 * (one draining, one filling) — only the tank actually being filled may issue,
 * or the shared totalizer is counted twice. Uses equipmentJob's hysteresis
 * `activeFill` designation (from statusStore) as the authoritative fill target.
 *
 * Returns { [batchId]: 'issue' | 'forfeit' | 'hold' } — see tickIssueForBatch.
 * Fail-safe: if the equipment poll hasn't populated activeFill (e.g. fresh
 * restart), a UHT collision resolves to 'hold' for all — defers issuing rather
 * than risking a double-count.
 */
function resolveIssueModes(activeBatches) {
  const modes = {}
  const tanks = statusStore.snapshot()?.surgeTanks?.tanks || []
  const activeFillByTank = {}
  for (const t of tanks) activeFillByTank[t.tankId] = !!t.activeFill

  const byUht = {}
  for (const b of activeBatches) {
    // Batches without a feeding UHT can't collide — give each its own group.
    const key = b.feedingUhtId || `__none_${b.id}`
    ;(byUht[key] ||= []).push(b)
  }

  for (const group of Object.values(byUht)) {
    if (group.length === 1) {
      modes[group[0].id] = 'issue'
      continue
    }
    const claimant = group.find(b => activeFillByTank[b.tankId])
    if (claimant) {
      for (const b of group) modes[b.id] = b.id === claimant.id ? 'issue' : 'forfeit'
      console.log(`[SurgeTankMesService] tick: ${group[0].feedingUhtId} has ${group.length} open batches — ${claimant.tankId} is the active fill tank; others forfeit this tick`)
    } else {
      for (const b of group) modes[b.id] = 'hold'
      console.log(`[SurgeTankMesService] tick: ${group[0].feedingUhtId} has ${group.length} open batches but no active fill tank designated — holding all (no double-count)`)
    }
  }
  return modes
}

/**
 * Measure how much milk REACHED this surge tank and accumulate it into
 * cumulativeOutputLbs — the value that drives workOrderCompletion. Arrival =
 * positive surge-level rise (mainGallons × 8.6), summed across ticks. Because
 * the issue side is the UHT FT1102 inlet, `cumulativeIssued − cumulativeOutput`
 * is the UHT-leg loss (the user's "blend had 90, 50 reached surge → 40 lost in
 * the UHT"). Independent sensors straddle the leg, so this does NOT collapse to
 * zero the way a single-vessel level balance would.
 *
 * Gated to the active-fill tank (issueMode === 'issue'): a tank that's draining
 * while a sibling fills isn't receiving milk, so an upward blip there isn't
 * arrival. Caveat: when a tank fills and drains at once, the net rise
 * under-counts arrival, so waste is a conservative UPPER bound on UHT loss.
 */
// How stale a Filler 1 meter sample may be before it stops counting as
// measured. Raw top-1 serves the last STORED sample, so a frozen historian
// collection would read measured:true forever — sampleAt is the guard.
const DRAIN_STALE_MAX_MS = 15 * 60 * 1000

// Max age of a batch's drain cursor before its spanned delta is re-seeded
// instead of credited. The credit gates (RunMode/latch) are evaluated at the
// CURRENT instant only — a delta spanning a long unobserved window (MES
// redeploy, frozen collection) could contain flush/CIP flow the gates exist
// to exclude, so never credit across a gap longer than a few ticks.
const DRAIN_GAP_MAX_MS = 15 * 60 * 1000

// Backward steps up to this are DECIMAL(14,2) round-trip noise (the cursor
// column stores 2 decimals; the historian serves the raw float) — treat as
// zero delta silently. The jitter warn is reserved for real backward steps.
const DRAIN_JITTER_EPS_GAL = 0.01

/**
 * One consistent per-tick view for the Filler 1 drain credit, built ONCE in
 * tickAllActiveBatches and shared by every batch's arrival pass. Latch
 * attribution (claimant/ambiguous) and the meter reading MUST come from a
 * single snapshot: per-batch snapshots taken seconds apart (NetSuite awaits
 * sit between batches) let a mid-tick Sel1 handoff show EACH tank as sole
 * claimant in its own view, double-crediting overlapping totalizer intervals.
 */
async function buildFiller1DrainContext(historian) {
  const none = { flow: null, claimantTankId: null, ambiguous: false }
  if (typeof historian.getFiller1InletFlow !== 'function') return none // un-updated provider → level-rise-only
  let statuses
  try {
    statuses = await historian.getSurgeTankStatus()
  } catch (err) {
    console.warn(`[SurgeTankMesService] drain context: getSurgeTankStatus failed — ${err.message}`)
    return none
  }
  const flow = await historian.getFiller1InletFlow() // never rejects (provider contract)
  const sel1 = (statuses || []).filter(s => (s.tankId === 'ST81' || s.tankId === 'ST82')
    && Array.isArray(s.fillerLines) && s.fillerLines.includes(1))
  const ambiguous = sel1.length > 1
  if (ambiguous && flow.measured) {
    console.warn("[SurgeTankMesService] drain: both ST81 and ST82 latched to Sel1 — this tick's meter flow is un-attributable (combined-flow ambiguity)")
  }
  return {
    flow,
    claimantTankId: sel1.length === 1 ? sel1[0].tankId : null,
    ambiguous,
  }
}

/**
 * Reset-tolerant, gated drain credit from the Filler 1 inlet meter
 * (TR11_FT1140, SD-708) for one arrival tick of one ST81/82 batch, computed
 * against the tick-shared drain context (single consistent latch view).
 *
 * Cursor discipline (mirrors the UHT issue cursor above): the cursor advances
 * on EVERY fresh measured read — the credit gates never hold it, so flow that
 * fails a gate is discarded, not deferred onto a later tick. Unmeasured or
 * stale reads HOLD the cursor; if the hold outlasts DRAIN_GAP_MAX_MS the next
 * good read RE-SEEDS instead of crediting (the instant-evaluated gates can't
 * vouch for a long unobserved span). Replay returns measured:false from the
 * provider override, which is the designed degradation.
 *
 * `fullyAccounted` = this tick's meter flow was measured, unambiguous, and
 * either credited or genuinely zero — the only ticks that may count toward
 * the drainFullyMetered waste certification. Ticks whose positive delta was
 * DISCARDED (RunMode off/unknown, claimant mismatch, gap re-seed, first-read
 * seed) are NOT fully accounted: gallons were dropped, so waste on this
 * batch remains an upper bound.
 */
function computeFiller1DrainForTick(batch, ctx, issueMode, issuedThisTick) {
  const none = { creditLbs: 0, newCursorGal: null, measured: false, ambiguous: false, running: null, deltaGal: 0, fullyAccounted: false }
  if (batch.tankId !== 'ST81' && batch.tankId !== 'ST82') return none // TR11 serves only the Sel1 leg
  const flow = ctx?.flow
  if (!flow || !flow.measured || !Number.isFinite(flow.totalizerGal) || flow.totalizerGal < 0) return none
  const sampleMs = flow.sampleAt ? Date.parse(flow.sampleAt) : NaN
  if (!Number.isFinite(sampleMs) || clock.now() - sampleMs > DRAIN_STALE_MAX_MS) return none

  const cur = flow.totalizerGal
  const cursor = batch.lastDrainTotalizerGal != null ? parseFloat(batch.lastDrainTotalizerGal) : null
  // First good read only seeds the cursor — never credit pre-batch history.
  if (cursor == null || !Number.isFinite(cursor)) {
    return { ...none, measured: true, running: flow.running, newCursorGal: cur }
  }

  // Gap guard: the cursor held through an unobserved window longer than a few
  // ticks — re-seed without crediting. Crediting here would apply the current
  // instant's RunMode/latch to flow that may have been flush/CIP mid-gap.
  const observedMs = batch.lastDrainObservedAt ? new Date(batch.lastDrainObservedAt).getTime() : NaN
  if (Number.isFinite(observedMs) && clock.now() - observedMs > DRAIN_GAP_MAX_MS) {
    const skipped = Math.max(0, cur - cursor)
    if (skipped > 0) {
      console.warn(`[SurgeTankMesService] drain ${batch.tankId}: cursor gap of ${Math.round((clock.now() - observedMs) / 60000)} min — re-seeding, skipping ${skipped.toFixed(1)} gal of unattributable flow`)
    }
    return { ...none, measured: true, running: flow.running, newCursorGal: cur }
  }

  let deltaGal
  if (cur >= cursor - DRAIN_JITTER_EPS_GAL) {
    deltaGal = Math.max(0, cur - cursor)
  } else if (cursor - cur > TOTALIZER_RESET_DROP_GAL) {
    // Genuine odometer reset (the meter is field-resettable; a controls-side
    // rename/typo fix would leave the same signature): post-reset value only.
    console.warn(`[SurgeTankMesService] drain ${batch.tankId}: Filler 1 totalizer reset (${cursor.toFixed(1)} → ${cur.toFixed(1)} gal) — crediting post-reset value only`)
    deltaGal = cur
  } else {
    // Sub-threshold backward step = jitter, not a reset (the WO1598 lesson):
    // hold the cursor, credit nothing.
    console.warn(`[SurgeTankMesService] drain ${batch.tankId}: Filler 1 totalizer jitter (${cursor.toFixed(2)} → ${cur.toFixed(2)} gal) — holding cursor`)
    return { ...none, measured: true, running: flow.running }
  }

  // Sole-claimant rule on the SHARED tick snapshot: exactly one of ST81/82 is
  // latched to Sel1 and it's this batch's tank. With both latched the meter
  // reads combined flow — advance the cursor, credit NEITHER (holding would
  // later dump both tanks' flow on one batch).
  const latched = ctx.claimantTankId === batch.tankId

  // Credit gates (cursor advances regardless). running false OR null discards:
  // a non-production window can hold flush/CIP flow — the probe saw ~13k gal
  // totalized with RunMode=0 — and holding would credit it later; discarding
  // under-credits, the safe direction.
  const credit = latched && !ctx.ambiguous && flow.running === true
    && issueMode === 'issue' && issuedThisTick && deltaGal > 0
  return {
    creditLbs: credit ? deltaGal * GAL_TO_LBS : 0,
    newCursorGal: cur,
    measured: true,
    ambiguous: ctx.ambiguous,
    running: flow.running,
    deltaGal,
    fullyAccounted: !ctx.ambiguous && (deltaGal === 0 || credit),
  }
}

async function tickArrivalForBatch(batch, historian, issueMode, issuedThisTick = false, drainCtx = null) {
  let statuses
  try {
    statuses = await historian.getSurgeTankStatus()
  } catch (err) {
    console.warn(`[SurgeTankMesService] arrival: getSurgeTankStatus failed — ${err.message}`)
    return
  }
  const st = (statuses || []).find(s => s.tankId === batch.tankId)
  if (!st) return

  const curLbs = (parseFloat(st.mainGallons) || 0) * GAL_TO_LBS
  const prevLbs = batch.lastDestLevelLbs != null ? parseFloat(batch.lastDestLevelLbs) : null
  if (!plausibleLevelLbs(curLbs, prevLbs)) return

  const updates = { lastDestLevelLbs: curLbs }

  // Concurrent fill+drain flag: this tick issued UHT milk (fill) AND a filler is
  // latched to the tank (Sel{N}=1). Under simultaneous fill+drain the net level
  // rise under-counts arrival, so the batch's eventual waste % is only a loose
  // upper bound. Conservative by design — the Sel latch holds for the whole run,
  // so this flags any fill that overlaps a connected filler, drawing or not.
  if (issuedThisTick && st.drainingToFiller) {
    const prevLines = String(batch.drainFillerLines || '').split(',').filter(Boolean)
    const merged = Array.from(new Set([...prevLines, ...st.fillerLines.map(String)]))
      .sort((a, b) => Number(a) - Number(b))
    updates.concurrentFillDrain = true
    updates.concurrentTickCount = (Number(batch.concurrentTickCount) || 0) + 1
    updates.drainFillerLines = merged.join(',')
    if (!batch.concurrentFillDrain) {
      console.warn(`[SurgeTankMesService] ${batch.tankId}: concurrent fill+drain — UHT filling while filler line(s) ${merged.join(',')} draw; waste % will be an upper bound`)
    }
  }

  // Metered Filler 1 drain (SD-708): reset-tolerant credit from the TR11
  // inlet meter, gated on Sel1 latch / sole claimant / RunMode / concurrent
  // issue — computed against the tick-shared drainCtx (single consistent
  // latch view; see buildFiller1DrainContext). Cursor + diagnostics persist
  // in the same batch.update() as the level baseline, so a failed persist
  // retries the whole tick atomically.
  const drain = computeFiller1DrainForTick(batch, drainCtx, issueMode, issuedThisTick)
  if (drain.newCursorGal != null) {
    updates.lastDrainTotalizerGal = drain.newCursorGal
    updates.lastDrainObservedAt = new Date(clock.now())
  }
  // Count only ticks whose meter flow was fully accounted (credited or
  // genuinely zero) — ticks with DISCARDED gallons must demote the
  // drainFullyMetered certification, not satisfy it.
  if (issuedThisTick && st.drainingToFiller && drain.fullyAccounted) {
    updates.meteredDrainTickCount = (Number(batch.meteredDrainTickCount) || 0) + 1
  }
  if (drain.creditLbs > 0) {
    updates.meteredDrainLbs = (parseFloat(batch.meteredDrainLbs) || 0) + drain.creditLbs
  }

  if (issueMode === 'issue' && prevLbs != null) {
    const rise = curLbs - prevLbs
    const issued = parseFloat(batch.cumulativeIssuedLbs) || 0
    const output = parseFloat(batch.cumulativeOutputLbs) || 0

    // Real track: the drain credit joins the SIGNED level rise only when the
    // flag is on. Signed matters — on a drain-only tick rise ≈ −drain, so the
    // sum self-cancels and the floor blocks a double count (drained product
    // was already credited when the level rose).
    const effectiveRise = rise + (config.MES_METERED_DRAIN ? drain.creditLbs : 0)
    if (effectiveRise > config.MES_WASTE_RISE_FLOOR_LBS) {
      // Clamp so output never exceeds issued (arrival over-read / sensor noise):
      // completed ≤ output ≤ issued at all times. Also bounds any non-product
      // flow the meter sees that slips past the RunMode gate.
      const next = Math.min(issued, output + effectiveRise)
      if (next > output) {
        updates.cumulativeOutputLbs = next
        console.log(`[SurgeTankMesService] arrival ${batch.tankId}: +${(next - output).toFixed(1)} lb reached (level ${prevLbs.toFixed(0)}→${curLbs.toFixed(0)}${config.MES_METERED_DRAIN && drain.creditLbs > 0 ? `, +${drain.creditLbs.toFixed(1)} lb drained` : ''}); output ${output.toFixed(0)}→${next.toFixed(0)} of issued ${issued.toFixed(0)}`)
      }
    }

    // Shadow track: identical floor+clamp math WITH the drain term, ALWAYS —
    // the dev-soak / prod-shadow comparator. Converges to cumulativeOutputLbs
    // while the flag is on; divergence there is a bug.
    const shadowPrev = batch.outputWithDrainLbs != null ? parseFloat(batch.outputWithDrainLbs) : output
    const shadowRise = rise + drain.creditLbs
    let shadowNext = shadowPrev
    if (shadowRise > config.MES_WASTE_RISE_FLOOR_LBS) {
      shadowNext = Math.max(shadowPrev, Math.min(issued, shadowPrev + shadowRise))
    }
    if (batch.outputWithDrainLbs == null || shadowNext !== shadowPrev) {
      updates.outputWithDrainLbs = shadowNext
    }
    if (drain.creditLbs > 0) {
      console.log(`[SurgeTankMesService] drain ${batch.tankId}: +${drain.creditLbs.toFixed(1)} lb metered (${drain.deltaGal.toFixed(1)} gal)${config.MES_METERED_DRAIN ? '' : ' [shadow]'}; level rise ${rise.toFixed(1)} → effective ${(rise + drain.creditLbs).toFixed(1)}`)
    }
  }
  await batch.update(updates)
}

async function tickAllActiveBatches(historian) {
  const activeBatches = await db.MesSurgeTankBatch.findAll({ where: { status: 'active' } })
  const summary = { batchesProcessed: 0, issuesFired: 0, completionsFired: 0, errors: [] }
  if (activeBatches.length === 0) return summary

  const issueModeByBatch = resolveIssueModes(activeBatches)

  // One drain context per tick, shared by every batch's arrival pass — latch
  // attribution and the meter reading must come from a single consistent
  // snapshot or a mid-tick Sel1 handoff double-credits (see
  // buildFiller1DrainContext).
  const drainCtx = await buildFiller1DrainContext(historian)

  for (const batch of activeBatches) {
    summary.batchesProcessed++
    const issueMode = issueModeByBatch[batch.id] || 'issue'
    let issuedThisTick = false
    try {
      issuedThisTick = await tickIssueForBatch(batch, historian, issueMode)
      if (issuedThisTick) summary.issuesFired++
    } catch (err) {
      console.error(`[SurgeTankMesService] tick issue failed for batch ${batch.id} (${batch.tankId}):`, err.message)
      summary.errors.push({ phase: 'issues', batchId: batch.id, error: err.message })
    }
    try {
      await batch.reload()
      // Measure arrival (surge level rise) → cumulativeOutputLbs before completing.
      await tickArrivalForBatch(batch, historian, issueMode, issuedThisTick, drainCtx)
      await batch.reload()
      const completed = await tickCompletionForBatch(batch)
      if (completed) summary.completionsFired++
    } catch (err) {
      console.error(`[SurgeTankMesService] tick completion failed for batch ${batch.id} (${batch.tankId}):`, err.message)
      summary.errors.push({ phase: 'completion', batchId: batch.id, error: err.message })
    }
  }

  return summary
}

function clearCaches() {
  _bomCache.clear()
}

const RETRYABLE_SURGE_STATUSES = ['pending_ns', 'error']

async function getAllBatches({ status, limit = 200 } = {}) {
  const where = {}
  if (status) {
    const statuses = String(status).split(',').map(s => s.trim()).filter(Boolean)
    if (statuses.length === 1) where.status = statuses[0]
    else if (statuses.length > 1) where.status = { [db.Sequelize.Op.in]: statuses }
  }
  const batches = await db.MesSurgeTankBatch.findAll({
    where,
    order: [['createdAt', 'DESC']],
    limit: Math.min(Number(limit) || 200, 500),
  })
  // Mark actively-stuck batches (NS issues failing back-to-back) so the
  // existing Surge Tank Review view can list them while they're stuck —
  // this failure class previously never touched status/errorMessage and
  // sailed under every review surface (the WO2060 incident).
  const rows = batches.map(b => {
    const j = b.toJSON()
    j.stuck = b.status === 'active'
      && (Number(b.consecutiveIssueFailures) || 0) >= STUCK_ISSUE_FAILURE_THRESHOLD
    return j
  })
  return { success: true, batches: rows }
}

async function retrySurgeBatch(id, { nsItemId, decidedBy } = {}) {
  const batch = await db.MesSurgeTankBatch.findByPk(id)
  if (!batch) throw new Error(`Batch ${id} not found`)
  if (!RETRYABLE_SURGE_STATUSES.includes(batch.status)) {
    throw new Error(`Batch ${id} has status '${batch.status}' — only ${RETRYABLE_SURGE_STATUSES.join('/')} are retryable`)
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

  const sourceEntity = batch.feedingFromEntName || null
  const body = {
    assemblyItem: { id: Number(itemId) },
    quantity: 1,
    location: { id: 30 },
    subsidiary: { id: 3 },
    isWip: true,
    custbody_liquid_milk_wo: true,
    custbody_mes_tank_id: batch.tankId,
    custbody_mes_product_name: batch.productName,
    custbody_mes_source_entity: sourceEntity,
    custbody_mes_dest_entity: batch.tankId,
  }
  if (batch.componentItemId) {
    body.item = { items: [{ item: { id: Number(batch.componentItemId) }, quantity: 1 }] }
  }

  try {
    const nsResult = await core.netsuitePost('/record/v1/workOrder', body)

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
          console.warn(`[SurgeTankMesService] retry: could not fetch WO details: ${e.message}`)
        }
      }
    }

    await batch.update({ nsWorkOrderId, nsWorkOrderNumber, status: 'active', errorMessage: null })
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_wo_retry', sourceId: `${batch.tankId}:${batch.productName}`,
      nsTransactionType: 'workOrder', nsTransactionId: nsWorkOrderId,
      payload: JSON.stringify({ batchId: id, nsItemId, decidedBy }),
      result: JSON.stringify({ nsWorkOrderId, nsWorkOrderNumber }), success: true,
    })
    console.log(`[SurgeTankMesService] retry: "${batch.productName}" on ${batch.tankId} → NS WO ${nsWorkOrderNumber} (${nsWorkOrderId})`)
    await batch.reload()
    return { success: true, batch }
  } catch (err) {
    console.error(`[SurgeTankMesService] retry: failed for batch ${id}:`, err.message)
    await batch.update({ status: 'error', errorMessage: err.message })
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_wo_retry', sourceId: `${batch.tankId}:${batch.productName}`,
      nsTransactionType: 'workOrder',
      payload: JSON.stringify({ batchId: id, nsItemId, decidedBy }),
      success: false, errorMessage: err.message,
    })
    await batch.reload()
    return { success: false, batch, error: err.message }
  }
}

async function rejectSurgeBatch(id, { decidedBy, reason } = {}) {
  const batch = await db.MesSurgeTankBatch.findByPk(id)
  if (!batch) throw new Error(`Batch ${id} not found`)
  if (!RETRYABLE_SURGE_STATUSES.includes(batch.status)) {
    throw new Error(`Batch ${id} has status '${batch.status}' — only ${RETRYABLE_SURGE_STATUSES.join('/')} can be rejected`)
  }
  const msg = [decidedBy ? `Rejected by ${decidedBy}` : 'Rejected', reason].filter(Boolean).join(': ')
  await batch.update({ status: 'rejected', errorMessage: msg })
  await batch.reload()
  return { success: true, batch }
}

function getSurgeProductOptions() {
  const byNsId = new Map()
  for (const [name, nsId] of Object.entries(productParser.FG_ITEM_MAP)) {
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

module.exports = {
  processWOStart,
  processWOEnd,
  tickIssueForBatch,
  tickCompletionForBatch,
  tickAllActiveBatches,
  resolveSurgeTankComponent,
  getAllBatches,
  retrySurgeBatch,
  rejectSurgeBatch,
  getSurgeProductOptions,
  clearCaches,
  STUCK_ISSUE_FAILURE_THRESHOLD,
}
