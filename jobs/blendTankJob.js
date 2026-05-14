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

// Sentinel NOTE_STRING values that look like real strings but indicate
// "not in production." Operators (and the PLC defaults) write things like
// "Empty" or "CIP" — treating those as a product false-starts a WO. The
// match is case-insensitive against the trimmed value.
const PRODUCT_SENTINELS = new Set(['', 'none', 'empty', 'cip', 'water', 'sterile', 'n/a', '-', '--'])

function validStr(val) {
  if (val == null) return null
  const trimmed = String(val).trim()
  if (!trimmed) return null
  if (PRODUCT_SENTINELS.has(trimmed.toLowerCase())) return null
  return val
}

const tankState = {
  BlendTank1A: { productName: null, batchActive: false, seeded: false, batchStartedAt: null },
  BlendTank1B: { productName: null, batchActive: false, seeded: false, batchStartedAt: null },
  BlendTank2A: { productName: null, batchActive: false, seeded: false, batchStartedAt: null },
  BlendTank2B: { productName: null, batchActive: false, seeded: false, batchStartedAt: null },
}

const lineState = {
  ML1: { prevValue: null, productName: '', siloName: '', requestedBy: '' },
  ML2: { prevValue: null, productName: '', siloName: '', requestedBy: '' },
  ML3: { prevValue: null, productName: '', siloName: '', requestedBy: '' },
  ML4: { prevValue: null, productName: '', siloName: '', requestedBy: '' },
  CL1: { prevValue: null, productName: '', siloName: '', requestedBy: '' },
  CL2: { prevValue: null, productName: '', siloName: '', requestedBy: '' },
}

let lastPollTime = new Date()

/**
 * Restore in-memory tankState from any 'active' MesBlendTankBatch rows so a
 * service restart picks up where it left off. See surgeTankJob.hydrateFromDb
 * for the full rationale — same design here.
 */
async function hydrateFromDb(MesBlendTankBatch) {
  try {
    const rows = await MesBlendTankBatch.findAll({
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
      console.log(`[BlendTankJob] Hydrated ${tankId} from DB: "${row.productName}" (active since ${row.detectedAt})`)
    }
    console.log(`[BlendTankJob] Hydrated tankState from ${rows.length} active row(s)`)
    return rows.length
  } catch (err) {
    console.error('[BlendTankJob] Hydration failed:', err.message)
    return 0
  }
}

async function run(historian) {
  const pollStart = Date.now()
  try {
    const statuses = await historian.getBlendTankStatus()

    for (const status of statuses) {
      const { tankId, productName, weightLbs, batchSize, fromEntName, toEntName } = status
      const prev = tankState[tankId]
      if (!prev) continue

      if (!prev.seeded) {
        // Don't seed an empty/null product — wait for a real value. If we
        // seed empty here and the next poll returns the real product, it
        // looks like a product-change and false-fires a new WO.
        if (!productName) {
          continue
        }
        prev.productName = productName
        prev.seeded = true
        console.log(`[BlendTankJob] Seeding ${tankId}: product="${productName}"`)
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

      const productCleared = hadProduct && !hasProduct && prev.prevValue > 10
      if ((totalizerReset || productCleared) && hadProduct) {
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

module.exports = { run, getLastPollTime, hydrateFromDb }
