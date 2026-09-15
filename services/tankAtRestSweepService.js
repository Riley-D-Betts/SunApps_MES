/**
 * Tank-at-rest inventory reconciliation sweep.
 *
 * Every 5 min, walks the M-silos, C-silos, and blend tanks. For each tank
 * that has no live flow movement during the window, computes the 5-min
 * average level in lbs and reconciles the WHOLE NS bin to physical reality
 * (inventoryAdjustmentService.reconcileBinToPhysical): the bin is driven to
 * hold EXACTLY the current product at the measured weight and ZERO of every
 * other item, with no negative balance of any item. The current product's leg
 * keeps the 500-lb sensor-noise threshold; stale/wrong-product and negative
 * legs are always cleared. When the current product can't be identified the
 * bin is zeroed out entirely.
 *
 * Silos are swept between batches to pre-fund the NS bin before the next
 * blend WO starts issuing from it. During an active blend batch the silo
 * is in live flow (siloName set on the milk line) so it is skipped here;
 * the blend tick's WO issues handle consumption accounting at that point.
 *
 * Blend tanks are only swept BETWEEN WOs (active batches are skipped); the
 * regular blend tank tick handles motion-driven inventory while a WO is
 * running. Surge tanks are out of scope — UHT/surge production is
 * continuous and doesn't have meaningful at-rest windows.
 *
 * Active surge batches are guarded too (SD-722): the silo / blend tank bin an
 * open surge WO is pinned to is skipped until that batch closes.
 *
 * Separations are guarded too: a silo that is the source or a destination of a
 * RUNNING separation batch is skipped (separator flow isn't on the milk lines,
 * and the unbuild posts at close — sweeping mid-run would double-count).
 *
 * Tanks-at-rest have +/- ~800 lbs of sensor noise, which is why we average
 * across the window instead of using a single instantaneous read.
 */
const itemConfig = require('./mesItemConfig')
const inventoryAdjustment = require('./inventoryAdjustmentService')
const db = require('../models')

const AT_REST_WINDOW_MS = 5 * 60 * 1000
const MIN_DELTA_LBS = 500
// Peak-to-peak level swing (max - min across the 5-min sample window) above
// which we treat the tank as in motion and skip the sweep. ±~800 lb of
// sensor noise on a truly idle tank is documented elsewhere, so 2000 lb
// peak-to-peak comfortably exceeds noise while catching real fill/drain.
const AT_REST_RANGE_LBS = 2000

// Tag suffix mapping. M/C silos write live lbs to the underscore-suffix tag
// (e.g. MSilo1_LBS.Value); blend tanks write to <tank>.100LT.SCL_LBS.
function siloLbsFqn(siloId) {
  return `${siloId}_LBS.Value`
}

function blendTankLbsFqn(tankId) {
  return `${tankId}.100LT.SCL_LBS`
}

function avg(arr) {
  if (!arr || arr.length === 0) return null
  let sum = 0
  for (const v of arr) sum += v
  return sum / arr.length
}

function normName(s) {
  return typeof s === 'string' ? s.trim() : ''
}

/**
 * Collect the set of tank / silo names that are currently in live flow on
 * any milk line, using only the live tags (siloName, requestedBy). MEM*
 * latch tags (memSiloName, memRequestedBy) are intentionally excluded:
 * they hold the last flow's source/dest indefinitely after flow ends and
 * would permanently pin recently-used silos in the skip set, preventing
 * the sweep from pre-funding those silo bins before the next batch.
 * Tanks that just stopped flowing within the window are caught by the
 * AT_REST_RANGE_LBS range check instead.
 */
function collectActiveRoutes(milkLines) {
  const set = new Set()
  for (const line of milkLines || []) {
    const candidates = [line.siloName, line.requestedBy]
    for (const c of candidates) {
      const n = normName(c)
      if (n) set.add(n)
      const canonical = itemConfig.normalizeSiloName(n)
      if (canonical) set.add(canonical)
    }
  }
  return set
}

