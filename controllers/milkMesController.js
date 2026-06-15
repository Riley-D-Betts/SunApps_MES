const milkMesService = require('../services/milkMesService')
const itemConfig = require('../services/mesItemConfig')
const db = require('../models')

/**
 * Product-index options for the Separation Review edit dropdowns. Mirrors the
 * separator HMI's product config (1-40) → NS item. GET /api/mes/milk/separation/product-indices
 */
exports.getProductIndexOptions = async (req, res) => {
  try {
    const options = Object.entries(itemConfig.PRODUCT_INDEX_ITEM_MAP).map(([index, item]) => ({
      productIndex: Number(index),
      name: item.name,
      nsItemId: item.id,
    }))
    return res.status(200).json({ success: true, options })
  } catch (error) {
    console.error('[MilkMesController] Get product index options error:', error)
    return res.status(500).json({ success: false, error: error.message || 'Failed to get product indices' })
  }
}

/**
 * Receive a raw separator batch from MES_Service
 * POST /api/mes/milk/separation/batch
 */
exports.processSeparationBatch = async (req, res) => {
  try {
    const result = await milkMesService.processSeparationBatch(req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[MilkMesController] Separation batch error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to process separation batch',
    })
  }
}

/**
 * Receive a raw bulk milk flow reading from MES_Service
 * POST /api/mes/milk/bulk-milk/flow
 */
exports.processBulkMilkFlow = async (req, res) => {
  try {
    const result = await milkMesService.processBulkMilkFlow(req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[MilkMesController] Bulk milk flow error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to process bulk milk flow',
    })
  }
}

/**
 * Register a bulk milk work order for auto-consumption
 * POST /api/mes/milk/bulk-milk/register
 */
exports.registerBulkMilkRun = async (req, res) => {
  try {
    const result = await milkMesService.registerBulkMilkRun(req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[MilkMesController] Register bulk milk run error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to register bulk milk run',
    })
  }
}

/**
 * Complete a bulk milk run
 * POST /api/mes/milk/bulk-milk/complete
 */
exports.completeBulkMilkRun = async (req, res) => {
  try {
    const result = await milkMesService.completeBulkMilkRun(req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[MilkMesController] Complete bulk milk run error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to complete bulk milk run',
    })
  }
}

/**
 * Get all separation batches (most recent first)
 * GET /api/mes/milk/separation/batches?limit=50
 */
exports.getSeparationBatches = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50
    // Optional ?status=pending_ns,error filter (comma-separated) so the
    // Separation Review screen can pull just the backlog.
    const where = {}
    if (req.query.status) {
      const statuses = String(req.query.status).split(',').map(s => s.trim()).filter(Boolean)
      if (statuses.length) where.status = statuses.length === 1 ? statuses[0] : statuses
    }
    const batches = await db.MesSeparationBatch.findAll({
      where,
      order: [['createdAt', 'DESC']],
      limit,
    })
    return res.status(200).json({ success: true, count: batches.length, batches })
  } catch (error) {
    console.error('[MilkMesController] Get separation batches error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get separation batches',
    })
  }
}

/**
 * Retry a pending_ns/error separation batch with operator-corrected product
 * indices. POST /api/mes/milk/separation/batches/:id/retry
 * Body: { skimProductIndex?, sourceProductIndex?, creamProductIndex?, decidedBy? }
 */
exports.retrySeparationBatch = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'Invalid batch id' })
    }
    const { skimProductIndex, sourceProductIndex, creamProductIndex, decidedBy } = req.body || {}
    const { result, batch } = await milkMesService.retrySeparationBatch(id, {
      skimProductIndex, sourceProductIndex, creamProductIndex, decidedBy,
    })
    return res.status(200).json({ success: true, result, batch })
  } catch (error) {
    console.error('[MilkMesController] Retry separation batch error:', error)
    const status = /not found/i.test(error.message) ? 404
      : /can be retried|no skim/i.test(error.message) ? 400 : 500
    return res.status(status).json({ success: false, error: error.message || 'Failed to retry separation batch' })
  }
}

/**
 * Reject (dismiss) a pending_ns/error separation batch.
 * POST /api/mes/milk/separation/batches/:id/reject
 * Body: { decidedBy?, reason? }
 */
exports.rejectSeparationBatch = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'Invalid batch id' })
    }
    const { decidedBy, reason } = req.body || {}
    const batch = await milkMesService.rejectSeparationBatch(id, { decidedBy, reason })
    return res.status(200).json({ success: true, batch })
  } catch (error) {
    console.error('[MilkMesController] Reject separation batch error:', error)
    const status = /not found/i.test(error.message) ? 404 : 500
    return res.status(status).json({ success: false, error: error.message || 'Failed to reject separation batch' })
  }
}

/**
 * Get active bulk milk runs
 * GET /api/mes/milk/bulk-milk/active
 */
exports.getActiveBulkMilkRuns = async (req, res) => {
  try {
    const result = await milkMesService.getActiveBulkMilkRuns()
    return res.status(200).json(result)
  } catch (error) {
    console.error('[MilkMesController] Get active bulk milk runs error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get active bulk milk runs',
    })
  }
}
