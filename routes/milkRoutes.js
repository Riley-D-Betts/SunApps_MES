const express = require('express')
const router = express.Router()
const controller = require('../controllers/milkController')

// Separation
router.post('/separation/unbuild', controller.createSeparationUnbuild)

// Bulk milk work orders
router.post('/bulk-work-order', controller.createBulkMilkWorkOrder)
router.post('/bulk-work-order/:id/issue', controller.issueBulkMilkComponents)
router.get('/bulk-work-orders/active', controller.getActiveBulkMilkWorkOrders)

module.exports = router