/**
 * Source + destination silos of every RUNNING separation batch. Separator flow
 * doesn't appear on the milk lines (collectActiveRoutes can't see it), and the
 * unbuild posts at batch close — so sweeping a silo mid-separation reconciles
 * against an NS bin the unbuild hasn't touched yet, then the close-time unbuild
 * adjusts it again (double-count). Skip those silos until the batch closes.
 */
async function collectActiveSeparationSilos() {
  const set = new Set()
  const add = (name) => {
    const n = normName(name)
    if (n) set.add(n)
    const canonical = itemConfig.normalizeSiloName(n)
    if (canonical) set.add(canonical)
  }
  let running = []
  try {
    running = await db.MesSeparationBatch.findAll({
      where: { status: 'running' },
      attributes: ['sourceSilo', 'destinations', 'prevDestinationsJson'],
      raw: true,
    })
  } catch (err) {
    console.warn(`[TankAtRestSweep] active-separation lookup failed: ${err.message.slice(0, 200)}`)
    return set
  }
  for (const b of running) {
    add(b.sourceSilo)
    try {
      const d = b.destinations ? JSON.parse(b.destinations) : null
      for (const r of (Array.isArray(d?.resolved) ? d.resolved : [])) { add(r?.silo); add(r?.raw) }
      for (const raw of (Array.isArray(d?.raw) ? d.raw : [])) add(raw)
    } catch { /* malformed destinations → rely on sourceSilo */ }
    try {
      const pd = b.prevDestinationsJson ? JSON.parse(b.prevDestinationsJson) : null
      for (const raw of (Array.isArray(pd) ? pd : [])) add(raw)
    } catch { /* ignore */ }
  }
  return set
}

/**
 * Source bins pinned by ACTIVE surge batches (SD-722). A surge WO issues its
 * pinned component from componentBinId every tick for as long as the batch is
 * open — but the UHT only shows up as a live route while it is in PROCESS with
 * a fromEntName, and the silo→TSTAT→UHT bypass has NO fromEntName at all, so
 * between line reads the source silo looked "at rest". The sweep then drove the
 * bin to the level reading while the surge shortfall bump drove it back up:
 * 1,018 sweep legs (−41.9M lb) vs 1,353 shortfall bumps (+84.7M lb) in 30 days.
 * Skip any silo / blend tank whose bin (or feeding entity) an active surge
 * batch holds until that batch closes. Mirrors collectActiveSeparationSilos.
 */
async function collectActiveSurgeSourceTanks() {
  const set = new Set()
  const add = (name) => {
    const n = normName(name)
    if (!n) return
    set.add(n)
    const canonical = itemConfig.normalizeSiloName(n)
    if (canonical) set.add(canonical)
  }
  const binToTank = {}
  for (const [tank, bin] of Object.entries({ ...itemConfig.SILO_BIN_MAP, ...itemConfig.TANK_BIN_MAP })) {
    binToTank[String(bin)] = tank
  }
  let active = []
  try {
    active = await db.MesSurgeTankBatch.findAll({
      where: { status: 'active' },
      attributes: ['id', 'componentBinId', 'feedingFromEntName'],
      raw: true,
    })
  } catch (err) {
    // Fail CLOSED would stop every sweep on a DB blip; fail open matches the
    // separation guard. The shortfall breaker bounds any resulting churn.
    console.warn(`[TankAtRestSweep] active-surge lookup failed: ${err.message.slice(0, 200)}`)
    return set
  }
  for (const b of active) {
    if (b.componentBinId != null && binToTank[String(b.componentBinId)]) add(binToTank[String(b.componentBinId)])
    add(b.feedingFromEntName)
  }
  return set
}

/**
 * Average lbs over the 5-min window via the historian's time-series query.
 * Falls back to liveLbs when the window is empty (e.g. ProcessValues
 * caching delay) so we still have a value to compare against NS.
 */
