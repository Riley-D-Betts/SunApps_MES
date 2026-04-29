const blendTankMesService = require('../services/blendTankMesService')
const notifyService = require('../services/notifyService')
const statusStore = require('../services/statusStore')

const WEIGHT_THRESHOLD_LBS = 500
const EMPTY_THRESHOLD_LBS = 100
const LINE_RESET_THRESHOLD_LBS = 100
// Minimum time a batch must be alive before the "tank emptied" BATCH END can fire.
// Prevents a false end when the scale reads 0 at the start of a fill (milk not yet
// in the tank) before the WO creation has finished and before any real weight lands.
const MIN_BATCH_DURATION_MS = 120_000

function validStr(val) {
  return val && val !== 'None' && val !== 'none' ? val : null
}

const tankState = {
  BlendTank1A: { productName: null, batchActive: false, seeded: false, batchStartedAt: null },
  BlendTank1B: { productName: null, batchActive: false, seeded: false, batchStartedAt: null },
  BlendTank2A: { productName: null, batchActive: false, seeded: false, batchStartedAt: null },
  BlendTank2B: { productName: null, batchActive: false, seeded: false, batchStartedAt: null },
}

const lineState = {
  ML1: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtRequestedBy: '', uhtActive: false },
  ML2: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtRequestedBy: '', uhtActive: false },
  ML3: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtRequestedBy: '', uhtActive: false },
  ML4: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtRequestedBy: '', uhtActive: false },
  CL1: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtRequestedBy: '', uhtActive: false },
  CL2: { prevValue: null, productName: '', siloName: '', requestedBy: '', uhtRequestedBy: '', uhtActive: false },
}

const UHT_DESTINATIONS = ['UHT1', 'UHT2', 'TSTAT1', 'TSTAT2']

function isUhtDirect(requestedBy) {
  return UHT_DESTINATIONS.some(d => requestedBy?.toUpperCase().includes(d))
}

let lastPollTime = new Date()

