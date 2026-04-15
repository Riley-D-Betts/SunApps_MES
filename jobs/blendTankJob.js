const apiClient = require('../services/apiClient')
const notifyService = require('../services/notifyService')

/**
 * In-memory state per blend tank.
 * Tracks NOTE_STRING (product name from Atlas) to detect batch transitions.
 * MES WO tags (CurrentWO, JobRunning) are stale — plant uses Atlas, not MES.
 *
 * On first poll after service start, we "seed" the state without creating batches.
 * This prevents false batch creation from stale NOTE_STRING values (e.g. a tank
 * in CIP that still has a product name from its last batch).
 */
const WEIGHT_THRESHOLD_LBS = 500
const EMPTY_THRESHOLD_LBS = 100
const LINE_RESET_THRESHOLD_LBS = 100
const BATCH_COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes — minimum time between batch starts per tank

const tankState = {
  BlendTank1A: { productName: null, batchActive: false, seeded: false, lastBatchStart: 0 },
  BlendTank1B: { productName: null, batchActive: false, seeded: false, lastBatchStart: 0 },
  BlendTank2A: { productName: null, batchActive: false, seeded: false, lastBatchStart: 0 },
  BlendTank2B: { productName: null, batchActive: false, seeded: false, lastBatchStart: 0 },
}


/**
 * In-memory state per milk/cream line.
 * Tracks totalizer to detect batch completion via totalizer reset.
 * Product name tags (CURRENTSILOPRODUCTNAME) are "sticky" — they retain
 * their last value after the line goes idle, so we detect on totalizer
 * reset rather than product name clearing.
 */
const lineState = {
  ML1: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
  ML2: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
  ML3: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
  ML4: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
  CL1: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
  CL2: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
}

// Destinations that indicate direct silo-to-UHT (skipping blend tanks)
const UHT_DESTINATIONS = ['UHT1', 'UHT2', 'TSTAT1', 'TSTAT2']

function isUhtDirect(requestedBy) {
  return UHT_DESTINATIONS.some(d => requestedBy?.toUpperCase().includes(d))
}

/**
 * Check if a blend tank is being used as a UHT passthrough (not a real blend).
 * When ToEntName points to a UHT destination, the tank is just a waypoint —
 * the UHT-direct line logic handles WO creation for these runs instead.
 */
function isUhtPassthrough(toEntName) {
  return UHT_DESTINATIONS.some(d => toEntName?.toUpperCase().includes(d))
}

/**
 * Pending API forwards that failed and need retry.
 * Each entry: { endpoint, payload, description, attempts }
 */
const pendingQueue = []

/**
 * Forward a payload to SunApps_API. On failure, queue for retry.
 */
async function forward(endpoint, payload, description) {
  try {
    const result = await apiClient.post(endpoint, payload)
    console.log(`[BlendTankJob] Forwarded ${description}: ${result.success ? 'OK' : 'FAIL'}`)
    return true
  } catch (err) {
    console.error(`[BlendTankJob] Failed to forward ${description}:`, err.message)
    pendingQueue.push({ endpoint, payload, description, attempts: 1 })
    console.log(`[BlendTankJob] Queued for retry: ${description} (${pendingQueue.length} pending)`)
    return false
  }
}

/**
 * Retry all pending forwards. Remove on success, keep on failure.
 */
async function retryPending() {
  if (pendingQueue.length === 0) return

  const retrying = [...pendingQueue]
  pendingQueue.length = 0

  for (const item of retrying) {
    try {
      const result = await apiClient.post(item.endpoint, item.payload)
      console.log(`[BlendTankJob] Retry OK: ${item.description} (attempt ${item.attempts + 1})`)
    } catch (err) {
      item.attempts++
      pendingQueue.push(item)
      if (item.attempts % 30 === 0) {
        // Alert every ~5 minutes (30 polls * 10s) if still failing
        await notifyService.sendAlert(
          'MES_Service: Persistent Forward Failure',
          `${item.description} has failed ${item.attempts} times: ${err.message}`
        )
      }
    }
  }

  if (pendingQueue.length > 0) {
    console.log(`[BlendTankJob] ${pendingQueue.length} pending forward(s) still queued`)
  }
}

let lastPollTime = new Date()