async function readAvgLbs(historian, fqn, windowStart, windowEnd, liveLbs) {
  try {
    const samples = await historian._queryProcessValues(fqn, windowStart, windowEnd, { verbose: false })
    const values = (samples || [])
      .map(s => Number(s?.Value))
      .filter(v => Number.isFinite(v) && v >= 0)
    if (values.length >= 2) {
      const minLbs = Math.min(...values)
      const maxLbs = Math.max(...values)
      return {
        avgLbs: avg(values),
        minLbs,
        maxLbs,
        rangeLbs: maxLbs - minLbs,
        sampleCount: values.length,
        source: 'historian-window',
      }
    }
    if (values.length === 1) {
      return { avgLbs: values[0], minLbs: values[0], maxLbs: values[0], rangeLbs: 0, sampleCount: 1, source: 'historian-single' }
    }
  } catch (err) {
    console.warn(`[TankAtRestSweep] _queryProcessValues failed for ${fqn}: ${err.message.slice(0, 200)}`)
  }
  if (Number.isFinite(liveLbs) && liveLbs >= 0) {
    return { avgLbs: liveLbs, minLbs: liveLbs, maxLbs: liveLbs, rangeLbs: 0, sampleCount: 0, source: 'live-fallback' }
  }
  return null
}

async function sweepSilo({ silo, activeRoutes, activeSeparationSilos, activeSurgeSources, historian, windowStart, windowEnd }) {
  const tankName = silo.siloId
  if (activeRoutes.has(tankName)) {
    return { tankName, skipped: 'active-route' }
  }
  // Source bin of an open surge WO — its issues draw from here every tick.
  if (activeSurgeSources && activeSurgeSources.has(tankName)) {
    return { tankName, skipped: 'active-surge-source' }
  }
  // Source/destination of a running separation — its unbuild posts at close, so
  // sweeping now would double-count against it.
  if (activeSeparationSilos && activeSeparationSilos.has(tankName)) {
    return { tankName, skipped: 'active-separation' }
  }

  const binId = itemConfig.SILO_BIN_MAP[tankName]
  if (!binId) {
    return { tankName, skipped: 'no-bin-mapping' }
  }

  // Silos are product-flexible — any silo can hold any milk or cream, raw or
  // separated — so the static SILO_ITEM_MAP cannot say what's actually in the
  // silo. Resolve the CURRENT item from the LIVE Standardization HMI product
  // index (IndexSelectRead, surfaced as silo.productIndex by getSiloStatus),
  // exactly as the separation unbuild does (getItemByProductIndex). When the
  // index yields no NS item the product is unidentified — the full-bin reconcile
  // then drives the bin to 0 (zero-everything-when-unknown), so we no longer
  // skip here.
  const item = itemConfig.getItemByProductIndex(silo.productIndex)
  const currentItemId = item?.id || null

  const reading = await readAvgLbs(historian, siloLbsFqn(tankName), windowStart, windowEnd, silo.lbs)
  // No level reading at all → don't reconcile. Zeroing a bin off a missing
  // sensor read would wipe real stock.
  if (!reading) return { tankName, skipped: 'no-level-samples' }
  if (reading.rangeLbs > AT_REST_RANGE_LBS) {
    return { tankName, skipped: 'in-motion', rangeLbs: reading.rangeLbs }
  }

  console.log(`[TankAtRestSweep] ${tankName}: observed ${reading.avgLbs.toFixed(0)} lb (${reading.source}, n=${reading.sampleCount}), current item ${currentItemId || 'unidentified'} "${item?.name || ''}" (idx ${silo.productIndex}) → full-bin reconcile`)
  const result = await inventoryAdjustment.reconcileBinToPhysical({
    binId,
    currentItemId,
    targetQty: reading.avgLbs,
    currentItemThreshold: MIN_DELTA_LBS,
    tankName,
    source: 'sweep',
    observedLbs: reading.avgLbs,
    productIndex: silo.productIndex,
  })
  if (result.skipped) return { tankName, skipped: result.skipped }
  return {
    tankName,
    reconciled: true,
    adjustedCount: result.adjusted,
    failedCount: result.failed,
    currentItemId,
    productIndex: silo.productIndex,
    legs: result.legs,
  }
}

