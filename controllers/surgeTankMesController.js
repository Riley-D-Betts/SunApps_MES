const surgeTankMesService = require('../services/surgeTankMesService')

/**
 * Get surge tank batches with optional status filter
 * GET /api/mes/milk/surge-tank/batches
 */
exports.getAllBatches = async (req, res) => {
  try {
    const result = await surgeTankMesService.getAllBatches(req.query)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[SurgeTankController] Get all batches error:', error)
    return res.status(500).json({ success: false, error: error.message || 'Failed to get batches' })
  }
}

/**
 * Retry a pending_ns/error surge tank batch with an optional NS item override
 * POST /api/mes/milk/surge-tank/batches/:id/retry
 */
exports.retryBatch = async (req, res) => {
  try {
    const result = await surgeTankMesService.retrySurgeBatch(req.params.id, {
      nsItemId: req.body.nsItemId || null,
      decidedBy: req.body.decidedBy || null,
    })
    return res.status(200).json(result)
  } catch (error) {
    console.error('[SurgeTankController] Retry batch error:', error)
    return res.status(400).json({ success: false, error: error.message || 'Failed to retry batch' })
  }
}

/**
 * Reject a pending_ns/error surge tank batch
 * POST /api/mes/milk/surge-tank/batches/:id/reject
 */
exports.rejectBatch = async (req, res) => {
  try {
    const result = await surgeTankMesService.rejectSurgeBatch(req.params.id, {
      decidedBy: req.body.decidedBy || null,
      reason: req.body.reason || null,
    })
    return res.status(200).json(result)
  } catch (error) {
    console.error('[SurgeTankController] Reject batch error:', error)
    return res.status(400).json({ success: false, error: error.message || 'Failed to reject batch' })
  }
}

/**
 * Get surge tank product options for the review UI
 * GET /api/mes/milk/surge-tank/product-options
 */
exports.getProductOptions = async (req, res) => {
  try {
    const result = surgeTankMesService.getSurgeProductOptions()
    return res.status(200).json(result)
  } catch (error) {
    console.error('[SurgeTankController] Get product options error:', error)
    return res.status(500).json({ success: false, error: error.message || 'Failed to get product options' })
  }
}
