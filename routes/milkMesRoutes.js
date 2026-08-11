const express = require('express')
const router = express.Router()
const controller = require('../controllers/milkMesController')
const blendTankController = require('../controllers/blendTankMesController')
const surgeTankController = require('../controllers/surgeTankMesController')

// Receive raw data from MES_Service

/**
 * @openapi
 * /api/mes/milk/separation/batch:
 *   post:
 *     tags: [Separation]
 *     summary: Ingest a separator batch
 *     description: >
 *       Records a completed cold-milk separator batch and posts it to NetSuite as an
 *       assembly unbuild (raw milk in → skim + cream out). Called by the separation cron
 *       job once the separator state machine sees a run finish. If the NetSuite post
 *       fails, or a product index cannot be mapped to an item, the batch is stored with
 *       status `pending_ns` / `error` and surfaces in the Separation Review queue.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Raw batch payload — work order, lots, product indices, and skim/cream quantities read off the historian.
 *     responses:
 *       200: { description: Batch processed (check `success` in the body — a held batch also returns 200). }
 *       500: { description: Failed to process the batch. }
 */
router.post('/separation/batch', controller.processSeparationBatch)

/**
 * @openapi
 * /api/mes/milk/bulk-milk/flow:
 *   post:
 *     tags: [Bulk Milk]
 *     summary: Ingest a bulk milk flow reading
 *     description: >
 *       Records a bulk milk intake totalizer reading from an unload bay and consumes the
 *       corresponding quantity against the registered bulk milk work order. Called by the
 *       bulk milk cron job.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Bay number, destination silo, product code, and totalized unload quantity.
 *     responses:
 *       200: { description: Flow reading processed. }
 *       500: { description: Failed to process the reading. }
 */
router.post('/bulk-milk/flow', controller.processBulkMilkFlow)

// View collected data

/**
 * @openapi
 * /api/mes/milk/separation/batches:
 *   get:
 *     tags: [Separation]
 *     summary: List separation batches
 *     description: Recorded separator batches, newest first. The Separation Review screen filters on `status` to pull just the backlog.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *         description: Maximum batches to return.
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Comma-separated status filter.
 *         example: pending_ns,error
 *     responses:
 *       200:
 *         description: Batches.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 count:   { type: integer }
 *                 batches: { type: array, items: { type: object } }
 *       500: { description: Query failed. }
 */
router.get('/separation/batches', controller.getSeparationBatches)

// Separation Review — correct + retry, or reject, a pending_ns/error batch

/**
 * @openapi
 * /api/mes/milk/separation/product-indices:
 *   get:
 *     tags: [Separation]
 *     summary: Product-index options
 *     description: >
 *       The separator HMI's product config (indices 1-40) mapped to NetSuite items.
 *       Populates the edit dropdowns on the Separation Review screen so an operator can
 *       correct a mis-read product index before retrying a batch.
 *     responses:
 *       200:
 *         description: Options.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 options:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       productIndex: { type: integer }
 *                       name:         { type: string }
 *                       nsItemId:     { type: integer }
 *       500: { description: Query failed. }
 */
router.get('/separation/product-indices', controller.getProductIndexOptions)

/**
 * @openapi
 * /api/mes/milk/separation/batches/{id}/retry:
 *   post:
 *     tags: [Separation]
 *     summary: Retry a held separation batch
 *     description: >
 *       Re-posts a `pending_ns` / `error` separation batch to NetSuite, optionally with
 *       operator-corrected product indices. Writes to live NetSuite.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local separation batch id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               skimProductIndex:   { type: integer, description: Corrected skim product index. }
 *               sourceProductIndex: { type: integer, description: Corrected source (raw milk) product index. }
 *               creamProductIndex:  { type: integer, description: Corrected cream product index. }
 *               decidedBy:          { type: string, description: Operator who approved the retry. }
 *     responses:
 *       200: { description: Retry attempted — response carries the NetSuite result and the updated batch. }
 *       400: { description: Invalid id, batch not in a retryable status, or no skim quantity. }
 *       404: { description: Batch not found. }
 *       500: { description: Retry failed. }
 */
router.post('/separation/batches/:id/retry', controller.retrySeparationBatch)

/**
 * @openapi
 * /api/mes/milk/separation/batches/{id}/reject:
 *   post:
 *     tags: [Separation]
 *     summary: Reject a held separation batch
 *     description: Dismisses a `pending_ns` / `error` batch so it stops appearing in the review queue. Nothing is posted to NetSuite.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local separation batch id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               decidedBy: { type: string }
 *               reason:    { type: string }
 *     responses:
 *       200: { description: Batch rejected. }
 *       400: { description: Invalid batch id. }
 *       404: { description: Batch not found. }
 *       500: { description: Reject failed. }
 */
router.post('/separation/batches/:id/reject', controller.rejectSeparationBatch)

// SunApps UI endpoints