async function sweepBlendTank({ tank, activeRoutes, activeSurgeSources, historian, windowStart, windowEnd }) {
  const tankName = tank.tankId
  if (activeRoutes.has(tankName)) {
    return { tankName, skipped: 'active-route' }
  }
  if (activeSurgeSources && activeSurgeSources.has(tankName)) {
    return { tankName, skipped: 'active-surge-source' }
  }

  const binId = itemConfig.TANK_BIN_MAP[tankName]
  if (!binId) return { tankName, skipped: 'no-bin-mapping' }

  const activeBatch = await db.MesBlendTankBatch.findOne({
    where: { tankId: tankName, status: 'active' },
  })
  if (activeBatch) {
    return { tankName, skipped: 'wo-active' }
  }

  // Pull the most-recent completed batch so we know which NS item the residual
  // product is, and which WO number to attach a fresh lot to if NS has no lot in
  // this bin. A genuine "no completed batch yet" → currentItemId null → the
  // full-bin reconcile zeroes whatever NS thinks is there. A DB error, though,
  // must SKIP (don't zero a stocked tank off a failed query).
  let lastBatch
  try {
    lastBatch = await db.MesBlendTankBatch.findOne({
      where: { tankId: tankName, status: 'completed' },
      order: [['completedAt', 'DESC']],
    })
  } catch (err) {
    console.warn(`[TankAtRestSweep] ${tankName}: last-batch lookup failed: ${err.message.slice(0, 200)}`)
    return { tankName, skipped: 'last-batch-lookup-failed' }
  }

  const currentItemId = lastBatch?.mesItem || null
  const lastWoNumber = lastBatch?.nsWorkOrderNumber || null

  const reading = await readAvgLbs(historian, blendTankLbsFqn(tankName), windowStart, windowEnd, tank.weightLbs)
  if (!reading) return { tankName, skipped: 'no-level-samples' }
  if (reading.rangeLbs > AT_REST_RANGE_LBS) {
    return { tankName, skipped: 'in-motion', rangeLbs: reading.rangeLbs }
  }

  console.log(`[TankAtRestSweep] ${tankName}: observed ${reading.avgLbs.toFixed(0)} lb (${reading.source}, n=${reading.sampleCount}), current item ${currentItemId || 'unidentified'} (last WO ${lastWoNumber || 'n/a'}) → full-bin reconcile`)
  const result = await inventoryAdjustment.reconcileBinToPhysical({
    binId,
    currentItemId,
    targetQty: reading.avgLbs,
    currentItemThreshold: MIN_DELTA_LBS,
    lastWoNumber,
    tankName,
    source: 'sweep',
    observedLbs: reading.avgLbs,
  })
  if (result.skipped) return { tankName, skipped: result.skipped }
  return {
    tankName,
    reconciled: true,
    adjustedCount: result.adjusted,
    failedCount: result.failed,
    currentItemId,
    legs: result.legs,
  }
}

let lastPollTime = new Date()

