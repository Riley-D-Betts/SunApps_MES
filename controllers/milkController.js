const milkService = require('../services/milkService')

/**
 * Create assembly unbuild for milk separation
 * POST /api/milk/separation/unbuild
 */
async function createSeparationUnbuild(req, res) {
  try {
    const result = await milkService.createSeparationUnbuild(req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[MilkController] Separation unbuild error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to create separation unbuild',
    })
  }
}

/**
 * Create a new bulk milk work order
 * POST /api/milk/bulk-work-order
 */
async function createBulkMilkWorkOrder(req, res) {
  try {
    const result = await milkService.createBulkMilkWorkOrder(req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[MilkController] Create bulk milk WO error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to create bulk milk work order',
    })
  }
}

/**
 * Issue raw components to a bulk milk work order
 * POST /api/milk/bulk-work-order/:id/issue
 */
async function issueBulkMilkComponents(req, res) {
  try {
    const { id } = req.params
    if (!id) {
      return res.status(400).json({ success: false, error: 'Work order ID is required' })
    }
    const result = await milkService.issueBulkMilkComponents(id, req.body)
    return res.status(200).json(result)
  } catch (error) {
    console.error('[MilkController] Bulk milk issue error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to issue components to bulk milk work order',
    })
  }
}

/**
 * Get active/in-process bulk milk work orders
 * GET /api/milk/bulk-work-orders/active
 */
async function getActiveBulkMilkWorkOrders(req, res) {
  try {
    const result = await milkService.getActiveBulkMilkWorkOrders()
    return res.status(200).json(result)
  } catch (error) {
    console.error('[MilkController] Get active bulk milk WOs error:', error)
    return res.status(500).json({
      success: false,
      error: error.message || 'Failed to get active bulk milk work orders',
    })
  }
}

module.exports = {
  createSeparationUnbuild,
  createBulkMilkWorkOrder,
  issueBulkMilkComponents,
  getActiveBulkMilkWorkOrders,
}
