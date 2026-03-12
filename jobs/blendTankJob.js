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

const tankState = {
  BlendTank1A: { productName: null, batchActive: false, seeded: false },
  BlendTank1B: { productName: null, batchActive: false, seeded: false },
  BlendTank2A: { productName: null, batchActive: false, seeded: false },
  BlendTank2B: { productName: null, batchActive: false, seeded: false },
}


/**
 * In-memory state per milk/cream line totalizer.
 * Tracks previous value to detect resets (reset = batch total for that line).
 * Also tracks productName from SCADA CURRENTSILOPRODUCTNAME tag.
 */
const lineState = {
  ML1: { prevValue: null, productName: '' },
  ML2: { prevValue: null, productName: '' },
  ML3: { prevValue: null, productName: '' },
  ML4: { prevValue: null, productName: '' },
  CL1: { prevValue: null, productName: '' },
  CL2: { prevValue: null, productName: '' },
}

let lastPollTime = new Date()

/**
 * Poll Historian for blend tank status and milk/cream line totalizers.
 * Detects product changes via NOTE_STRING and totalizer resets, forwards events to SunApps_API.
 */
async function run(historian) {
  try {
    // 1. Poll blend tank status for all 4 tanks
    const statuses = await historian.getBlendTankStatus()

    for (const status of statuses) {
      const { tankId, productName, weightLbs, batchSize, fromEntName, toEntName } = status
      const prev = tankState[tankId]
      if (!prev) continue

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
        try {
          const result = await apiClient.post('/api/mes/milk/blend-tank/wo-end', {
            tankId,
            productName: prev.productName,
            detectedAt: new Date().toISOString(),
          })
          console.log(`[BlendTankJob] Forwarded batch end: ${result.success ? 'OK' : 'FAIL'}`)
        } catch (err) {
          console.error(`[BlendTankJob] Failed to forward batch end for ${tankId}:`, err.message)
          await notifyService.sendAlert(
            'MES_Service: Blend Tank Batch End Failed',
            `Tank ${tankId} batch end could not be sent to SunApps_API: ${err.message}`
          )
        }
        prev.batchActive = false
      }

      // Detect new batch: NOTE_STRING changed to a new non-empty value
      if (hasProduct && productName !== prev.productName) {
        // If previous batch was active, end it first
        if (prev.batchActive && prev.productName) {
          console.log(`[BlendTankJob] BATCH END (product change) on ${tankId}: "${prev.productName}"`)
          try {
            const result = await apiClient.post('/api/mes/milk/blend-tank/wo-end', {
              tankId,
              productName: prev.productName,
              detectedAt: new Date().toISOString(),
            })
            console.log(`[BlendTankJob] Forwarded batch end: ${result.success ? 'OK' : 'FAIL'}`)
          } catch (err) {
            console.error(`[BlendTankJob] Failed to forward batch end for ${tankId}:`, err.message)
          }
        }

        console.log(`[BlendTankJob] BATCH START detected on ${tankId}: "${productName}"`)
        try {
          const result = await apiClient.post('/api/mes/milk/blend-tank/wo-start', {
            tankId,
            productName,
            batchSize,
            fromEntName,
            toEntName,
            detectedAt: new Date().toISOString(),
          })
          console.log(`[BlendTankJob] Forwarded batch start "${productName}": ${result.success ? 'OK' : 'FAIL'}`)
        } catch (err) {
          console.error(`[BlendTankJob] Failed to forward batch start for ${tankId}:`, err.message)
          await notifyService.sendAlert(
            'MES_Service: Blend Tank Batch Start Failed',
            `Tank ${tankId} product "${productName}" could not be sent to SunApps_API: ${err.message}`
          )
        }
        prev.batchActive = true
      }

      // Detect batch start from seeded state: product was already set when service started,
      // but weight crossing threshold confirms it's a real active batch (not stale CIP NOTE_STRING).
      if (hasProduct && !prev.batchActive && productName === prev.productName && weightLbs >= WEIGHT_THRESHOLD_LBS) {
        console.log(`[BlendTankJob] BATCH START (weight confirmed) on ${tankId}: "${productName}" (${Math.round(weightLbs).toLocaleString()} lb)`)
        try {
          const result = await apiClient.post('/api/mes/milk/blend-tank/wo-start', {
            tankId,
            productName,
            batchSize,
            fromEntName,
            toEntName,
            detectedAt: new Date().toISOString(),
          })
          console.log(`[BlendTankJob] Forwarded batch start "${productName}": ${result.success ? 'OK' : 'FAIL'}`)
        } catch (err) {
          console.error(`[BlendTankJob] Failed to forward batch start for ${tankId}:`, err.message)
          await notifyService.sendAlert(
            'MES_Service: Blend Tank Batch Start Failed',
            `Tank ${tankId} product "${productName}" could not be sent to SunApps_API: ${err.message}`
          )
        }
        prev.batchActive = true
      }

      // Detect batch end: NOTE_STRING cleared after having a product
      if (hadProduct && !hasProduct && prev.batchActive) {
        console.log(`[BlendTankJob] BATCH END (NOTE_STRING cleared) on ${tankId}: "${prev.productName}"`)
        try {
          const result = await apiClient.post('/api/mes/milk/blend-tank/wo-end', {
            tankId,
            productName: prev.productName,
            detectedAt: new Date().toISOString(),
          })
          console.log(`[BlendTankJob] Forwarded batch end: ${result.success ? 'OK' : 'FAIL'}`)
        } catch (err) {
          console.error(`[BlendTankJob] Failed to forward batch end for ${tankId}:`, err.message)
          await notifyService.sendAlert(
            'MES_Service: Blend Tank Batch End Failed',
            `Tank ${tankId} batch end could not be sent to SunApps_API: ${err.message}`
          )
        }
        prev.batchActive = false
      }

      // Update tracked state
      prev.productName = productName
    }

    // 2. Poll milk/cream line totalizers
    const lineReadings = await historian.getMilkLineStatus()

    for (const reading of lineReadings) {
      const { line, totalizerLbs, productName } = reading
      const prev = lineState[line]
      if (!prev) continue

      // Always track the latest product name from SCADA
      if (productName) prev.productName = productName

      // First poll — seed baseline
      if (prev.prevValue === null) {
        prev.prevValue = totalizerLbs
        continue
      }

      // Totalizer reset detected (current < previous by significant amount)
      // The previous value IS the batch total for that line
      if (totalizerLbs < prev.prevValue - 10) {
        const batchTotalLbs = prev.prevValue
        const lineProductName = prev.productName || ''
        console.log(`[BlendTankJob] Line ${line} totalizer reset: batch total = ${batchTotalLbs.toFixed(1)} LBS, product = "${lineProductName}"`)

        try {
          const result = await apiClient.post('/api/mes/milk/blend-tank/line-flow', {
            line,
            totalLbs: batchTotalLbs,
            lineProductName,
            resetTime: new Date().toISOString(),
          })
          console.log(`[BlendTankJob] Forwarded line flow ${line}: ${result.success ? 'OK' : 'FAIL'}`)
        } catch (err) {
          console.error(`[BlendTankJob] Failed to forward line flow for ${line}:`, err.message)
          await notifyService.sendAlert(
            'MES_Service: Line Flow Forward Failed',
            `Line ${line} totalizer reset (${batchTotalLbs.toFixed(1)} LBS) could not be sent: ${err.message}`
          )
        }

        // Clear product name after reset (new batch may have different product)
        prev.productName = ''
      }

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
 * Print a compact status summary to the console.
 */
function logStatusSummary(statuses, lineReadings) {
  const ts = new Date().toLocaleTimeString()
  const tankLines = statuses.map(s => {
    const state = tankState[s.tankId]
    const active = state?.batchActive ? 'ACTIVE' : 'idle'
    const product = s.productName || '—'
    const weight = s.weightLbs ? `${Math.round(s.weightLbs).toLocaleString()} lb` : '0 lb'
    return `  ${s.tankId}: [${active}] ${product} (${weight})`
  })

  const activeLines = lineReadings
    .filter(r => r.totalizerLbs > 0)
    .map(r => {
      const product = r.productName ? ` (${r.productName})` : ''
      return `${r.line}=${Math.round(r.totalizerLbs).toLocaleString()} lb${product}`
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
