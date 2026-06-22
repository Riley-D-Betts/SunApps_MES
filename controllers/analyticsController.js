'use strict'

const analyticsService = require('../services/analyticsService')
const inventoryAdjustmentService = require('../services/inventoryAdjustmentService')

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
