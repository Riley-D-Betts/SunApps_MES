const express = require('express')
const router = express.Router()
const controller = require('../controllers/bomAdminController')

router.get('/groups', controller.groups)
router.get('/search', controller.search)
router.get('/item/:id', controller.getItem)
router.post('/preview', controller.preview)
router.post('/commit', controller.commit)
router.post('/bulk/surge-twins', controller.bulkSurgeTwins)

module.exports = router
