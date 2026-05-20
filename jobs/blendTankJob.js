const blendTankMesService = require('../services/blendTankMesService')
const notifyService = require('../services/notifyService')
const statusStore = require('../services/statusStore')
const productParser = require('../services/blendTankProductParser')

// All-lines-stopped idle window. Once every feeding line has been quiet
// (inactive or no totalizer advance) for this long, the batch closes with
// reason='all_lines_stopped'. Matches the BATCH_LIFECYCLE_PLAN.md spec.
const ALL_LINES_STOPPED_IDLE_MS = 5 * 60 * 1000

const LINE_RESET_THRESHOLD_LBS = 100

// Atlas WO lifecycle tags (CurrentWOState, JobRunning, CurrentWO, CurrentItem)
// were observed frozen in the historian for 24+ hours across all four blend
// tanks — Atlas is no longer maintaining that namespace. We still pass the
// value through to dashboard/logging as advisory, but it does NOT drive batch
// open/close. NOTE_STRING + actual line flow are the only signals trusted to
// decide when a batch is running.

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
  ML1: { prevValue: null, productName: '', siloName: '', requestedBy: '', prevMemTotalizer: 0 },
  ML2: { prevValue: null, productName: '', siloName: '', requestedBy: '', prevMemTotalizer: 0 },
  ML3: { prevValue: null, productName: '', siloName: '', requestedBy: '', prevMemTotalizer: 0 },
  ML4: { prevValue: null, productName: '', siloName: '', requestedBy: '', prevMemTotalizer: 0 },
  CL1: { prevValue: null, productName: '', siloName: '', requestedBy: '', prevMemTotalizer: 0 },
  CL2: { prevValue: null, productName: '', siloName: '', requestedBy: '', prevMemTotalizer: 0 },
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

