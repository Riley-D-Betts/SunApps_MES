const express = require('express')
const router = express.Router()
const controller = require('../controllers/fgPairingController')

router.get('/', controller.list)
router.post('/:id/approve', controller.approve)

module.exports = router
