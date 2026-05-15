const surgeTankMesService = require('../services/surgeTankMesService')
const notifyService = require('../services/notifyService')
const statusStore = require('../services/statusStore')

const EMPTY_THRESHOLD_GAL = 10
// Minimum batch lifetime before the "tank emptied" END can fire. Prevents a
// false end when the ST reads 0 at the start of a fill (sterile prep) before
// any real product has landed.
const MIN_BATCH_DURATION_MS = 120_000
// Per-tick gal-delta floor — below this we treat the change as sensor noise
// rather than real inflow. Matches the equipmentJob fill-noise floor.
const FILL_NOISE_GAL = 5
// Consecutive ticks of confirmed fill required before a WO START fires.
// At a 10s cron, 5 ticks ≈ 50s of sustained inflow. The gate combines this
// with UHT phase ("Sterile on Product") — both conditions must hold per tick,
// any miss resets the counter to 0.
const FILL_TICKS_FOR_START = 5
const STERILE_ON_PRODUCT_STEP = 'Sterile on Product'

// Sentinel productDesc values that look like real strings to the historian
// but are not real product names. The PLC and operator entries can write any
// of these to indicate "not in production"; treating any as a product
// false-starts a WO. Compare lowercase so we catch case variants.
const PRODUCT_SENTINELS = new Set(['', 'none', 'empty', 'cip', 'water', 'sterile', 'n/a', '-', '--'])

function validStr(val) {
  if (val == null) return null
  const trimmed = String(val).trim()
  if (!trimmed) return null
  if (PRODUCT_SENTINELS.has(trimmed.toLowerCase())) return null
  return val
}

// Tank is in CIP and not eligible to start a batch. state === 4 is the
// confirmed CIP code (per SURGE_STATE_NAMES on the dashboard). Do NOT gate
// on sterProdBarrOK — that's a plumbing/valve indicator, not a sterility
// signal, and the tank can legitimately hold sterile product with it false.
function isCipMode(status) {
  return status?.state === 4
}

// UHT is actively pushing sterile product into a surge tank. PROCESS step 24
// ("Sterile on Product") is the authoritative "real production" signal.
function isUhtSterileOnProduct(uhtStatus) {
  return uhtStatus?.mode === 'PROCESS' && uhtStatus?.stepName === STERILE_ON_PRODUCT_STEP
}

function blankTankState() {
  return {
    productName: null,
    batchActive: false,
    seeded: false,
    batchStartedAt: null,
    feedingUhtId: null,
    feedingFromEntName: null,
    fillTickCount: 0,
    lastGallonsForDelta: null,
  }
}

const tankState = {
  ST81: blankTankState(),
  ST82: blankTankState(),
  ST83: blankTankState(),
  ST84: blankTankState(),
}

let lastPollTime = new Date()

/**
 * Restore in-memory tankState from any 'active' MesSurgeTankBatch rows so a
 * service restart picks up where it left off — no false starts (a returning
 * product looks unchanged) and no orphaned active rows in the DB (a cleared
 * or changed product still fires the correct END).
 *
 * DB is authoritative: if the live product on the next poll differs from the
 * hydrated value, the normal product-change branch fires END for the stale
 * batch and START for the new one. That's correct: it closes the old WO and
 * opens a fresh one matching the operator's current intent.
 */
async function hydrateFromDb(MesSurgeTankBatch) {
  try {
    const rows = await MesSurgeTankBatch.findAll({
      where: { status: 'active' },
      order: [['detectedAt', 'DESC']],
    })
    const newestByTank = {}
    for (const r of rows) {
      if (!newestByTank[r.tankId]) newestByTank[r.tankId] = r
    }
    for (const tankId of Object.keys(tankState)) {
      const row = newestByTank[tankId]
      if (!row) continue
      tankState[tankId].productName = row.productName
      tankState[tankId].batchActive = true
      tankState[tankId].seeded = true
      tankState[tankId].batchStartedAt = row.detectedAt ? new Date(row.detectedAt).getTime() : Date.now()
      tankState[tankId].feedingUhtId = row.feedingUhtId || null
      tankState[tankId].feedingFromEntName = row.feedingFromEntName || null
      console.log(`[SurgeTankJob] Hydrated ${tankId} from DB: "${row.productName}" (active since ${row.detectedAt})`)
    }
    console.log(`[SurgeTankJob] Hydrated tankState from ${rows.length} active row(s)`)
    return rows.length
  } catch (err) {
    console.error('[SurgeTankJob] Hydration failed:', err.message)
    return 0
  }
}

