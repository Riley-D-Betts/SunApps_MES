const apiClient = require('../services/apiClient')
const notifyService = require('../services/notifyService')

/**
 * In-memory state per blend tank.
 * Tracks work order transitions to detect starts and completions.
 */
const tankState = {
  BlendTank1A: { currentWO: null, jobRunning: false },
  BlendTank1B: { currentWO: null, jobRunning: false },
  BlendTank2A: { currentWO: null, jobRunning: false },
  BlendTank2B: { currentWO: null, jobRunning: false },
}

/**
 * In-memory state per milk/cream line totalizer.
 * Tracks previous value to detect resets (reset = batch total for that line).
 */
const lineState = {
  ML1: { prevValue: null },
  ML2: { prevValue: null },
  ML3: { prevValue: null },
  ML4: { prevValue: null },
  CL1: { prevValue: null },
  CL2: { prevValue: null },
}

let lastPollTime = new Date()

/**
 * Poll Historian for blend tank work order status and milk/cream line totalizers.
 * Detects WO start/end transitions and totalizer resets, forwards events to SunApps_API.
 */
async function run(historian) {
  try {
    // 1. Poll blend tank status for all 4 tanks
    const statuses = await historian.getBlendTankStatus()

    for (const status of statuses) {
      const { tankId, currentWO, currentItem, currentWOState, jobRunning,
              batchSize, fromEntName, toEntName } = status
      const prev = tankState[tankId]
      if (!prev) continue

      const wasRunning = prev.jobRunning
      const isRunning = !!jobRunning

      // Detect WO start: jobRunning 0→1 or new WO value while running
      if ((!wasRunning && isRunning) || (isRunning && currentWO && currentWO !== prev.currentWO)) {
        console.log(`[BlendTankJob] WO START detected on ${tankId}: ${currentWO}`)
        try {
          const result = await apiClient.post('/api/mes/milk/blend-tank/wo-start', {
            tankId,
            mesWorkOrder: currentWO,
            mesItem: currentItem,
            woState: currentWOState,
            batchSize,
            fromEntName,
            toEntName,
            detectedAt: new Date().toISOString(),
          })
          console.log(`[BlendTankJob] Forwarded WO start ${currentWO}: ${result.success ? 'OK' : 'FAIL'}`)
        } catch (err) {
          console.error(`[BlendTankJob] Failed to forward WO start for ${tankId}:`, err.message)
          await notifyService.sendAlert(
            'MES_Service: Blend Tank WO Start Failed',
            `Tank ${tankId} WO ${currentWO} could not be sent to SunApps_API: ${err.message}`
          )
        }
      }

      // Detect WO end: jobRunning 1→0
      if (wasRunning && !isRunning && prev.currentWO) {
        console.log(`[BlendTankJob] WO END detected on ${tankId}: ${prev.currentWO}`)
        try {
          const result = await apiClient.post('/api/mes/milk/blend-tank/wo-end', {
            tankId,
            mesWorkOrder: prev.currentWO,
            detectedAt: new Date().toISOString(),
          })
          console.log(`[BlendTankJob] Forwarded WO end ${prev.currentWO}: ${result.success ? 'OK' : 'FAIL'}`)
        } catch (err) {
          console.error(`[BlendTankJob] Failed to forward WO end for ${tankId}:`, err.message)
          await notifyService.sendAlert(
            'MES_Service: Blend Tank WO End Failed',
            `Tank ${tankId} WO ${prev.currentWO} could not be sent to SunApps_API: ${err.message}`
          )
        }
      }

      // Update tracked state
      prev.currentWO = currentWO
      prev.jobRunning = isRunning
    }

    // 2. Poll milk/cream line totalizers
    const lineReadings = await historian.getMilkLineStatus()

    for (const reading of lineReadings) {
      const { line, totalizerLbs } = reading
      const prev = lineState[line]
      if (!prev) continue

      // First poll — seed baseline
      if (prev.prevValue === null) {
        prev.prevValue = totalizerLbs
        continue
      }

      // Totalizer reset detected (current < previous by significant amount)
      // The previous value IS the batch total for that line
      if (totalizerLbs < prev.prevValue - 10) {
        const batchTotalLbs = prev.prevValue
        console.log(`[BlendTankJob] Line ${line} totalizer reset: batch total = ${batchTotalLbs.toFixed(1)} LBS`)

        try {
          const ingredientType = line.startsWith('CL') ? 'cream' : 'skim'
          const result = await apiClient.post('/api/mes/milk/blend-tank/line-flow', {
            line,
            totalLbs: batchTotalLbs,
            ingredientType,
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
      }

      prev.prevValue = totalizerLbs
    }

    lastPollTime = new Date()
  } catch (err) {
    console.error('[BlendTankJob] Poll error:', err.message)
    await notifyService.sendAlert(
      'MES_Service: Historian Poll Failed',
      `Blend tank job could not poll Historian: ${err.message}`
    )
  }
}

function getLastPollTime() {
  return lastPollTime
}

module.exports = { run, getLastPollTime }