/**
 * @openapi
 * /api/mes/milk/bulk-milk/register:
 *   post:
 *     tags: [Bulk Milk]
 *     summary: Register a bulk milk run
 *     description: >
 *       Binds a NetSuite bulk milk work order to an unload bay so subsequent flow readings
 *       auto-consume against it. Called from the SunApps UI when an operator starts an unload.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Work order, bay, silo, and item details for the run.
 *     responses:
 *       200: { description: Run registered. }
 *       500: { description: Registration failed. }
 */
router.post('/bulk-milk/register', controller.registerBulkMilkRun)

/**
 * @openapi
 * /api/mes/milk/bulk-milk/complete:
 *   post:
 *     tags: [Bulk Milk]
 *     summary: Complete a bulk milk run
 *     description: Closes out a registered bulk milk run and finishes its NetSuite work order.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Identifies the run to complete, plus final quantities.
 *     responses:
 *       200: { description: Run completed. }
 *       500: { description: Completion failed. }
 */
router.post('/bulk-milk/complete', controller.completeBulkMilkRun)

/**
 * @openapi
 * /api/mes/milk/bulk-milk/active:
 *   get:
 *     tags: [Bulk Milk]
 *     summary: List active bulk milk runs
 *     description: Registered runs that are still accepting flow readings.
 *     responses:
 *       200: { description: Active runs. }
 *       500: { description: Query failed. }
 */
router.get('/bulk-milk/active', controller.getActiveBulkMilkRuns)

// Blend tank — receive events from MES_Service

/**
 * @openapi
 * /api/mes/milk/blend-tank/wo-start:
 *   post:
 *     tags: [Blend Tanks]
 *     summary: Ingest a blend tank WO start
 *     description: >
 *       Opens a blend tank batch when the tank's HMI signals a work order start. Called by
 *       the blend tank cron job. Resolves the product name off the tank to a NetSuite item;
 *       an unresolvable product holds the batch for review.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Tank id, work order, product name, and start timestamp.
 *     responses:
 *       200: { description: WO start processed. }
 *       500: { description: Failed to process the WO start. }
 */
router.post('/blend-tank/wo-start', blendTankController.processWOStart)

/**
 * @openapi
 * /api/mes/milk/blend-tank/wo-end:
 *   post:
 *     tags: [Blend Tanks]
 *     summary: Ingest a blend tank WO end
 *     description: >
 *       Closes a blend tank batch and posts its completion to NetSuite. Called by the blend
 *       tank cron job when the tank's HMI signals the work order finished.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Tank id, work order, final quantity, and end timestamp.
 *     responses:
 *       200: { description: WO end processed. }
 *       500: { description: Failed to process the WO end. }
 */
router.post('/blend-tank/wo-end', blendTankController.processWOEnd)

/**
 * @openapi
 * /api/mes/milk/blend-tank/line-flow:
 *   post:
 *     tags: [Blend Tanks]
 *     summary: Ingest a blend tank line flow reading
 *     description: >
 *       Records an inflow totalizer reading for one of the lines feeding a blend tank, so
 *       the batch accumulates which ingredients (and how much of each) went in. Drives the
 *       automatic ingredient issues against the work order.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Tank id, line id, source silo/product, and totalized flow.
 *     responses:
 *       200: { description: Line flow processed. }
 *       500: { description: Failed to process the line flow. }
 */
router.post('/blend-tank/line-flow', blendTankController.processLineFlow)

// Blend tank — admin

/**
 * @openapi
 * /api/mes/milk/blend-tank/clear-stale:
 *   post:
 *     tags: [Blend Tanks]
 *     summary: Clear stale active batches
 *     description: >
 *       Closes blend tank batches still marked active but with no NetSuite work order
 *       behind them — leftovers from a crash or a mis-fired start event. Administrative
 *       cleanup; takes no body.
 *     responses:
 *       200: { description: Stale batches cleared — response reports how many. }
 *       500: { description: Cleanup failed. }
 */
router.post('/blend-tank/clear-stale', blendTankController.clearStaleBatches)

// Blend tank — SunApps UI endpoints

/**
 * @openapi
 * /api/mes/milk/blend-tank/active:
 *   get:
 *     tags: [Blend Tanks]
 *     summary: List active blend tank batches
 *     description: Batches currently open on a blend tank — what the live dashboard shows as in-progress.
 *     responses:
 *       200: { description: Active batches. }
 *       500: { description: Query failed. }
 */
router.get('/blend-tank/active', blendTankController.getActiveBatches)

/**
 * @openapi
 * /api/mes/milk/blend-tank/batches:
 *   get:
 *     tags: [Blend Tanks]
 *     summary: List blend tank batches
 *     description: All recorded blend tank batches. Query params are passed through to the service as filters (notably `status` for the review queue).
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Status filter, e.g. `pending_ns` or `error`.
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *         description: Maximum batches to return.
 *     responses:
 *       200: { description: Batches. }
 *       500: { description: Query failed. }
 */
router.get('/blend-tank/batches', blendTankController.getAllBatches)

/**
 * @openapi
 * /api/mes/milk/blend-tank/product-options:
 *   get:
 *     tags: [Blend Tanks]
 *     summary: Blend product options
 *     description: Selectable NetSuite items for the blend tank review UI, used to override a batch's product before retrying it.
 *     responses:
 *       200: { description: Product options. }
 *       500: { description: Query failed. }
 */
