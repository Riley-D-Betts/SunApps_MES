const express = require('express')
const router = express.Router()
const controller = require('../controllers/milkMesController')
const blendTankController = require('../controllers/blendTankMesController')

// Receive raw data from MES_Service
router.post('/separation/batch', controller.processSeparationBatch)
router.post('/bulk-milk/flow', controller.processBulkMilkFlow)

// View collected data
router.get('/separation/batches', controller.getSeparationBatches)

// Separation Review — correct + retry, or reject, a pending_ns/error batch
router.get('/separation/product-indices', controller.getProductIndexOptions)
router.post('/separation/batches/:id/retry', controller.retrySeparationBatch)
router.post('/separation/batches/:id/reject', controller.rejectSeparationBatch)

// SunApps UI endpoints
router.post('/bulk-milk/register', controller.registerBulkMilkRun)
router.post('/bulk-milk/complete', controller.completeBulkMilkRun)
router.get('/bulk-milk/active', controller.getActiveBulkMilkRuns)

// Blend tank — receive events from MES_Service
router.post('/blend-tank/wo-start', blendTankController.processWOStart)
router.post('/blend-tank/wo-end', blendTankController.processWOEnd)
router.post('/blend-tank/line-flow', blendTankController.processLineFlow)

// Blend tank — admin
router.post('/blend-tank/clear-stale', blendTankController.clearStaleBatches)

// Blend tank — SunApps UI endpoints
router.get('/blend-tank/active', blendTankController.getActiveBatches)
router.get('/blend-tank/:id/components', blendTankController.getBatchComponents)
router.post('/blend-tank/:id/issue-ingredient', blendTankController.issueIngredient)

module.exports = router
