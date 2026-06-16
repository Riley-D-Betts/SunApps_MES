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

module.exports = router