// Match line.requestedBy to the tank using the same canonical normalizer the
// flow-consumer paths use (BT2A ↔ BlendTank2A). Without this, SCADA writing
// the short form would silently fail the exact-string check and the tank
// would never see a feeding line, blocking the line-flow batch-open path.
function linesFeedingTank(lineReadings, tankId) {
  const tankCanonical = blendTankMesService.normalizeTankRef(tankId)
  return lineReadings.filter(r => {
    if (!r.active) return false
    const reqCanonical = blendTankMesService.normalizeTankRef(r.requestedBy)
    if (!reqCanonical || !tankCanonical || reqCanonical !== tankCanonical) return false
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
      const feedingLines = linesFeedingTank(lineReadings, tankId)
      if (feedingLines.length > 0) {
        prev.lastFlowAt = now
        prev.hasSeenFlow = true
      }

      if (!prev.seeded) {
        // First poll: snapshot the current state without firing events. If a
        // batch was active in DB when we booted, hydrateFromDb has already
        // re-opened it; we just record observed values.
        if (!productName && !currentWOState) continue
        prev.productName = productName
        prev.currentWOState = currentWOState
        prev.seeded = true
        console.log(`[BlendTankJob] Seeding ${tankId}: product="${productName}" WOState="${currentWOState}" (advisory only)`)
        continue
      }

      // ── END pass ──────────────────────────────────────────────────────
      // Atlas's CurrentWOState is frozen on these tanks and can't be trusted,
      // so close decisions come from NOTE_STRING activity and the line-flow
      // idle timer. all_lines_stopped only arms once we've actually seen flow
      // on this batch — opening a batch from a stale product name and then
      // sitting idle would otherwise close prematurely.
      let endReason = null
      if (prev.batchActive) {
        if (hadProduct && !hasProduct) endReason = 'note_cleared'
        else if (hasProduct && productName !== prev.productName) endReason = 'product_change'
        else if (prev.hasSeenFlow && prev.lastFlowAt && (now - prev.lastFlowAt) > ALL_LINES_STOPPED_IDLE_MS) endReason = 'all_lines_stopped'
      }
      if (endReason) {
        await endBatch(tankId, prev, endReason)
      }

      // ── START pass ────────────────────────────────────────────────────
      // Open a batch only when an actual line is currently feeding this tank
      // AND NOTE_STRING names a real product. CurrentWOState=Running is no
      // longer a trigger — Atlas's tag is stale (stuck Running for ~26 days
      // on BT1A, "Complete" forever on BT1B/2A/2B), so trusting it caused
      // continuous flap-open after every idle close.
      if (!prev.batchActive && hasProduct && feedingLines.length > 0) {
        const reason = `line flow (${feedingLines.map(l => l.line).join(',')})`
        await startBatch(tankId, prev, status, reason)
      }

      prev.productName = productName
      prev.currentWOState = currentWOState
    }

    // Line tail-catcher — captures totalizer resets between ticks so flows
    // that completed inside one polling window aren't lost. Routing data
    // (destination, source silo, product) comes from MEM* tags, which SCADA
    // latches the moment BATCHTOTALIZER resets. The live REQUESTEDBY /
    // CURRENTSILONAME / CURRENTSILOPRODUCTNAME tags clear to "None" at that
    // same moment, so if a poll lands here we wouldn't have the routing
    // string otherwise — caching the live values from prior polls was racy
    // (a flow that ran entirely between two polls would leave them empty).
    for (const reading of lineReadings) {
      const {
        line, totalizerLbs, productName, siloName, requestedBy, requestedTargetLbs,
        memRequestedBy, memSiloName, memProductName, memTotalizerLbs,
      } = reading
      const prev = lineState[line]
      if (!prev) continue

      if (prev.prevValue === null) {
        prev.prevValue = totalizerLbs
        if (validStr(productName)) prev.productName = productName
        if (validStr(siloName)) prev.siloName = siloName
        if (validStr(requestedBy)) prev.requestedBy = requestedBy
        prev.prevMemTotalizer = memTotalizerLbs || 0
        continue
      }

      const hadProduct = !!prev.productName
      const hasProduct = !!validStr(productName)
      const totalizerReset = prev.prevValue > LINE_RESET_THRESHOLD_LBS && totalizerLbs < LINE_RESET_THRESHOLD_LBS
      const memTotalizerAdvanced = (memTotalizerLbs || 0) > (prev.prevMemTotalizer || 0) + LINE_RESET_THRESHOLD_LBS

      const productCleared = hadProduct && !hasProduct && prev.prevValue > 10
      if ((totalizerReset || productCleared || memTotalizerAdvanced) && (hadProduct || validStr(memProductName))) {
        // Prefer MEM tags — they're SCADA's authoritative "just completed"
        // record. Fall back to cached live values for any field that's empty.
        const flowProduct = validStr(memProductName) || prev.productName
        const flowSilo = validStr(memSiloName) || prev.siloName || ''
        const flowDest = validStr(memRequestedBy) || prev.requestedBy || ''
        const batchTotalLbs = memTotalizerLbs > 0
          ? memTotalizerLbs
          : (totalizerReset ? prev.prevValue : (totalizerLbs > 10 ? totalizerLbs : prev.prevValue))

        console.log(`[BlendTankJob] Line ${line} batch complete: ${batchTotalLbs.toFixed(1)} LBS of "${flowProduct}" (${flowSilo} → ${flowDest})`)
        statusStore.pushEvent('line.flowComplete', `${line}: ${batchTotalLbs.toFixed(0)} LBS "${flowProduct}" (${flowSilo || '?'} → ${flowDest || '?'})`, { line, totalLbs: batchTotalLbs, productName: flowProduct, siloName: flowSilo, destination: flowDest })
        try {
          await blendTankMesService.processLineFlow({
            line, totalLbs: batchTotalLbs, lineProductName: flowProduct,
            siloName: flowSilo, destination: flowDest,
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
      prev.prevMemTotalizer = memTotalizerLbs || 0
    }

    logStatusSummary(statuses, lineReadings)

    // Parse NOTE_STRING up-front so the dashboard can show the resolved item
    // (NS id + confidence + name) even before a batch opens. The same parser
    // runs at batch-open time in processWOStart, but waiting for that means
    // operators stare at a raw "Kirkland Whole" string with no NS context
    // until a feeding line fires. Cheap to run every poll — pure string match.
    const tanks = statuses.map(s => {
      const parsed = s.productName ? productParser.parseProductName(s.productName) : null
      return {
        ...s,
        batchActive: !!tankState[s.tankId]?.batchActive,
        parsed: parsed
          ? { nsId: parsed.nsId, name: parsed.name, confidence: parsed.confidence }
          : (s.productName ? { nsId: null, name: null, confidence: 'none' } : null),
      }
    })
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
