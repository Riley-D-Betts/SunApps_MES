const express = require('express')
const router = express.Router()
const controller = require('../controllers/milkController')

// Separation

/**
 * @openapi
 * /api/milk/separation/unbuild:
 *   post:
 *     tags: [Separation]
 *     summary: Create a separation assembly unbuild
 *     description: >
 *       Posts an assembly unbuild to NetSuite for a milk separation — raw milk consumed,
 *       skim and cream produced. This is the low-level NetSuite write that
 *       `/api/mes/milk/separation/batch` calls into after it has recorded the batch
 *       locally; exposed directly for manual correction. Writes to live NetSuite.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Items, quantities and lots for the unbuild.
 *     responses:
 *       200: { description: Unbuild created. }
 *       500: { description: Unbuild failed. }
 */
router.post('/separation/unbuild', controller.createSeparationUnbuild)

// Bulk milk work orders

/**
 * @openapi
 * /api/milk/bulk-work-order:
 *   post:
 *     tags: [Bulk Milk]
 *     summary: Create a bulk milk work order
 *     description: Creates the NetSuite work order a bulk milk intake run consumes against. Writes to live NetSuite.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Item, quantity, location and bin for the work order.
 *     responses:
 *       200: { description: Work order created. }
 *       500: { description: Creation failed. }
 */
router.post('/bulk-work-order', controller.createBulkMilkWorkOrder)

/**
 * @openapi
 * /api/milk/bulk-work-order/{id}/issue:
 *   post:
 *     tags: [Bulk Milk]
 *     summary: Issue components to a bulk milk work order
 *     description: Issues raw components against an existing bulk milk work order. Writes to live NetSuite.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: NetSuite work order internal id.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Components to issue — item, quantity, and optional bin / lot per line.
 *     responses:
 *       200: { description: Components issued. }
 *       400: { description: Missing work order id. }
 *       500: { description: Issue failed. }
 */
router.post('/bulk-work-order/:id/issue', controller.issueBulkMilkComponents)

/**
 * @openapi
 * /api/milk/bulk-work-orders/active:
 *   get:
 *     tags: [Bulk Milk]
 *     summary: List active bulk milk work orders
 *     description: Bulk milk work orders currently open or in-process in NetSuite.
 *     responses:
 *       200: { description: Active work orders. }
 *       500: { description: Query failed. }
 */
router.get('/bulk-work-orders/active', controller.getActiveBulkMilkWorkOrders)

module.exports = router
