'use strict'

const express = require('express')
const router = express.Router()
const controller = require('../controllers/analyticsController')

router.get('/blend-batches',      controller.getBlendBatches)
router.get('/blend-trend',        controller.getBlendTrend)
router.get('/surge-batches',      controller.getSurgeBatches)
router.get('/surge-trend',        controller.getSurgeTrend)
router.get('/separation-batches', controller.getSeparationBatches)
router.get('/separation-trend',   controller.getSeparationTrend)
router.get('/inventory-adjustments',             controller.getInventoryAdjustments)
router.get('/inventory-adjustments/correlations', controller.getInventoryAdjustmentCorrelations)
router.get('/batches-with-adjustments',          controller.getBatchesWithAdjustments)
router.get('/batches/:kind/:id/netsuite',        controller.getBatchNetSuiteTransactions)
router.get('/inventory-adjustments-trend',       controller.getInventoryAdjustmentTrend)
router.post('/inventory-adjustments/:id/retry',  controller.retryInventoryAdjustment)
router.post('/inventory-adjustments/:id/reject', controller.rejectInventoryAdjustment)

module.exports = router
