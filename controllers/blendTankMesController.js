const blendTankMesService = require('../services/blendTankMesService')

/**
 * Receive a blend tank WO start event from MES_Service
 * POST /api/mes/milk/blend-tank/wo-start
 */
exports.processWOStart = async (req, res) => {
  try {
    const result = await blendTankMesService.processWOStart(req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] WO start error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to process WO start',
    })
  }
}

/**
 * Receive a blend tank WO end event from MES_Service
 * POST /api/mes/milk/blend-tank/wo-end
 */
exports.processWOEnd = async (req, res) => {
  try {
    const result = await blendTankMesService.processWOEnd(req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] WO end error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to process WO end',
    })
  }
}

/**
 * Receive a line flow totalizer event from MES_Service
 * POST /api/mes/milk/blend-tank/line-flow
 */
exports.processLineFlow = async (req, res) => {
  try {
    const result = await blendTankMesService.processLineFlow(req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] Line flow error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to process line flow',
    })
  }
}

/**
 * Get active blend tank batches
 * GET /api/mes/milk/blend-tank/active
 */
exports.getActiveBatches = async (req, res) => {
  try {
    const result = await blendTankMesService.getActiveBatches()
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] Get active batches error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get active batches',
    })
  }
}

/**
 * Get components for a specific batch
 * GET /api/mes/milk/blend-tank/:id/components
 */
exports.getBatchComponents = async (req, res) => {
  try {
    const result = await blendTankMesService.getBatchComponents(req.params.id)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] Get batch components error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get batch components',
    })
  }
}

/**
 * Clear stale active batches with no NS work order
 * POST /api/mes/milk/blend-tank/clear-stale
 */
exports.clearStaleBatches = async (req, res) => {
  try {
    const result = await blendTankMesService.clearStaleBatches()
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] Clear stale error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear stale batches',
    })
  }
}

/**
 * Manually issue an ingredient to a blend tank work order
 * POST /api/mes/milk/blend-tank/:id/issue-ingredient
 */
exports.issueIngredient = async (req, res) => {
  try {
    const result = await blendTankMesService.issueIngredient(req.params.id, req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] Issue ingredient error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to issue ingredient',
    })
  }
}

/**
 * Get blend tank batches with optional status filter
 * GET /api/mes/milk/blend-tank/batches
 */
exports.getAllBatches = async (req, res) => {
  try {
    const result = await blendTankMesService.getAllBatches(req.query)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] Get all batches error:', error)
    return res.status(500).json({ success: false, error: error.message || 'Failed to get batches' })
  }
}

/**
 * Retry a pending_ns/error blend tank batch with an optional NS item override
 * POST /api/mes/milk/blend-tank/batches/:id/retry
 */
exports.retryBatch = async (req, res) => {
  try {
    const result = await blendTankMesService.retryBlendBatch(req.params.id, {
      nsItemId: req.body.nsItemId || null,
      decidedBy: req.body.decidedBy || null,
    })
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] Retry batch error:', error)
    return res.status(400).json({ success: false, error: error.message || 'Failed to retry batch' })
  }
}

/**
 * Reject a pending_ns/error blend tank batch
 * POST /api/mes/milk/blend-tank/batches/:id/reject
 */
exports.rejectBatch = async (req, res) => {
  try {
    const result = await blendTankMesService.rejectBlendBatch(req.params.id, {
      decidedBy: req.body.decidedBy || null,
      reason: req.body.reason || null,
    })
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] Reject batch error:', error)
    return res.status(400).json({ success: false, error: error.message || 'Failed to reject batch' })
  }
}

/**
 * Get blend tank product options for the review UI
 * GET /api/mes/milk/blend-tank/product-options
 */
exports.getProductOptions = async (req, res) => {
  try {
    const result = blendTankMesService.getBlendProductOptions()
    return res.status(200).json(result)
  } catch (error) {
    console.error('[BlendTankController] Get product options error:', error)
    return res.status(500).json({ success: false, error: error.message || 'Failed to get product options' })
  }
}
