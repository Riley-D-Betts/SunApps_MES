'use strict'

const analyticsService = require('../services/analyticsService')

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
    const { from, to, groupBy } = req.query
    const points = await analyticsService.getBlendTrend({ from, to, groupBy })
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
    const { from, to, groupBy } = req.query
    const points = await analyticsService.getSurgeTrend({ from, to, groupBy })
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
    const { from, to, groupBy } = req.query
    const points = await analyticsService.getSeparationTrend({ from, to, groupBy })
    return res.json({ success: true, points })
  } catch (err) {
    console.error('[analyticsController] separation trend:', err)
    return res.status(500).json({ success: false, error: err.message })
  }
}
