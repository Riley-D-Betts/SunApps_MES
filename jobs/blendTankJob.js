const blendTankMesService = require('../services/blendTankMesService')
const notifyService = require('../services/notifyService')
const statusStore = require('../services/statusStore')

// All-lines-stopped idle window. Once every feeding line has been quiet
// (inactive or no totalizer advance) for this long, the batch closes with
// reason='all_lines_stopped'. Matches the BATCH_LIFECYCLE_PLAN.md spec.
const ALL_LINES_STOPPED_IDLE_MS = 5 * 60 * 1000

const LINE_RESET_THRESHOLD_LBS = 100

// Atlas WO lifecycle string that means "production WO is active." Any other
// value (Complete / CIP / Idle / Sterile / …) is treated as non-eligible.
const WO_STATE_RUNNING = 'Running'

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

// Per-tank in-memory state. `hasSeenFlow` gates the 5-min all-lines-stopped
// idle close — a batch that opens because WOState went Running but never
// sees line flow (a sitting tank between fill and drain) must NOT auto-close.
// The idle timer only arms once at least one line tick has fed the tank.
const tankState = {
  BlendTank1A: { productName: null, currentWOState: null, batchActive: false, seeded: false, batchStartedAt: null, lastFlowAt: null, hasSeenFlow: false },
  BlendTank1B: { productName: null, currentWOState: null, batchActive: false, seeded: false, batchStartedAt: null, lastFlowAt: null, hasSeenFlow: false },
  BlendTank2A: { productName: null, currentWOState: null, batchActive: false, seeded: false, batchStartedAt: null, lastFlowAt: null, hasSeenFlow: false },
  BlendTank2B: { productName: null, currentWOState: null, batchActive: false, seeded: false, batchStartedAt: null, lastFlowAt: null, hasSeenFlow: false },
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
 * service restart picks up where it left off. lastFlowAt seeds to now so the
 * 5-min all-lines-stopped timer effectively restarts on boot rather than
 * closing immediately.
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
    const now = Date.now()
    for (const tankId of Object.keys(tankState)) {
      const row = newestByTank[tankId]
      if (!row) continue
      tankState[tankId].productName = row.productName
      tankState[tankId].currentWOState = WO_STATE_RUNNING
      tankState[tankId].batchActive = true
      tankState[tankId].seeded = true
      tankState[tankId].batchStartedAt = row.detectedAt ? new Date(row.detectedAt).getTime() : now
      tankState[tankId].lastFlowAt = now
      // Conservatively assume past-life flow happened. Without this, the
      // 5-min idle timer would never arm post-restart even for batches that
      // had been actively filled before. If no flow arrives within 5 min,
      // batch closes; if flow does arrive, lastFlowAt advances normally.
      tankState[tankId].hasSeenFlow = true
      console.log(`[BlendTankJob] Hydrated ${tankId} from DB: "${row.productName}" (active since ${row.detectedAt})`)
    }
    console.log(`[BlendTankJob] Hydrated tankState from ${rows.length} active row(s)`)
    return rows.length
  } catch (err) {
    console.error('[BlendTankJob] Hydration failed:', err.message)
    return 0
  }
}

function linesFeedingTank(lineReadings, tankId) {
  return lineReadings.filter(r => {
    if (r.requestedBy !== tankId) return false
    if (!r.active) return false
    const prev = lineState[r.line]
    if (!prev || prev.prevValue === null) return false
    return r.totalizerLbs > prev.prevValue
  })
}

async function startBatch(tankId, prev, status, reason) {
  const { productName, batchSize, fromEntName, toEntName } = status
  console.log(`[BlendTankJob] BATCH START on ${tankId}: "${productName}" (${reason})`)
  statusStore.pushEvent('blendTank.batchStart', `${tankId}: "${productName}" started`, { tankId, productName, batchSize, fromEntName, toEntName, reason })
  prev.batchActive = true
  prev.batchStartedAt = Date.now()
  prev.lastFlowAt = null
  prev.hasSeenFlow = false
  try {
    await blendTankMesService.processWOStart({ tankId, productName, batchSize, fromEntName, toEntName, detectedAt: new Date().toISOString() })
  } catch (err) {
    console.error(`[BlendTankJob] processWOStart failed for ${tankId}:`, err.message)
  }
}