async function tick(historian) {
  if (!historian) {
    console.warn('[TankAtRestSweep] No historian provider — skipping tick')
    return { skipped: 'no-historian' }
  }

  const windowEnd = new Date()
  const windowStart = new Date(windowEnd.getTime() - AT_REST_WINDOW_MS)

  let siloStatus = []
  let blendTankStatus = []
  let milkLines = []
  let uhtStatus = []
  try {
    ;[siloStatus, blendTankStatus, milkLines, uhtStatus] = await Promise.all([
      historian.getSiloStatus().catch(err => { console.warn(`[TankAtRestSweep] getSiloStatus failed: ${err.message}`); return [] }),
      historian.getBlendTankStatus().catch(err => { console.warn(`[TankAtRestSweep] getBlendTankStatus failed: ${err.message}`); return [] }),
      historian.getMilkLineStatus().catch(err => { console.warn(`[TankAtRestSweep] getMilkLineStatus failed: ${err.message}`); return [] }),
      historian.getUhtStatus().catch(err => { console.warn(`[TankAtRestSweep] getUhtStatus failed: ${err.message}`); return [] }),
    ])
  } catch (err) {
    console.error('[TankAtRestSweep] Snapshot fetch threw:', err.message)
    return { error: err.message }
  }

  const activeRoutes = collectActiveRoutes(milkLines)
  // UHTs in PROCESS mode are pulling product from their fromEntName (a blend
  // tank or silo). Even though no MILK LINE carries that flow, the source
  // tank is in motion and must not be swept while the UHT is consuming.
  for (const u of uhtStatus || []) {
    if (u?.mode === 'PROCESS' && u.fromEntName) {
      const n = normName(u.fromEntName)
      if (n) activeRoutes.add(n)
      const canonical = itemConfig.normalizeSiloName(n)
      if (canonical) activeRoutes.add(canonical)
    }
  }

  // Silos feeding or receiving a running separation — skip until its unbuild posts.
  const activeSeparationSilos = await collectActiveSeparationSilos()
  // Silos / blend tanks an open surge WO is issuing from (SD-722).
  const activeSurgeSources = await collectActiveSurgeSourceTanks()

  const siloResults = []
  for (const silo of siloStatus) {
    try {
      const r = await sweepSilo({ silo, activeRoutes, activeSeparationSilos, activeSurgeSources, historian, windowStart, windowEnd })
      siloResults.push(r)
    } catch (err) {
      console.error(`[TankAtRestSweep] sweepSilo ${silo.siloId} threw: ${err.message}`)
      siloResults.push({ tankName: silo.siloId, error: err.message })
    }
  }

  const blendResults = []
  for (const tank of blendTankStatus) {
    try {
      const r = await sweepBlendTank({ tank, activeRoutes, activeSurgeSources, historian, windowStart, windowEnd })
      blendResults.push(r)
    } catch (err) {
      console.error(`[TankAtRestSweep] sweepBlendTank ${tank.tankId} threw: ${err.message}`)
      blendResults.push({ tankName: tank.tankId, error: err.message })
    }
  }

  const all = [...siloResults, ...blendResults]
  // Each reconciled tank fans out into multiple per-item legs; sum the leg
  // counts so the summary reflects actual adjustments posted, not tanks touched.
  const reconciled = all.filter(r => r.reconciled)
  const adjustments = reconciled.filter(r => (r.adjustedCount || 0) > 0)
  const failures = reconciled.filter(r => (r.failedCount || 0) > 0)
  const legsAdjusted = reconciled.reduce((s, r) => s + (r.adjustedCount || 0), 0)
  const legsFailed = reconciled.reduce((s, r) => s + (r.failedCount || 0), 0)
  const skipped = all.filter(r => r.skipped)
  console.log(`[TankAtRestSweep] Sweep complete: ${reconciled.length} tanks reconciled (${legsAdjusted} legs ok, ${legsFailed} legs failed), ${skipped.length} skipped`)
  if (skipped.length > 0) {
    const grouped = skipped.reduce((m, r) => { m[r.skipped] = (m[r.skipped] || 0) + 1; return m }, {})
    console.log(`[TankAtRestSweep] Skip reasons: ${JSON.stringify(grouped)}`)
  }

  lastPollTime = new Date()
  return { adjustments, failures, skipped, legsAdjusted, legsFailed }
}

function getLastPollTime() {
  return lastPollTime
}

module.exports = {
  tick,
  collectActiveSurgeSourceTanks,
  getLastPollTime,
  AT_REST_WINDOW_MS,
  MIN_DELTA_LBS,
}
