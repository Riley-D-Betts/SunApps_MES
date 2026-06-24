const express = require('express')
const router = express.Router()
const controller = require('../controllers/fgPairingController')

router.get('/', controller.list)
router.post('/:id/approve', controller.approve)
router.post('/:id/reject', controller.reject)
router.post('/:id/fix', controller.fix)

module.exports = router