async function endBatch(tankId, prev, reason) {
  console.log(`[BlendTankJob] BATCH END (${reason}) on ${tankId}: "${prev.productName}"`)
  statusStore.pushEvent('blendTank.batchEnd', `${tankId}: batch ended (${reason})`, { tankId, productName: prev.productName, reason })
  const productName = prev.productName
  prev.batchActive = false
  prev.batchStartedAt = null
  prev.lastFlowAt = null
  prev.hasSeenFlow = false
  try {
    await blendTankMesService.processWOEnd({ tankId, productName, detectedAt: new Date().toISOString() })
  } catch (err) {
    console.error(`[BlendTankJob] processWOEnd failed for ${tankId}:`, err.message)
  }
}

async function run(historian) {
  const pollStart = Date.now()
  try {
    const statuses = await historian.getBlendTankStatus()
    const lineReadings = await historian.getMilkLineStatus()
    const now = Date.now()

    for (const status of statuses) {
      const { tankId, productName, currentWOState } = status
      const prev = tankState[tankId]
      if (!prev) continue

      const hasProduct = !!validStr(productName)
      const hadProduct = !!prev.productName
      const isRunning = currentWOState === WO_STATE_RUNNING
      const wasRunning = prev.currentWOState === WO_STATE_RUNNING
      const feedingLines = linesFeedingTank(lineReadings, tankId)
      if (feedingLines.length > 0) {
        prev.lastFlowAt = now
        prev.hasSeenFlow = true
      }

      if (!prev.seeded) {
        // First poll: snapshot the current state without firing events. If the
        // tank is already Running with a product when we boot, hydrateFromDb
        // should have already opened the batch; we just record observed values.
        if (!productName && !currentWOState) continue
        prev.productName = productName
        prev.currentWOState = currentWOState
        prev.seeded = true
        console.log(`[BlendTankJob] Seeding ${tankId}: product="${productName}" WOState="${currentWOState}"`)
        continue
      }

      // ── END pass ──────────────────────────────────────────────────────
      // Order matters: explicit WO/state signals take priority over the
      // line-flow idle test so a CIP that pauses lines mid-batch closes
      // immediately rather than waiting 5 min. The all_lines_stopped check
      // only arms once we've actually seen flow on this batch — batches that
      // open from WOState=Running on a sitting tank shouldn't auto-close.
      let endReason = null
      if (prev.batchActive) {
        if (wasRunning && !isRunning) endReason = 'wo_state_left_running'
        else if (hadProduct && !hasProduct) endReason = 'note_cleared'
        else if (hasProduct && productName !== prev.productName) endReason = 'product_change'
        else if (prev.hasSeenFlow && prev.lastFlowAt && (now - prev.lastFlowAt) > ALL_LINES_STOPPED_IDLE_MS) endReason = 'all_lines_stopped'
      }
      if (endReason) {
        await endBatch(tankId, prev, endReason)
      }

      // ── START pass ────────────────────────────────────────────────────
      // Open a batch as soon as Atlas marks the WO Running and NOTE_STRING
      // is a recognized product — the WO exists at that moment regardless
      // of whether line flow is happening right this tick. Sitting tanks
      // between fill and drain still need to be tracked. Line flow drives
      // workOrderIssue + workOrderCompletion as before; it's not required
      // to OPEN the batch. Same-tick reopen still possible after a
      // product_change end.
      if (!prev.batchActive && hasProduct && isRunning) {
        const reason = feedingLines.length > 0 ? 'WOState=Running + flow' : 'WOState=Running'
        await startBatch(tankId, prev, status, reason)
      }

      prev.productName = productName
      prev.currentWOState = currentWOState
    }

    // Line tail-catcher — unchanged. Captures totalizer resets between ticks
    // so flows that completed inside one 5-min tick window aren't lost.
    for (const reading of lineReadings) {
      const { line, totalizerLbs, productName, siloName, requestedBy, requestedTargetLbs } = reading
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
    const wo = s.currentWOState ? ` WO=${s.currentWOState}` : ''
    return `  ${s.tankId}: [${active}]${wo} ${product} (${weight})`
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