/**
 * Poll Historian for blend tank status and milk/cream line totalizers.
 * Detects product changes via NOTE_STRING and totalizer resets, forwards events to SunApps_API.
 */
async function run(historian) {
  try {
    // 0. Retry any pending forwards from previous polls
    await retryPending()

    // 1. Poll blend tank status for all 4 tanks
    const statuses = await historian.getBlendTankStatus()

    for (const status of statuses) {
      const { tankId, productName, weightLbs, batchSize, fromEntName, toEntName } = status
      const prev = tankState[tankId]
      if (!prev) continue

      // Skip tanks that are UHT passthroughs — ToEntName points to UHT/TSTAT.
      // The UHT-direct line logic handles WO creation for these runs instead.
      if (isUhtPassthrough(toEntName)) {
        if (prev.batchActive) {
          console.log(`[BlendTankJob] ${tankId} became UHT passthrough (→${toEntName}) — ending active batch "${prev.productName}"`)
          prev.batchActive = false
          await forward('/api/mes/milk/blend-tank/wo-end', {
            tankId,
            productName: prev.productName,
            detectedAt: new Date().toISOString(),
          }, `batch end (UHT passthrough) ${tankId} "${prev.productName}"`)
        }
        prev.productName = productName
        prev.seeded = true
        continue
      }

      // First poll — seed state without creating batches.
      // Stale NOTE_STRING values (from tanks in CIP) would otherwise trigger false batch starts.
      if (!prev.seeded) {
        prev.productName = productName
        prev.seeded = true
        console.log(`[BlendTankJob] Seeding ${tankId}: product="${productName || ''}"`)
        continue
      }

      const hadProduct = !!prev.productName
      const hasProduct = !!productName

      // Detect batch end by weight: tank emptied while product name still set (same-product back-to-back batches)
      if (prev.batchActive && hasProduct && weightLbs < EMPTY_THRESHOLD_LBS) {
        console.log(`[BlendTankJob] BATCH END (tank emptied) on ${tankId}: "${prev.productName}" (${Math.round(weightLbs)} lb)`)
        prev.batchActive = false
        await forward('/api/mes/milk/blend-tank/wo-end', {
          tankId,
          productName: prev.productName,
          detectedAt: new Date().toISOString(),
        }, `batch end (emptied) ${tankId} "${prev.productName}"`)
      }

      // Cooldown check: prevent rapid-fire batch creation if tags are cycling
      const now = Date.now()
      const cooldownActive = (now - prev.lastBatchStart) < BATCH_COOLDOWN_MS

      // Detect new batch: NOTE_STRING changed to a new non-empty value
      if (hasProduct && productName !== prev.productName) {
        // If previous batch was active, end it first
        if (prev.batchActive && prev.productName) {
          if (cooldownActive) {
            // Tag is cycling rapidly — suppress the end/start churn
            console.warn(`[BlendTankJob] COOLDOWN: Suppressing product change on ${tankId} "${prev.productName}" → "${productName}" (last start ${Math.round((now - prev.lastBatchStart) / 1000)}s ago)`)
          } else {
            console.log(`[BlendTankJob] BATCH END (product change) on ${tankId}: "${prev.productName}"`)
            prev.batchActive = false
            await forward('/api/mes/milk/blend-tank/wo-end', {
              tankId,
              productName: prev.productName,
              detectedAt: new Date().toISOString(),
            }, `batch end (product change) ${tankId} "${prev.productName}"`)
          }
        }

        if (!cooldownActive) {
          console.log(`[BlendTankJob] BATCH START detected on ${tankId}: "${productName}"`)
          prev.batchActive = true
          prev.lastBatchStart = now
          await forward('/api/mes/milk/blend-tank/wo-start', {
            tankId,
            productName,
            batchSize,
            fromEntName,
            toEntName,
            detectedAt: new Date().toISOString(),
          }, `batch start ${tankId} "${productName}"`)
        }
      }

      // Detect batch start from seeded state: product was already set when service started,
      // but weight crossing threshold confirms it's a real active batch (not stale CIP NOTE_STRING).
      if (hasProduct && !prev.batchActive && productName === prev.productName && weightLbs >= WEIGHT_THRESHOLD_LBS) {
        console.log(`[BlendTankJob] BATCH START (weight confirmed) on ${tankId}: "${productName}" (${Math.round(weightLbs).toLocaleString()} lb)`)
        prev.batchActive = true
        prev.lastBatchStart = now
        await forward('/api/mes/milk/blend-tank/wo-start', {
          tankId,
          productName,
          batchSize,
          fromEntName,
          toEntName,
          detectedAt: new Date().toISOString(),
        }, `batch start (weight) ${tankId} "${productName}"`)
      }

      // Detect batch end: NOTE_STRING cleared after having a product
      if (hadProduct && !hasProduct && prev.batchActive) {
        console.log(`[BlendTankJob] BATCH END (NOTE_STRING cleared) on ${tankId}: "${prev.productName}"`)
        prev.batchActive = false
        await forward('/api/mes/milk/blend-tank/wo-end', {
          tankId,
          productName: prev.productName,
          detectedAt: new Date().toISOString(),
        }, `batch end (cleared) ${tankId} "${prev.productName}"`)
      }

      // Update tracked state
      prev.productName = productName
    }

    // 2. Poll milk/cream line totalizers
    const lineReadings = await historian.getMilkLineStatus()

    for (const reading of lineReadings) {
      const { line, totalizerLbs, productName, siloName, requestedBy, requestedTargetLbs, active } = reading
      const prev = lineState[line]
      if (!prev) continue

      // First poll — seed baseline
      if (prev.prevValue === null) {
        prev.prevValue = totalizerLbs
        if (productName) prev.productName = productName
        if (siloName) prev.siloName = siloName
        if (requestedBy) prev.requestedBy = requestedBy
        continue
      }

      const hadProduct = !!prev.productName
      const hasProduct = !!productName

      // Totalizer reset detection: line completed a batch when totalizer drops from
      // a significant value to near-zero. Product name tags are "sticky" (retain last
      // value when line goes idle), so we detect on totalizer reset, not product name.
      const totalizerReset = prev.prevValue > LINE_RESET_THRESHOLD_LBS && totalizerLbs < LINE_RESET_THRESHOLD_LBS

      // ── UHT-direct detection ──
      // When a line feeds directly to UHT (skipping blend tanks), create a WO at start and close at end.
      if (hasProduct && isUhtDirect(requestedBy) && !prev.uhtActive) {
        const uhtId = `${line}→${requestedBy}`
        console.log(`[BlendTankJob] UHT-DIRECT START on ${line}: "${productName}" (${siloName} → ${requestedBy})`)
        await forward('/api/mes/milk/blend-tank/wo-start', {
          tankId: uhtId,
          productName,
          batchSize: requestedTargetLbs || 0,
          fromEntName: siloName || '',
          toEntName: requestedBy || '',
          detectedAt: new Date().toISOString(),
        }, `UHT-direct start ${uhtId} "${productName}"`)
        prev.uhtActive = true
      }

      // UHT-direct batch end: totalizer reset OR product name cleared while UHT run was active
      if (prev.uhtActive && (totalizerReset || !hasProduct)) {
        const uhtId = `${line}→${prev.requestedBy}`
        const batchTotalLbs = totalizerReset ? prev.prevValue : (totalizerLbs > 10 ? totalizerLbs : prev.prevValue)
        console.log(`[BlendTankJob] UHT-DIRECT END on ${line}: "${prev.productName}" — ${batchTotalLbs.toFixed(1)} LBS (${prev.siloName} → ${prev.requestedBy})`)

        // Send the line flow with the final totalizer
        if (batchTotalLbs > 10) {
          await forward('/api/mes/milk/blend-tank/line-flow', {
            line,
            totalLbs: batchTotalLbs,
            lineProductName: prev.productName,
            siloName: prev.siloName || '',
            destination: prev.requestedBy || '',
            requestedTargetLbs: prev.requestedTargetLbs || 0,
            resetTime: new Date().toISOString(),
          }, `UHT-direct flow ${line} ${batchTotalLbs.toFixed(0)} lb "${prev.productName}"`)
        }

        // Close the WO
        await forward('/api/mes/milk/blend-tank/wo-end', {
          tankId: uhtId,
          productName: prev.productName,
          detectedAt: new Date().toISOString(),
        }, `UHT-direct end ${uhtId} "${prev.productName}"`)
        prev.uhtActive = false
      }

      // ── Blend tank line flow detection ──
      // Detect batch complete: totalizer resets OR product name clears.
      // Product name tags are usually "sticky" (retain value when idle), so totalizer
      // reset is the primary signal — but we keep product-name-clearing as a fallback.
      // Only for non-UHT lines (UHT-direct handled above).
      const productCleared = hadProduct && !hasProduct && prev.prevValue > 10
      if ((totalizerReset || productCleared) && hadProduct && !prev.uhtActive) {
        const batchTotalLbs = totalizerReset ? prev.prevValue : (totalizerLbs > 10 ? totalizerLbs : prev.prevValue)
        const lineProductName = prev.productName
        const source = prev.siloName || ''
        const destination = prev.requestedBy || ''
        console.log(`[BlendTankJob] Line ${line} batch complete: ${batchTotalLbs.toFixed(1)} LBS of "${lineProductName}" (${source} → ${destination})`)

        await forward('/api/mes/milk/blend-tank/line-flow', {
          line,
          totalLbs: batchTotalLbs,
          lineProductName,
          siloName: source,
          destination,
          requestedTargetLbs: prev.requestedTargetLbs || 0,
          resetTime: new Date().toISOString(),
        }, `line flow ${line} ${batchTotalLbs.toFixed(0)} lb "${lineProductName}"`)
      }

      // Track state — update product info when present, preserve last known when idle
      if (productName) prev.productName = productName
      if (siloName) prev.siloName = siloName
      if (requestedBy) prev.requestedBy = requestedBy
      if (requestedTargetLbs) prev.requestedTargetLbs = requestedTargetLbs
      prev.prevValue = totalizerLbs
    }

    // 3. Print status summary
    logStatusSummary(statuses, lineReadings)

    lastPollTime = new Date()
  } catch (err) {
    console.error('[BlendTankJob] Poll error:', err.message)
    await notifyService.sendAlert(
      'MES_Service: Historian Poll Failed',
      `Blend tank job could not poll Historian: ${err.message}`
    )
  }
}