/**
 * Resolve which UHT is currently feeding a given surge tank.
 * UHT1 is plumbed to ST81/ST82; UHT2 to ST83/ST84 — the Connection_Code tags
 * confirm the live state. Returns null if no UHT shows this ST connected.
 */
function resolveFeedingUht(tankId, routing) {
  for (const [uhtId, connectedSts] of Object.entries(routing || {})) {
    if (Array.isArray(connectedSts) && connectedSts.includes(tankId)) {
      return uhtId
    }
  }
  return null
}

async function run(historian) {
  const pollStart = Date.now()
  try {
    const statuses = await historian.getSurgeTankStatus()
    const routing = await historian.getUhtSurgeTankRouting().catch(err => {
      console.warn(`[SurgeTankJob] getUhtSurgeTankRouting failed: ${err.message}`)
      return {}
    })
    const uhtStatusList = await historian.getUhtStatus().catch(err => {
      console.warn(`[SurgeTankJob] getUhtStatus failed: ${err.message}`)
      return []
    })
    const uhtById = Object.fromEntries(uhtStatusList.map(u => [u.uhtId, u]))

    for (const status of statuses) {
      const { tankId, productDesc, mainGallons } = status
      const prev = tankState[tankId]
      if (!prev) continue

      const productName = validStr(productDesc) ? productDesc : null
      const gallons = mainGallons || 0

      if (!prev.seeded) {
        // Don't seed an empty/null product — wait for a real value. If we
        // seed empty here and the next poll returns the real product, it
        // looks like a product-change and false-fires a new WO.
        if (!productName) {
          continue
        }
        prev.productName = productName
        prev.seeded = true
        console.log(`[SurgeTankJob] Seeding ${tankId}: product="${productName}"`)
        continue
      }

      const hadProduct = !!prev.productName
      const hasProduct = !!productName

      const batchAgeMs = prev.batchStartedAt ? Date.now() - prev.batchStartedAt : Infinity
      if (prev.batchActive && hasProduct && gallons < EMPTY_THRESHOLD_GAL && batchAgeMs < MIN_BATCH_DURATION_MS) {
        console.log(`[SurgeTankJob] Suppressing false BATCH END on ${tankId}: gal=${Math.round(gallons)} but batch only ${Math.round(batchAgeMs / 1000)}s old`)
      }
      if (prev.batchActive && hasProduct && gallons < EMPTY_THRESHOLD_GAL && batchAgeMs >= MIN_BATCH_DURATION_MS) {
        console.log(`[SurgeTankJob] BATCH END (tank emptied) on ${tankId}: "${prev.productName}" (${Math.round(gallons)} gal)`)
        statusStore.pushEvent('surgeTank.batchEnd', `${tankId}: batch ended (emptied)`, { tankId, productName: prev.productName, gallons, reason: 'emptied' })
        prev.batchActive = false
        prev.batchStartedAt = null
        prev.fillTickCount = 0
        try {
          await surgeTankMesService.processWOEnd({ tankId, productName: prev.productName, detectedAt: new Date().toISOString() }, historian)
        } catch (err) {
          console.error(`[SurgeTankJob] processWOEnd failed for ${tankId}:`, err.message)
        }
      }

      const cip = isCipMode(status)
      const feedingUht = resolveFeedingUht(tankId, routing)
      const feedingUhtStatus = feedingUht ? uhtById[feedingUht] : null
      const sterileOnProduct = isUhtSterileOnProduct(feedingUhtStatus)

      // Product change while a batch is running: close the old WO immediately,
      // adopt the new productName, and reset the fill-tick counter. The new WO
      // doesn't fire until the 5-tick gate below clears again with the new
      // product — same gate as a cold start.
      if (hasProduct && productName !== prev.productName) {
        if (prev.batchActive && prev.productName) {
          console.log(`[SurgeTankJob] BATCH END (product change) on ${tankId}: "${prev.productName}"`)
          statusStore.pushEvent('surgeTank.batchEnd', `${tankId}: batch ended (product change)`, { tankId, productName: prev.productName, reason: 'product_change' })
          prev.batchActive = false
          prev.batchStartedAt = null
          try {
            await surgeTankMesService.processWOEnd({ tankId, productName: prev.productName, detectedAt: new Date().toISOString() }, historian)
          } catch (err) {
            console.error(`[SurgeTankJob] processWOEnd failed for ${tankId}:`, err.message)
          }
        }
        prev.productName = productName
        prev.fillTickCount = 0
      }

      // 5-tick fill gate — replaces the old immediate-start-on-product-change
      // and weight-confirmation paths. A tick "counts" only when the tank is
      // both physically receiving milk (delta > FILL_NOISE_GAL since our last
      // poll) AND the feeding UHT is on PROCESS step "Sterile on Product".
      // Any miss resets the counter to 0 — sustained inflow during real
      // production is required.
      const fillDelta = prev.lastGallonsForDelta == null ? null : gallons - prev.lastGallonsForDelta
      prev.lastGallonsForDelta = gallons
      const eligibleForGate = hasProduct && !cip && !prev.batchActive && productName === prev.productName

      if (eligibleForGate && fillDelta != null && fillDelta > FILL_NOISE_GAL && sterileOnProduct) {
        prev.fillTickCount++
        console.log(`[SurgeTankJob] Fill tick ${prev.fillTickCount}/${FILL_TICKS_FOR_START} on ${tankId}: "${productName}" (Δ${fillDelta.toFixed(1)} gal, UHT=${feedingUht} Sterile on Product)`)
      } else if (eligibleForGate && prev.fillTickCount > 0) {
        const reason = !sterileOnProduct
          ? `UHT not Sterile on Product (uht=${feedingUht || '?'}, step=${feedingUhtStatus?.stepName || '?'})`
          : `Δ${fillDelta == null ? 'n/a' : fillDelta.toFixed(1)} gal ≤ ${FILL_NOISE_GAL}`
        console.log(`[SurgeTankJob] Fill tick reset on ${tankId} (${reason})`)
        prev.fillTickCount = 0
      }

      if (eligibleForGate && prev.fillTickCount >= FILL_TICKS_FOR_START) {
        let feedingFromEntName = null
        if (feedingUht) {
          try {
            feedingFromEntName = await historian.getUhtFromEntName(feedingUht)
          } catch (err) {
            console.warn(`[SurgeTankJob] getUhtFromEntName(${feedingUht}) failed: ${err.message}`)
          }
        }

        console.log(`[SurgeTankJob] BATCH START (${FILL_TICKS_FOR_START}-tick gate cleared) on ${tankId}: "${productName}" (UHT=${feedingUht || '?'}, from=${feedingFromEntName || '?'})`)
        statusStore.pushEvent('surgeTank.batchStart', `${tankId}: "${productName}" started`, { tankId, productName, feedingUhtId: feedingUht, feedingFromEntName })
        prev.batchActive = true
        prev.batchStartedAt = Date.now()
        prev.feedingUhtId = feedingUht
        prev.feedingFromEntName = feedingFromEntName
        prev.fillTickCount = 0
        try {
          await surgeTankMesService.processWOStart({
            tankId,
            productName,
            feedingUhtId: feedingUht,
            feedingFromEntName,
            detectedAt: new Date().toISOString(),
          }, historian)
        } catch (err) {
          console.error(`[SurgeTankJob] processWOStart failed for ${tankId}:`, err.message)
        }
      }

      if (hadProduct && !hasProduct && prev.batchActive) {
        console.log(`[SurgeTankJob] BATCH END (ProductDesc cleared) on ${tankId}: "${prev.productName}"`)
        statusStore.pushEvent('surgeTank.batchEnd', `${tankId}: batch ended (ProductDesc cleared)`, { tankId, productName: prev.productName, reason: 'product_cleared' })
        prev.batchActive = false
        prev.batchStartedAt = null
        prev.fillTickCount = 0
        try {
          await surgeTankMesService.processWOEnd({ tankId, productName: prev.productName, detectedAt: new Date().toISOString() }, historian)
        } catch (err) {
          console.error(`[SurgeTankJob] processWOEnd failed for ${tankId}:`, err.message)
        }
      }

      prev.productName = productName
    }

    lastPollTime = new Date()
  } catch (err) {
    console.error('[SurgeTankJob] Poll error:', err.message)
    statusStore.pushEvent('surgeTank.poll.error', 'Surge tank poll failed', { error: err.message })
    await notifyService.sendAlert(
      'SunApps MES: Surge Tank Poll Failed',
      `Surge tank job could not poll Historian: ${err.message}`
    )
  }
}

function getLastPollTime() {
  return lastPollTime
}

module.exports = { run, getLastPollTime, hydrateFromDb }
