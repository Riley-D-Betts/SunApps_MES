'use strict'

const analyticsService = require('../services/analyticsService')
const inventoryAdjustmentService = require('../services/inventoryAdjustmentService')
const adjustmentCorrelationService = require('../services/adjustmentCorrelationService')
const lossReportService = require('../services/lossReportService')
const lossDigestJob = require('../jobs/lossDigestJob')

function pick(obj, keys) {
  const out = {}
  for (const k of keys) if (k in obj) out[k] = obj[k]
  return out
}

// ── Blend Tanks ───────────────────────────────────────────────────────────────

exports.getBlendBatches = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'tankId', 'status', 'product', 'sortBy', 'sortDir', 'limit', 'offset'])
    const result = await analyticsService.getBlendBatches(params)
    return res.json({ success: true, ...result })
  } catch (err) {
    console.error('[analyticsController] blend batches:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

exports.getBlendTrend = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'groupBy', 'tankId', 'status', 'product'])
    const points = await analyticsService.getBlendTrend(params)
    return res.json({ success: true, points })
  } catch (err) {
    console.error('[analyticsController] blend trend:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

// ── Surge Tanks ───────────────────────────────────────────────────────────────

exports.getSurgeBatches = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'tankId', 'status', 'product', 'sortBy', 'sortDir', 'limit', 'offset'])
    const result = await analyticsService.getSurgeBatches(params)
    return res.json({ success: true, ...result })
  } catch (err) {
    console.error('[analyticsController] surge batches:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

exports.getSurgeTrend = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'groupBy', 'tankId', 'status', 'product'])
    const points = await analyticsService.getSurgeTrend(params)
    return res.json({ success: true, points })
  } catch (err) {
    console.error('[analyticsController] surge trend:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

// ── Separation ────────────────────────────────────────────────────────────────

exports.getSeparationBatches = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'sourceSilo', 'status', 'sortBy', 'sortDir', 'limit', 'offset'])
    const result = await analyticsService.getSeparationBatches(params)
    return res.json({ success: true, ...result })
  } catch (err) {
    console.error('[analyticsController] separation batches:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

exports.getSeparationTrend = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'groupBy', 'sourceSilo', 'status'])
    const points = await analyticsService.getSeparationTrend(params)
    return res.json({ success: true, points })
  } catch (err) {
    console.error('[analyticsController] separation trend:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

// ── Inventory Adjustments ───────────────────────────────────────────────────

exports.getInventoryAdjustments = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'source', 'status', 'binId', 'itemId', 'tankName', 'excludePositiveSilo', 'sortBy', 'sortDir', 'limit', 'offset'])
    const result = await analyticsService.getInventoryAdjustments(params)
    return res.json({ success: true, ...result })
  } catch (err) {
    console.error('[analyticsController] inventory adjustments:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

// Correlate each adjustment back to the WO / assembly-unbuild / batch that
// triggered it. Same filters as getInventoryAdjustments, plus a per-row
// `correlation` block and a correlationStats summary of match quality.
exports.getInventoryAdjustmentCorrelations = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'source', 'status', 'binId', 'itemId', 'tankName', 'excludePositiveSilo', 'sortBy', 'sortDir', 'limit', 'offset'])
    const result = await adjustmentCorrelationService.getInventoryAdjustmentCorrelations(params)
    return res.json({ success: true, ...result })
  } catch (err) {
    console.error('[analyticsController] inventory adjustment correlations:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

// Holistic batch-centric view: each batch in the window with the inventory
// adjustments correlated to it + per-batch rollups. Drives the Batch Adjustments page.
exports.getBatchesWithAdjustments = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'kind', 'onlyWithAdjustments', 'limit'])
    const result = await adjustmentCorrelationService.getBatchesWithAdjustments(params)
    return res.json({ success: true, ...result })
  } catch (err) {
    console.error('[analyticsController] batches with adjustments:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

// Everything about one batch for the dedicated batch-detail page: full record,
// correlated adjustments + rollup, transaction counts + processing log, bins,
// lots, ingredient inflows, and separation destinations (local read).
exports.getBatchDetail = async (req, res) => {
  try {
    const { kind, id } = req.params
    const result = await adjustmentCorrelationService.getBatchDetail({ kind, id })
    return res.json({ success: true, ...result })
  } catch (err) {
    console.error('[analyticsController] batch detail:', err)
    const code = /not found|unknown batch kind/.test(err.message) ? 404 : 500
    return res.status(code).json({ success: false, error: err.message })
  }
}

// Pull one batch's ACTUAL transactions from NetSuite (issues/completions/
// unbuild/adjustments) by the NS ids we recorded — source-of-truth reconciliation.
exports.getBatchNetSuiteTransactions = async (req, res) => {
  try {
    const { kind, id } = req.params
    const result = await adjustmentCorrelationService.getBatchNetSuiteTransactions({ kind, id })
    return res.json({ success: true, ...result })
  } catch (err) {
    console.error('[analyticsController] batch netsuite transactions:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

// Re-post an errored/skipped adjustment, with optional operator corrections
// (bin / item / qty / lot). Drives the Inventory Adjustment Review Retry button.
exports.retryInventoryAdjustment = async (req, res) => {
  try {
    const { binId, itemId, qtyDelta, tankName, lotName, decidedBy } = req.body || {}
    const out = await inventoryAdjustmentService.retryInventoryAdjustment(req.params.id, {
      binId, itemId, qtyDelta, tankName, lotName, decidedBy,
    })
    return res.json({ success: true, ...out })
  } catch (err) {
    console.error('[analyticsController] retry inventory adjustment:', err)
    return res.status(400).json({ success: false, error: err.message })
  }
}

// Dismiss an adjustment that shouldn't post (status -> 'rejected').
exports.rejectInventoryAdjustment = async (req, res) => {
  try {
    const { decidedBy, reason } = req.body || {}
    const out = await inventoryAdjustmentService.rejectInventoryAdjustment(req.params.id, { decidedBy, reason })
    return res.json({ success: true, ...out })
  } catch (err) {
    console.error('[analyticsController] reject inventory adjustment:', err)
    return res.status(400).json({ success: false, error: err.message })
  }
}

exports.getInventoryAdjustmentTrend = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'groupBy', 'source', 'status', 'excludePositiveSilo'])
    const points = await analyticsService.getInventoryAdjustmentTrend(params)
    return res.json({ success: true, points })
  } catch (err) {
    console.error('[analyticsController] inventory adjustment trend:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}

// ── Milk Loss executive report (SD-729) ──────────────────────────────────────

function fail(res, label, err) {
  const status = err.status && err.status >= 400 && err.status < 500 ? err.status : 500
  if (status === 500) console.error(`[analyticsController] ${label}:`, err)
  return res.status(status).json({ success: false, error: err.message })
}

exports.getLossReport = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'groupBy', 'compare', 'ignoreUpperBounds'])
    const report = await lossReportService.getLossReport({ ...params, historian: req.app.locals.historian })
    return res.json({ success: true, ...report })
  } catch (err) {
    return fail(res, 'loss report', err)
  }
}

exports.getLossHistory = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to', 'groupBy', 'by', 'ignoreUpperBounds'])
    const history = await lossReportService.getLossHistory(params)
    return res.json({ success: true, ...history })
  } catch (err) {
    return fail(res, 'loss history', err)
  }
}

exports.rollupLossHistory = async (req, res) => {
  try {
    const { from, to } = { ...req.query, ...(req.body || {}) }
    if (!from || !to) return res.status(400).json({ success: false, error: 'from and to (YYYY-MM-DD plant days, inclusive) are required' })
    const result = await lossReportService.rollupDaily({ fromDay: String(from).slice(0, 10), toDay: String(to).slice(0, 10) })
    return res.json({ success: true, ...result })
  } catch (err) {
    return fail(res, 'loss rollup', err)
  }
}

exports.getLossDigestPreview = async (req, res) => {
  try {
    const params = pick(req.query, ['from', 'to'])
    const preview = await lossDigestJob.preview(params)
    return res.json({ success: true, ...preview })
  } catch (err) {
    return fail(res, 'loss digest preview', err)
  }
}