async function run(historian) {
  const pollStart = Date.now()
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
      const hasProduct = !!validStr(productName)

      const batchAgeMs = prev.batchStartedAt ? Date.now() - prev.batchStartedAt : Infinity
      if (prev.batchActive && hasProduct && weightLbs < EMPTY_THRESHOLD_LBS && batchAgeMs < MIN_BATCH_DURATION_MS) {
        console.log(`[BlendTankJob] Suppressing false BATCH END on ${tankId}: weight=${Math.round(weightLbs)} lb but batch only ${Math.round(batchAgeMs / 1000)}s old`)
      }
      if (prev.batchActive && hasProduct && weightLbs < EMPTY_THRESHOLD_LBS && batchAgeMs >= MIN_BATCH_DURATION_MS) {
        console.log(`[BlendTankJob] BATCH END (tank emptied) on ${tankId}: "${prev.productName}" (${Math.round(weightLbs)} lb)`)
        statusStore.pushEvent('blendTank.batchEnd', `${tankId}: batch ended (emptied)`, { tankId, productName: prev.productName, weightLbs, reason: 'emptied' })
        prev.batchActive = false
        prev.batchStartedAt = null
        try {
          await blendTankMesService.processWOEnd({ tankId, productName: prev.productName, detectedAt: new Date().toISOString() })
        } catch (err) {
          console.error(`[BlendTankJob] processWOEnd failed for ${tankId}:`, err.message)
        }
      }

      if (hasProduct && productName !== prev.productName) {
        if (prev.batchActive && prev.productName) {
          console.log(`[BlendTankJob] BATCH END (product change) on ${tankId}: "${prev.productName}"`)
          statusStore.pushEvent('blendTank.batchEnd', `${tankId}: batch ended (product change)`, { tankId, productName: prev.productName, reason: 'product_change' })
          prev.batchActive = false
          prev.batchStartedAt = null
          try {
            await blendTankMesService.processWOEnd({ tankId, productName: prev.productName, detectedAt: new Date().toISOString() })
          } catch (err) {
            console.error(`[BlendTankJob] processWOEnd failed for ${tankId}:`, err.message)
          }
        }

        console.log(`[BlendTankJob] BATCH START detected on ${tankId}: "${productName}"`)
        statusStore.pushEvent('blendTank.batchStart', `${tankId}: "${productName}" started`, { tankId, productName, batchSize, fromEntName, toEntName })
        prev.batchActive = true
        prev.batchStartedAt = Date.now()
        try {
          await blendTankMesService.processWOStart({ tankId, productName, batchSize, fromEntName, toEntName, detectedAt: new Date().toISOString() })
        } catch (err) {
          console.error(`[BlendTankJob] processWOStart failed for ${tankId}:`, err.message)
        }
      }

      if (hasProduct && !prev.batchActive && productName === prev.productName && weightLbs >= WEIGHT_THRESHOLD_LBS) {
        console.log(`[BlendTankJob] BATCH START (weight confirmed) on ${tankId}: "${productName}" (${Math.round(weightLbs).toLocaleString()} lb)`)
        statusStore.pushEvent('blendTank.batchStart', `${tankId}: "${productName}" started (weight)`, { tankId, productName, weightLbs, batchSize })
        prev.batchActive = true
        prev.batchStartedAt = Date.now()
        try {
          await blendTankMesService.processWOStart({ tankId, productName, batchSize, fromEntName, toEntName, detectedAt: new Date().toISOString() })
        } catch (err) {
          console.error(`[BlendTankJob] processWOStart failed for ${tankId}:`, err.message)
        }
      }

      if (hadProduct && !hasProduct && prev.batchActive) {
        console.log(`[BlendTankJob] BATCH END (NOTE_STRING cleared) on ${tankId}: "${prev.productName}"`)
        statusStore.pushEvent('blendTank.batchEnd', `${tankId}: batch ended (NOTE cleared)`, { tankId, productName: prev.productName, reason: 'note_cleared' })
        prev.batchActive = false
        prev.batchStartedAt = null
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
        if (validStr(productName)) prev.productName = productName
        if (validStr(siloName)) prev.siloName = siloName
        if (validStr(requestedBy)) prev.requestedBy = requestedBy
        continue
      }

      const hadProduct = !!prev.productName
      const hasProduct = !!validStr(productName)
      const totalizerReset = prev.prevValue > LINE_RESET_THRESHOLD_LBS && totalizerLbs < LINE_RESET_THRESHOLD_LBS

      if (hasProduct && isUhtDirect(requestedBy) && !prev.uhtActive) {
        const tankId = `${line}→${requestedBy}`
        console.log(`[BlendTankJob] UHT-DIRECT START on ${line}: "${productName}" (${siloName} → ${requestedBy})`)
        statusStore.pushEvent('line.uhtDirectStart', `${line}: UHT-direct "${productName}" (${siloName} → ${requestedBy})`, { line, productName, siloName, destination: requestedBy })

        // The line carries a RAW product (the issue/component); the FG is the
        // pasteurized product landing in whichever surge tank the operator
        // routed this UHT to. Look it up via ThermaRoute.{UHT}_{ST}_Connection_Code.
        const uhtMatch = String(requestedBy || '').match(/(?:UHT|TSTAT)(\d+)/i)
        const uhtIdNum = uhtMatch ? `UHT${uhtMatch[1]}` : null
        let fgProductName = productName
        let surgeTankId = null
        if (uhtIdNum) {
          try {
            const dest = await historian.getUhtDestinationSurgeTank(uhtIdNum)
            if (dest?.surgeTankId) {
              surgeTankId = dest.surgeTankId
              if (dest.productDesc) fgProductName = dest.productDesc
              console.log(`[BlendTankJob] ${line} UHT-direct → ${uhtIdNum} → ${surgeTankId} ("${dest.productDesc || ''}")`)
            } else {
              console.warn(`[BlendTankJob] No connected surge tank for ${uhtIdNum} — using line product as FG`)
            }
          } catch (err) {
            console.error(`[BlendTankJob] getUhtDestinationSurgeTank(${uhtIdNum}) failed:`, err.message)
          }
        }

        try {
          await blendTankMesService.processWOStart({
            tankId,
            productName: fgProductName,
            batchSize: requestedTargetLbs || 0,
            fromEntName: siloName || '',
            toEntName: surgeTankId || requestedBy || '',
            detectedAt: new Date().toISOString(),
          })
        } catch (err) {
          console.error(`[BlendTankJob] processWOStart (UHT) failed for ${tankId}:`, err.message)
        }
        prev.uhtRequestedBy = requestedBy
        prev.uhtActive = true
      }

      if (prev.uhtActive && (totalizerReset || !hasProduct)) {
        const uhtId = `${line}→${prev.uhtRequestedBy}`
        const batchTotalLbs = totalizerReset ? prev.prevValue : (totalizerLbs > 10 ? totalizerLbs : prev.prevValue)
        console.log(`[BlendTankJob] UHT-DIRECT END on ${line}: "${prev.productName}" — ${batchTotalLbs.toFixed(1)} LBS`)
        statusStore.pushEvent('line.uhtDirectEnd', `${line}: UHT-direct ended ${batchTotalLbs.toFixed(0)} LBS "${prev.productName}"`, { line, productName: prev.productName, totalLbs: batchTotalLbs, destination: prev.uhtRequestedBy })

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
        statusStore.pushEvent('line.flowComplete', `${line}: ${batchTotalLbs.toFixed(0)} LBS "${prev.productName}" (${prev.siloName || '?'} → ${prev.requestedBy || '?'})`, { line, totalLbs: batchTotalLbs, productName: prev.productName, siloName: prev.siloName, destination: prev.requestedBy })
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

      if (validStr(productName)) prev.productName = productName
      if (validStr(siloName)) prev.siloName = siloName
      if (validStr(requestedBy)) prev.requestedBy = requestedBy
      if (requestedTargetLbs) prev.requestedTargetLbs = requestedTargetLbs
      prev.prevValue = totalizerLbs
    }

    logStatusSummary(statuses, lineReadings)

    const tanks = statuses.map(s => ({
      ...s,
      batchActive: !!tankState[s.tankId]?.batchActive,
    }))
    statusStore.setBlendTanks({
      tanks,
      lines: lineReadings,
      pollDurationMs: Date.now() - pollStart,
    })

    lastPollTime = new Date()
  } catch (err) {
    console.error('[BlendTankJob] Poll error:', err.message)
    statusStore.pushEvent('blendTank.poll.error', 'Historian poll failed', { error: err.message })
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
