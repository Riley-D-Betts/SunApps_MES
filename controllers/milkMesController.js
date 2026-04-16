const milkMesService = require('../services/milkMesService')
const db = require('../models')

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
    const batches = await db.MesSeparationBatch.findAll({
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