router.get('/blend-tank/product-options', blendTankController.getProductOptions)

/**
 * @openapi
 * /api/mes/milk/blend-tank/batches/{id}/retry:
 *   post:
 *     tags: [Blend Tanks]
 *     summary: Retry a held blend tank batch
 *     description: Re-posts a `pending_ns` / `error` blend tank batch to NetSuite, optionally overriding the resolved item. Writes to live NetSuite.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local blend tank batch id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nsItemId:  { type: integer, description: NetSuite item to use instead of the auto-resolved one. }
 *               decidedBy: { type: string }
 *     responses:
 *       200: { description: Retry attempted. }
 *       400: { description: Batch not found, not retryable, or the retry failed. }
 */
router.post('/blend-tank/batches/:id/retry', blendTankController.retryBatch)

/**
 * @openapi
 * /api/mes/milk/blend-tank/batches/{id}/reject:
 *   post:
 *     tags: [Blend Tanks]
 *     summary: Reject a held blend tank batch
 *     description: Dismisses a `pending_ns` / `error` blend tank batch so it leaves the review queue. Nothing is posted to NetSuite.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local blend tank batch id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               decidedBy: { type: string }
 *               reason:    { type: string }
 *     responses:
 *       200: { description: Batch rejected. }
 *       400: { description: Batch not found or reject failed. }
 */
router.post('/blend-tank/batches/:id/reject', blendTankController.rejectBatch)

/**
 * @openapi
 * /api/mes/milk/blend-tank/{id}/components:
 *   get:
 *     tags: [Blend Tanks]
 *     summary: Components of a blend tank batch
 *     description: The ingredient inflows recorded against a batch and their issue state against the NetSuite work order.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local blend tank batch id.
 *     responses:
 *       200: { description: Components. }
 *       500: { description: Query failed. }
 */
router.get('/blend-tank/:id/components', blendTankController.getBatchComponents)

/**
 * @openapi
 * /api/mes/milk/blend-tank/{id}/issue-ingredient:
 *   post:
 *     tags: [Blend Tanks]
 *     summary: Manually issue an ingredient
 *     description: >
 *       Issues an ingredient to a blend tank batch's NetSuite work order by hand — the
 *       operator escape hatch for when automatic issuing from line flow missed or
 *       under-counted. Writes to live NetSuite.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local blend tank batch id.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Item, quantity, and optional bin / lot for the issue.
 *     responses:
 *       200: { description: Ingredient issued. }
 *       500: { description: Issue failed. }
 */
router.post('/blend-tank/:id/issue-ingredient', blendTankController.issueIngredient)

// Surge tank — SunApps UI endpoints

/**
 * @openapi
 * /api/mes/milk/surge-tank/batches:
 *   get:
 *     tags: [Surge Tanks]
 *     summary: List surge tank batches
 *     description: All recorded surge tank batches. Query params are passed through to the service as filters.
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Status filter, e.g. `pending_ns` or `error`.
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *         description: Maximum batches to return.
 *     responses:
 *       200: { description: Batches. }
 *       500: { description: Query failed. }
 */
router.get('/surge-tank/batches', surgeTankController.getAllBatches)

/**
 * @openapi
 * /api/mes/milk/surge-tank/product-options:
 *   get:
 *     tags: [Surge Tanks]
 *     summary: Surge product options
 *     description: Selectable NetSuite items for the surge tank review UI, used to override a batch's product before retrying it.
 *     responses:
 *       200: { description: Product options. }
 *       500: { description: Query failed. }
 */
router.get('/surge-tank/product-options', surgeTankController.getProductOptions)

/**
 * @openapi
 * /api/mes/milk/surge-tank/batches/{id}/retry:
 *   post:
 *     tags: [Surge Tanks]
 *     summary: Retry a held surge tank batch
 *     description: Re-posts a `pending_ns` / `error` surge tank batch to NetSuite, optionally overriding the resolved item. Writes to live NetSuite.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local surge tank batch id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               nsItemId:  { type: integer, description: NetSuite item to use instead of the auto-resolved one. }
 *               decidedBy: { type: string }
 *     responses:
 *       200: { description: Retry attempted. }
 *       400: { description: Batch not found, not retryable, or the retry failed. }
 */
router.post('/surge-tank/batches/:id/retry', surgeTankController.retryBatch)

/**
 * @openapi
 * /api/mes/milk/surge-tank/batches/{id}/reject:
 *   post:
 *     tags: [Surge Tanks]
 *     summary: Reject a held surge tank batch
 *     description: Dismisses a `pending_ns` / `error` surge tank batch so it leaves the review queue. Nothing is posted to NetSuite.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local surge tank batch id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               decidedBy: { type: string }
 *               reason:    { type: string }
 *     responses:
 *       200: { description: Batch rejected. }
 *       400: { description: Batch not found or reject failed. }
 */
router.post('/surge-tank/batches/:id/reject', surgeTankController.rejectBatch)

module.exports = router
