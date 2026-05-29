/**
 * Tank-at-rest inventory reconciliation sweep.
 *
 * Every 5 min, walks the M-silos, C-silos, and blend tanks. For each tank
 * that has had no flow movement during the window, computes the 5-min
 * average level in lbs, compares it to NS bin (and lot, for blend tanks)
 * on-hand, and posts a signed inventory adjustment when |delta| >= 500 lb.
 *
 * Surge tanks are out of scope — UHT/surge production is continuous and
 * doesn't have meaningful at-rest windows. Lot-tracked blend tanks are
 * only swept BETWEEN WOs (active batches are skipped); the regular blend
 * tank tick handles motion-driven inventory while a WO is running.
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
 * Collect the set of tank / silo names that any milk line has touched as
 * either source (siloName / memSiloName) or destination (requestedBy /
 * memRequestedBy) in the current snapshot. The MEM* tags latch the most
 * recent flow's source/dest even after the live tags clear, so they cover
 * tanks that just stopped flowing within the window.
 */
function collectActiveRoutes(milkLines) {
  const set = new Set()
  for (const line of milkLines || []) {
    const candidates = [line.siloName, line.memSiloName, line.requestedBy, line.memRequestedBy]
    for (const c of candidates) {
      const n = normName(c)
      if (n) set.add(n)
      const canonical = itemConfig.normalizeSiloName(n)
      if (canonical) set.add(canonical)
    }
    // Active flow on the line itself doesn't pin a tank by name alone, but the
    // siloName + requestedBy fields above already do.
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

async function sweepSilo({ silo, activeRoutes, historian, windowStart, windowEnd }) {
  const tankName = silo.siloId
  if (activeRoutes.has(tankName)) {
    return { tankName, skipped: 'active-route' }
  }

  const item = itemConfig.SILO_ITEM_MAP[tankName]
  const binId = itemConfig.SILO_BIN_MAP[tankName]
  if (!item?.id || !binId) {
    return { tankName, skipped: 'no-item-or-bin-mapping' }
  }

  const reading = await readAvgLbs(historian, siloLbsFqn(tankName), windowStart, windowEnd, silo.lbs)
  if (!reading) return { tankName, skipped: 'no-level-samples' }
  if (reading.rangeLbs > AT_REST_RANGE_LBS) {
    return { tankName, skipped: 'in-motion', rangeLbs: reading.rangeLbs }
  }

  const nsQty = await inventoryAdjustment.getBinQtyOnHand(item.id, binId)
  const delta = reading.avgLbs - nsQty
  if (Math.abs(delta) < MIN_DELTA_LBS) {
    return { tankName, skipped: 'below-threshold', delta }
  }

  console.log(`[TankAtRestSweep] ${tankName}: observed ${reading.avgLbs.toFixed(0)} lb (${reading.source}, n=${reading.sampleCount}), NS ${nsQty.toFixed(0)} lb → Δ ${delta.toFixed(0)} lb`)
  const result = await inventoryAdjustment.submitInventoryAdjustment({
    binId,
    itemId: item.id,
    qtyDelta: delta,
    source: 'sweep',
    tankName,
    observedLbs: reading.avgLbs,
    nsQtyBefore: nsQty,
    memo: `Sweep: ${tankName} 5-min avg ${reading.avgLbs.toFixed(0)} vs NS ${nsQty.toFixed(0)} lb`,
  })
  return { tankName, adjusted: !!result?.ok, failed: !result?.ok, delta, ...result }
}

async function sweepBlendTank({ tank, activeRoutes, historian, windowStart, windowEnd }) {
  const tankName = tank.tankId
  if (activeRoutes.has(tankName)) {
    return { tankName, skipped: 'active-route' }
  }

  const binId = itemConfig.TANK_BIN_MAP[tankName]
  if (!binId) return { tankName, skipped: 'no-bin-mapping' }

  const activeBatch = await db.MesBlendTankBatch.findOne({
    where: { tankId: tankName, status: 'active' },
  })
  if (activeBatch) {
    return { tankName, skipped: 'wo-active' }
  }

  // Pull the most-recent completed batch so we know which NS item the
  // residual product is, and which WO number to attach a fresh lot to if
  // NS has no existing lot in this bin.
  const lastBatch = await db.MesBlendTankBatch.findOne({
    where: { tankId: tankName, status: 'completed' },
    order: [['completedAt', 'DESC']],
  })
  if (!lastBatch || !lastBatch.mesItem) {
    return { tankName, skipped: 'no-last-wo-context' }
  }

  const itemId = lastBatch.mesItem
  const lastWoNumber = lastBatch.nsWorkOrderNumber || null

  const reading = await readAvgLbs(historian, blendTankLbsFqn(tankName), windowStart, windowEnd, tank.weightLbs)
  if (!reading) return { tankName, skipped: 'no-level-samples' }
  if (reading.rangeLbs > AT_REST_RANGE_LBS) {
    return { tankName, skipped: 'in-motion', rangeLbs: reading.rangeLbs }
  }

  const nsQty = await inventoryAdjustment.getBinQtyOnHand(itemId, binId)
  const delta = reading.avgLbs - nsQty
  if (Math.abs(delta) < MIN_DELTA_LBS) {
    return { tankName, skipped: 'below-threshold', delta }
  }

  console.log(`[TankAtRestSweep] ${tankName}: observed ${reading.avgLbs.toFixed(0)} lb (${reading.source}, n=${reading.sampleCount}), NS ${nsQty.toFixed(0)} lb (item ${itemId}, last WO ${lastWoNumber || 'n/a'}) → Δ ${delta.toFixed(0)} lb`)
  const result = await inventoryAdjustment.submitInventoryAdjustment({
    binId,
    itemId,
    qtyDelta: delta,
    source: 'sweep',
    tankName,
    observedLbs: reading.avgLbs,
    nsQtyBefore: nsQty,
    lastWoNumber,
    memo: `Sweep: ${tankName} 5-min avg ${reading.avgLbs.toFixed(0)} vs NS ${nsQty.toFixed(0)} lb (item ${itemId})`,
  })
  return { tankName, adjusted: !!result?.ok, failed: !result?.ok, delta, ...result }
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

  const siloResults = []
  for (const silo of siloStatus) {
    try {
      const r = await sweepSilo({ silo, activeRoutes, historian, windowStart, windowEnd })
      siloResults.push(r)
    } catch (err) {
      console.error(`[TankAtRestSweep] sweepSilo ${silo.siloId} threw: ${err.message}`)
      siloResults.push({ tankName: silo.siloId, error: err.message })
    }
  }

  const blendResults = []
  for (const tank of blendTankStatus) {
    try {
      const r = await sweepBlendTank({ tank, activeRoutes, historian, windowStart, windowEnd })
      blendResults.push(r)
    } catch (err) {
      console.error(`[TankAtRestSweep] sweepBlendTank ${tank.tankId} threw: ${err.message}`)
      blendResults.push({ tankName: tank.tankId, error: err.message })
    }
  }

  const all = [...siloResults, ...blendResults]
  const adjustments = all.filter(r => r.adjusted)
  const failures = all.filter(r => r.failed)
  const skipped = all.filter(r => r.skipped)
  console.log(`[TankAtRestSweep] Sweep complete: ${adjustments.length} ok, ${failures.length} failed, ${skipped.length} skipped`)
  if (skipped.length > 0) {
    const grouped = skipped.reduce((m, r) => { m[r.skipped] = (m[r.skipped] || 0) + 1; return m }, {})
    console.log(`[TankAtRestSweep] Skip reasons: ${JSON.stringify(grouped)}`)
  }

  lastPollTime = new Date()
  return { adjustments, failures, skipped }
}

function getLastPollTime() {
  return lastPollTime
}

module.exports = {
  tick,
  getLastPollTime,
  AT_REST_WINDOW_MS,
  MIN_DELTA_LBS,
}
