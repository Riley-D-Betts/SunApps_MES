const surgeTankMesService = require('../services/surgeTankMesService')
const notifyService = require('../services/notifyService')
const statusStore = require('../services/statusStore')

// ST81-84 capacities are roughly 5000 gal. Use modest thresholds so we don't
// false-trigger on residual coolant or a re-pressurization spike.
const WEIGHT_THRESHOLD_GAL = 50
const EMPTY_THRESHOLD_GAL = 10
// Minimum batch lifetime before the "tank emptied" END can fire. Prevents a
// false end when the ST reads 0 at the start of a fill (sterile prep) before
// any real product has landed.
const MIN_BATCH_DURATION_MS = 120_000

function validStr(val) {
  return val && val !== 'None' && val !== 'none' ? val : null
}

const tankState = {
  ST81: { productName: null, batchActive: false, seeded: false, batchStartedAt: null, feedingUhtId: null, feedingFromEntName: null },
  ST82: { productName: null, batchActive: false, seeded: false, batchStartedAt: null, feedingUhtId: null, feedingFromEntName: null },
  ST83: { productName: null, batchActive: false, seeded: false, batchStartedAt: null, feedingUhtId: null, feedingFromEntName: null },
  ST84: { productName: null, batchActive: false, seeded: false, batchStartedAt: null, feedingUhtId: null, feedingFromEntName: null },
}

let lastPollTime = new Date()

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

    for (const status of statuses) {
      const { tankId, productDesc, mainGallons } = status
      const prev = tankState[tankId]
      if (!prev) continue

      const productName = validStr(productDesc) ? productDesc : null
      const gallons = mainGallons || 0

      if (!prev.seeded) {
        prev.productName = productName
        prev.seeded = true
        console.log(`[SurgeTankJob] Seeding ${tankId}: product="${productName || ''}"`)
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
        try {
          await surgeTankMesService.processWOEnd({ tankId, productName: prev.productName, detectedAt: new Date().toISOString() }, historian)
        } catch (err) {
          console.error(`[SurgeTankJob] processWOEnd failed for ${tankId}:`, err.message)
        }
      }

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

        // Resolve the feeding source at start time so the batch carries it.
        const feedingUhtId = resolveFeedingUht(tankId, routing)
        let feedingFromEntName = null
        if (feedingUhtId) {
          try {
            feedingFromEntName = await historian.getUhtFromEntName(feedingUhtId)
          } catch (err) {
            console.warn(`[SurgeTankJob] getUhtFromEntName(${feedingUhtId}) failed: ${err.message}`)
          }
        }

        console.log(`[SurgeTankJob] BATCH START detected on ${tankId}: "${productName}" (UHT=${feedingUhtId || '?'}, from=${feedingFromEntName || '?'})`)
        statusStore.pushEvent('surgeTank.batchStart', `${tankId}: "${productName}" started`, { tankId, productName, feedingUhtId, feedingFromEntName })
        prev.batchActive = true
        prev.batchStartedAt = Date.now()
        prev.feedingUhtId = feedingUhtId
        prev.feedingFromEntName = feedingFromEntName
        try {
          await surgeTankMesService.processWOStart({
            tankId,
            productName,
            feedingUhtId,
            feedingFromEntName,
            detectedAt: new Date().toISOString(),
          })
        } catch (err) {
          console.error(`[SurgeTankJob] processWOStart failed for ${tankId}:`, err.message)
        }
      }

      // Weight-confirmation fallback: product was already seeded but no
      // active batch yet, and gallons have crossed the threshold. Covers
      // the case where seeding ran during an in-progress fill.
      if (hasProduct && !prev.batchActive && productName === prev.productName && gallons >= WEIGHT_THRESHOLD_GAL) {
        const feedingUhtId = resolveFeedingUht(tankId, routing)
        let feedingFromEntName = null
        if (feedingUhtId) {
          try {
            feedingFromEntName = await historian.getUhtFromEntName(feedingUhtId)
          } catch (err) {
            console.warn(`[SurgeTankJob] getUhtFromEntName(${feedingUhtId}) failed: ${err.message}`)
          }
        }
        console.log(`[SurgeTankJob] BATCH START (level confirmed) on ${tankId}: "${productName}" (${Math.round(gallons)} gal)`)
        statusStore.pushEvent('surgeTank.batchStart', `${tankId}: "${productName}" started (level)`, { tankId, productName, gallons, feedingUhtId, feedingFromEntName })
        prev.batchActive = true
        prev.batchStartedAt = Date.now()
        prev.feedingUhtId = feedingUhtId
        prev.feedingFromEntName = feedingFromEntName
        try {
          await surgeTankMesService.processWOStart({
            tankId,
            productName,
            feedingUhtId,
            feedingFromEntName,
            detectedAt: new Date().toISOString(),
          })
        } catch (err) {
          console.error(`[SurgeTankJob] processWOStart failed for ${tankId}:`, err.message)
        }
      }

      if (hadProduct && !hasProduct && prev.batchActive) {
        console.log(`[SurgeTankJob] BATCH END (ProductDesc cleared) on ${tankId}: "${prev.productName}"`)
        statusStore.pushEvent('surgeTank.batchEnd', `${tankId}: batch ended (ProductDesc cleared)`, { tankId, productName: prev.productName, reason: 'product_cleared' })
        prev.batchActive = false
        prev.batchStartedAt = null
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

module.exports = { run, getLastPollTime }
