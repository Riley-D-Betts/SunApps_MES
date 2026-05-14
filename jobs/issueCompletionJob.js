const blendTankMesService = require('../services/blendTankMesService')
const surgeTankMesService = require('../services/surgeTankMesService')
const statusStore = require('../services/statusStore')
const db = require('../models')

let lastTickAt = null
let lastSummary = null
let lastSurgeSummary = null

/**
 * Tick that drives blend-tank WO issues + completions on a fixed cadence.
 * Cadence is governed by TICK_CRON (see config/index.js — production every
 * 5 min; sandbox can drop to every 30 sec for testing).
 *
 * Each tick:
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
      console.log(`[IssueCompletionJob] blend tick: ${summary.batchesProcessed} batch(es), ${summary.issuesFired} issue(s), ${summary.completionsFired} completion(s), ${summary.errors.length} error(s)`)
    }
    if (summary.errors.length > 0) {
      statusStore.pushEvent('tick.error', `Blend tick had ${summary.errors.length} error(s)`, summary.errors)
    }

    // Surge tank tick rides the same cadence — each fires its own NS issues +
    // completions per active batch and they are independent of blend tank state.
    try {
      const surgeSummary = await surgeTankMesService.tickAllActiveBatches(historian)
      lastSurgeSummary = surgeSummary
      if (surgeSummary.batchesProcessed > 0 || surgeSummary.errors.length > 0) {
        console.log(`[IssueCompletionJob] surge tick: ${surgeSummary.batchesProcessed} batch(es), ${surgeSummary.issuesFired} issue(s), ${surgeSummary.completionsFired} completion(s), ${surgeSummary.errors.length} error(s)`)
      }
      if (surgeSummary.errors.length > 0) {
        statusStore.pushEvent('tick.error', `Surge tick had ${surgeSummary.errors.length} error(s)`, surgeSummary.errors)
      }
    } catch (err) {
      console.error('[IssueCompletionJob] Surge tick failed:', err.message)
      statusStore.pushEvent('tick.error', 'Surge tick failed', { error: err.message })
    }

    // Push the latest authoritative tick state to the in-memory store so the
    // dashboard sees fresh cumulative totals + per-line lastIssued baselines
    // for both blend and surge tank batches.
    await statusStore.hydrateTickState(
      db.MesBlendTankBatch, db.MesPipeIssueState,
      db.MesSurgeTankBatch, db.MesSurgeTankIssueState,
    )
    // Refresh recent-batches rings so closed batches show up promptly.
    await statusStore.hydrateRecentBlendBatches(db.MesBlendTankBatch)
    await statusStore.hydrateRecentSurgeBatches(db.MesSurgeTankBatch)
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

function getLastSurgeSummary() {
  return lastSurgeSummary
}

module.exports = { run, getLastTickAt, getLastSummary, getLastSurgeSummary }
