const blendTankMesService = require('../services/blendTankMesService')
const statusStore = require('../services/statusStore')
const db = require('../models')

let lastTickAt = null
let lastSummary = null

/**
 * Tick that drives blend-tank WO issues + completions on a fixed cadence.
 * Production runs every 5 min (TICK_CRON='*/5 * * * *'); sandbox can drop to
 * '*/30 * * * * *' for testing. Each tick:
 *   1. Finds active blend-tank batches.
 *   2. For each, issues a workOrderIssue per-line for the totalizer delta
 *      since the previous tick.
 *   3. Fires a workOrderCompletion for any unaccounted-for cumulative inflow
 *      (mass-balance accounting — total in = total out).
 */
async function run(historian) {
  const startedAt = new Date()
  try {
    const summary = await blendTankMesService.tickAllActiveBatches(historian)
    lastTickAt = startedAt
    lastSummary = summary

    if (summary.batchesProcessed > 0 || summary.errors.length > 0) {
      console.log(`[IssueCompletionJob] tick: ${summary.batchesProcessed} batch(es), ${summary.issuesFired} issue(s), ${summary.completionsFired} completion(s), ${summary.errors.length} error(s)`)
    }
    if (summary.errors.length > 0) {
      statusStore.pushEvent('tick.error', `Tick had ${summary.errors.length} error(s)`, summary.errors)
    }

    // Push the latest authoritative tick state to the in-memory store so the
    // dashboard sees fresh cumulative totals + per-line lastIssued baselines.
    await statusStore.hydrateTickState(db.MesBlendTankBatch, db.MesPipeIssueState)
  } catch (err) {
    console.error('[IssueCompletionJob] Tick run failed:', err.message)
    statusStore.pushEvent('tick.error', 'Tick run failed', { error: err.message })
  }
}

function getLastTickAt() {
  return lastTickAt
}

function getLastSummary() {
  return lastSummary
}

module.exports = { run, getLastTickAt, getLastSummary }