/**
 * Build a snapshot string of current status for change detection.
 */
let lastStatusSnapshot = ''

function buildStatusSnapshot(statuses, lineReadings) {
  const tanks = statuses.map(s => {
    const state = tankState[s.tankId]
    const active = state?.batchActive ? 'ACTIVE' : 'idle'
    return `${s.tankId}:${active}:${s.productName || ''}:${Math.round(s.weightLbs || 0)}`
  }).join('|')

  const lines = lineReadings
    .filter(r => r.totalizerLbs > 0 || r.active)
    .map(r => `${r.line}:${Math.round(r.totalizerLbs)}:${r.productName || ''}:${r.requestedBy || ''}`)
    .join('|')

  return `${tanks}||${lines}`
}

/**
 * Print a compact status summary to the console — only when something changed.
 */
function logStatusSummary(statuses, lineReadings) {
  const snapshot = buildStatusSnapshot(statuses, lineReadings)
  if (snapshot === lastStatusSnapshot) return
  lastStatusSnapshot = snapshot

  const ts = new Date().toLocaleTimeString()
  const tankLines = statuses.map(s => {
    const state = tankState[s.tankId]
    const active = state?.batchActive ? 'ACTIVE' : 'idle'
    const product = s.productName || '—'
    const weight = s.weightLbs ? `${Math.round(s.weightLbs).toLocaleString()} lb` : '0 lb'
    return `  ${s.tankId}: [${active}] ${product} (${weight})`
  })

  const activeLines = lineReadings
    .filter(r => r.totalizerLbs > 0 || r.active)
    .map(r => {
      const parts = [`${r.line}=${Math.round(r.totalizerLbs).toLocaleString()} lb`]
      if (r.siloName && r.requestedBy) {
        parts.push(`${r.siloName}→${r.requestedBy}`)
      } else if (r.requestedBy) {
        parts.push(`→${r.requestedBy}`)
      }
      if (r.productName) parts.push(r.productName)
      return parts.join(' ')
    })
  const lineSummary = activeLines.length > 0 ? activeLines.join(', ') : 'all idle'

  console.log(`\n[${ts}] ── Blend Tank Status ──`)
  tankLines.forEach(l => console.log(l))
  console.log(`  Lines: ${lineSummary}`)
}

function getLastPollTime() {
  return lastPollTime
}

module.exports = { run, getLastPollTime }
