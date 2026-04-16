const blendTankMesService = require('../services/blendTankMesService')
const notifyService = require('../services/notifyService')

const WEIGHT_THRESHOLD_LBS = 500
const EMPTY_THRESHOLD_LBS = 100
const LINE_RESET_THRESHOLD_LBS = 100

const tankState = {
  BlendTank1A: { productName: null, batchActive: false, seeded: false },
  BlendTank1B: { productName: null, batchActive: false, seeded: false },
  BlendTank2A: { productName: null, batchActive: false, seeded: false },
  BlendTank2B: { productName: null, batchActive: false, seeded: false },
}

const lineState = {
  ML1: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
  ML2: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
  ML3: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
  ML4: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
  CL1: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
  CL2: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtActive: false },
}

const UHT_DESTINATIONS = ['UHT1', 'UHT2', 'TSTAT1', 'TSTAT2']

function isUhtDirect(requestedBy) {
  return UHT_DESTINATIONS.some(d => requestedBy?.toUpperCase().includes(d))
}

let lastPollTime = new Date()

async function run(historian) {
  try {
    const statuses = await historian.getBlendTankStatus()

    for (const status of statuses) {
      const { tankId, productName, weightLbs, batchSize, fromEntName, toEntName } = status
      const prev = tankState[tankId]
      if (!prev) continue

      if (!prev.seeded) {
        prev.productName = productName
        prev.seeded = true
        console.log(`[BlendTankJob] Seeding ${tankId}: product="${productName || ''}"`)
        continue
      }

      const hadProduct = !!prev.productName
      const hasProduct = !!productName

      if (prev.batchActive && hasProduct && weightLbs < EMPTY_THRESHOLD_LBS) {
        console.log(`[BlendTankJob] BATCH END (tank emptied) on ${tankId}: "${prev.productName}" (${Math.round(weightLbs)} lb)`)
        prev.batchActive = false
        try {
          await blendTankMesService.processWOEnd({ tankId, productName: prev.productName, detectedAt: new Date().toISOString() })
        } catch (err) {
          console.error(`[BlendTankJob] processWOEnd failed for ${tankId}:`, err.message)
        }
      }

      if (hasProduct && productName !== prev.productName) {
        if (prev.batchActive && prev.productName) {
          console.log(`[BlendTankJob] BATCH END (product change) on ${tankId}: "${prev.productName}"`)
          prev.batchActive = false
          try {
            await blendTankMesService.processWOEnd({ tankId, productName: prev.productName, detectedAt: new Date().toISOString() })
          } catch (err) {
            console.error(`[BlendTankJob] processWOEnd failed for ${tankId}:`, err.message)
          }
        }

        console.log(`[BlendTankJob] BATCH START detected on ${tankId}: "${productName}"`)
        prev.batchActive = true
        try {
          await blendTankMesService.processWOStart({ tankId, productName, batchSize, fromEntName, toEntName, detectedAt: new Date().toISOString() })
        } catch (err) {
          console.error(`[BlendTankJob] processWOStart failed for ${tankId}:`, err.message)
        }
      }

      if (hasProduct && !prev.batchActive && productName === prev.productName && weightLbs >= WEIGHT_THRESHOLD_LBS) {
        console.log(`[BlendTankJob] BATCH START (weight confirmed) on ${tankId}: "${productName}" (${Math.round(weightLbs).toLocaleString()} lb)`)
        prev.batchActive = true
        try {
          await blendTankMesService.processWOStart({ tankId, productName, batchSize, fromEntName, toEntName, detectedAt: new Date().toISOString() })
        } catch (err) {
          console.error(`[BlendTankJob] processWOStart failed for ${tankId}:`, err.message)
        }
      }

      if (hadProduct && !hasProduct && prev.batchActive) {
        console.log(`[BlendTankJob] BATCH END (NOTE_STRING cleared) on ${tankId}: "${prev.productName}"`)
        prev.batchActive = false
        try {
          await blendTankMesService.processWOEnd({ tankId, productName: prev.productName, detectedAt: new Date().toISOString() })
        } catch (err) {
          console.error(`[BlendTankJob] processWOEnd failed for ${tankId}:`, err.message)
        }
      }

      prev.productName = productName
    }

    const lineReadings = await historian.getMilkLineStatus()

    for (const reading of lineReadings) {
      const { line, totalizerLbs, productName, siloName, requestedBy, requestedTargetLbs, active } = reading
      const prev = lineState[line]
      if (!prev) continue

      if (prev.prevValue === null) {
        prev.prevValue = totalizerLbs
        if (productName) prev.productName = productName
        if (siloName) prev.siloName = siloName
        if (requestedBy) prev.requestedBy = requestedBy
        continue
      }

      const hadProduct = !!prev.productName
      const hasProduct = !!productName
      const totalizerReset = prev.prevValue > LINE_RESET_THRESHOLD_LBS && totalizerLbs < LINE_RESET_THRESHOLD_LBS

      if (hasProduct && isUhtDirect(requestedBy) && !prev.uhtActive) {
        const uhtId = `${line}→${requestedBy}`
        console.log(`[BlendTankJob] UHT-DIRECT START on ${line}: "${productName}" (${siloName} → ${requestedBy})`)
        try {
          await blendTankMesService.processWOStart({
            tankId: uhtId, productName, batchSize: requestedTargetLbs || 0,
            fromEntName: siloName || '', toEntName: requestedBy || '', detectedAt: new Date().toISOString(),
          })
        } catch (err) {
          console.error(`[BlendTankJob] processWOStart (UHT) failed for ${uhtId}:`, err.message)
        }
        prev.uhtActive = true
      }

      if (prev.uhtActive && (totalizerReset || !hasProduct)) {
        const uhtId = `${line}→${prev.requestedBy}`
        const batchTotalLbs = totalizerReset ? prev.prevValue : (totalizerLbs > 10 ? totalizerLbs : prev.prevValue)
        console.log(`[BlendTankJob] UHT-DIRECT END on ${line}: "${prev.productName}" — ${batchTotalLbs.toFixed(1)} LBS`)

        if (batchTotalLbs > 10) {
          try {
            await blendTankMesService.processLineFlow({
              line, totalLbs: batchTotalLbs, lineProductName: prev.productName,
              siloName: prev.siloName || '', destination: prev.requestedBy || '',
              requestedTargetLbs: prev.requestedTargetLbs || 0, resetTime: new Date().toISOString(),
            })
          } catch (err) {
            console.error(`[BlendTankJob] processLineFlow (UHT) failed for ${line}:`, err.message)
          }
        }

        try {
          await blendTankMesService.processWOEnd({ tankId: uhtId, productName: prev.productName, detectedAt: new Date().toISOString() })
        } catch (err) {
          console.error(`[BlendTankJob] processWOEnd (UHT) failed for ${uhtId}:`, err.message)
        }
        prev.uhtActive = false
      }

      const productCleared = hadProduct && !hasProduct && prev.prevValue > 10
      if ((totalizerReset || productCleared) && hadProduct && !prev.uhtActive) {
        const batchTotalLbs = totalizerReset ? prev.prevValue : (totalizerLbs > 10 ? totalizerLbs : prev.prevValue)
        console.log(`[BlendTankJob] Line ${line} batch complete: ${batchTotalLbs.toFixed(1)} LBS of "${prev.productName}" (${prev.siloName || ''} → ${prev.requestedBy || ''})`)
        try {
          await blendTankMesService.processLineFlow({
            line, totalLbs: batchTotalLbs, lineProductName: prev.productName,
            siloName: prev.siloName || '', destination: prev.requestedBy || '',
            requestedTargetLbs: prev.requestedTargetLbs || 0, resetTime: new Date().toISOString(),
          })
        } catch (err) {
          console.error(`[BlendTankJob] processLineFlow failed for ${line}:`, err.message)
        }
      }

      if (productName) prev.productName = productName
      if (siloName) prev.siloName = siloName
      if (requestedBy) prev.requestedBy = requestedBy
      if (requestedTargetLbs) prev.requestedTargetLbs = requestedTargetLbs
      prev.prevValue = totalizerLbs
    }

    logStatusSummary(statuses, lineReadings)
    lastPollTime = new Date()
  } catch (err) {
    console.error('[BlendTankJob] Poll error:', err.message)
    await notifyService.sendAlert(
      'SunApps MES: Historian Poll Failed',
      `Blend tank job could not poll Historian: ${err.message}`
    )
  }
}

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
    .filter(r => r.totalizerLbs > 0 || r.active)
    .map(r => {
      const parts = [`${r.line}=${Math.round(r.totalizerLbs).toLocaleString()} lb`]
      if (r.siloName && r.requestedBy) parts.push(`${r.siloName}→${r.requestedBy}`)
      else if (r.requestedBy) parts.push(`→${r.requestedBy}`)
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
