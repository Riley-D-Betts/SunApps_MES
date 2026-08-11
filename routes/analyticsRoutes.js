'use strict'

const express = require('express')
const router = express.Router()
const controller = require('../controllers/analyticsController')

/**
 * @openapi
 * /api/mes/analytics/blend-batches:
 *   get:
 *     tags: [Analytics]
 *     summary: Blend tank batch history
 *     description: Paged, filterable, sortable list of blend tank batches for the analytics table.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: Window start (ISO 8601).
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: Window end (ISO 8601).
 *       - in: query
 *         name: tankId
 *         schema: { type: string }
 *         description: Restrict to one blend tank.
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Batch status filter.
 *       - in: query
 *         name: product
 *         schema: { type: string }
 *         description: Product filter.
 *       - in: query
 *         name: sortBy
 *         schema: { type: string }
 *         description: Column to sort on.
 *       - in: query
 *         name: sortDir
 *         schema: { type: string, enum: [asc, desc] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Batch rows plus paging totals. }
 *       500: { description: Query failed. }
 */
router.get('/blend-batches',      controller.getBlendBatches)

/**
 * @openapi
 * /api/mes/analytics/blend-trend:
 *   get:
 *     tags: [Analytics]
 *     summary: Blend tank volume trend
 *     description: Blend tank output bucketed over time for the trend chart.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: Window start (ISO 8601).
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: Window end (ISO 8601).
 *       - in: query
 *         name: groupBy
 *         schema: { type: string }
 *         description: Bucket size, e.g. `day` / `week` / `month`.
 *       - in: query
 *         name: tankId
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: product
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Trend points.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 points:  { type: array, items: { type: object } }
 *       500: { description: Query failed. }
 */
router.get('/blend-trend',        controller.getBlendTrend)

/**
 * @openapi
 * /api/mes/analytics/surge-batches:
 *   get:
 *     tags: [Analytics]
 *     summary: Surge tank batch history
 *     description: Paged, filterable, sortable list of surge tank batches.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: Window start (ISO 8601).
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: Window end (ISO 8601).
 *       - in: query
 *         name: tankId
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: product
 *         schema: { type: string }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string }
 *       - in: query
 *         name: sortDir
 *         schema: { type: string, enum: [asc, desc] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Batch rows plus paging totals. }
 *       500: { description: Query failed. }
 */
router.get('/surge-batches',      controller.getSurgeBatches)

/**
 * @openapi
 * /api/mes/analytics/surge-trend:
 *   get:
 *     tags: [Analytics]
 *     summary: Surge tank volume trend
 *     description: Surge tank output bucketed over time for the trend chart.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: groupBy
 *         schema: { type: string }
 *         description: Bucket size, e.g. `day` / `week` / `month`.
 *       - in: query
 *         name: tankId
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: product
 *         schema: { type: string }
 *     responses:
 *       200: { description: Trend points. }
 *       500: { description: Query failed. }
 */
router.get('/surge-trend',        controller.getSurgeTrend)

/**
 * @openapi
 * /api/mes/analytics/separation-batches:
 *   get:
 *     tags: [Analytics]
 *     summary: Separation batch history
 *     description: Paged, filterable, sortable list of separator batches.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: sourceSilo
 *         schema: { type: string }
 *         description: Restrict to batches drawn from one raw milk silo.
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string }
 *       - in: query
 *         name: sortDir
 *         schema: { type: string, enum: [asc, desc] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Batch rows plus paging totals. }
 *       500: { description: Query failed. }
 */
router.get('/separation-batches', controller.getSeparationBatches)

/**
 * @openapi
 * /api/mes/analytics/separation-trend:
 *   get:
 *     tags: [Analytics]
 *     summary: Separation volume trend
 *     description: Separator throughput bucketed over time for the trend chart.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: groupBy
 *         schema: { type: string }
 *         description: Bucket size, e.g. `day` / `week` / `month`.
 *       - in: query
 *         name: sourceSilo
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     responses:
 *       200: { description: Trend points. }
 *       500: { description: Query failed. }
 */
router.get('/separation-trend',   controller.getSeparationTrend)

/**
 * @openapi
 * /api/mes/analytics/inventory-adjustments:
 *   get:
 *     tags: [Inventory Adjustments]
 *     summary: List inventory adjustments
 *     description: >
 *       Inventory adjustments this service generated from historian tank-level movements —
 *       the shrink/gain postings that reconcile NetSuite inventory to what the plant floor
 *       actually measured.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: source
 *         schema: { type: string }
 *         description: Which subsystem generated the adjustment.
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *         description: Posting status, e.g. `posted` / `error` / `rejected`.
 *       - in: query
 *         name: binId
 *         schema: { type: integer }
 *       - in: query
 *         name: itemId
 *         schema: { type: integer }
 *       - in: query
 *         name: tankName
 *         schema: { type: string }
 *       - in: query
 *         name: excludePositiveSilo
 *         schema: { type: boolean }
 *         description: Drop positive silo adjustments, which are usually refills rather than true gains.
 *       - in: query
 *         name: sortBy
 *         schema: { type: string }
 *       - in: query
 *         name: sortDir
 *         schema: { type: string, enum: [asc, desc] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Adjustment rows plus paging totals. }
 *       500: { description: Query failed. }
 */
router.get('/inventory-adjustments',             controller.getInventoryAdjustments)

/**
 * @openapi
 * /api/mes/analytics/inventory-adjustments/correlations:
 *   get:
 *     tags: [Inventory Adjustments]
 *     summary: Adjustments with their triggering batch
 *     description: >
 *       Same rows and filters as `/inventory-adjustments`, but each row carries a
 *       `correlation` block tracing the adjustment back to the work order, assembly unbuild,
 *       or batch that caused it — plus a `correlationStats` summary of how confidently the
 *       matches were made.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: source
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: binId
 *         schema: { type: integer }
 *       - in: query
 *         name: itemId
 *         schema: { type: integer }
 *       - in: query
 *         name: tankName
 *         schema: { type: string }
 *       - in: query
 *         name: excludePositiveSilo
 *         schema: { type: boolean }
 *       - in: query
 *         name: sortBy
 *         schema: { type: string }
 *       - in: query
 *         name: sortDir
 *         schema: { type: string, enum: [asc, desc] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *       - in: query
 *         name: offset
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Adjustments with per-row correlation and a correlationStats summary. }
 *       500: { description: Query failed. }
 */
router.get('/inventory-adjustments/correlations', controller.getInventoryAdjustmentCorrelations)

/**
 * @openapi
 * /api/mes/analytics/batches-with-adjustments:
 *   get:
 *     tags: [Inventory Adjustments]
 *     summary: Batches with their correlated adjustments
 *     description: >
 *       The batch-centric inverse of the correlations view — each batch in the window with
 *       the inventory adjustments attributed to it and per-batch rollups. Drives the Batch
 *       Adjustments page.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: kind
 *         schema: { type: string, enum: [blend, surge, separation] }
 *         description: Restrict to one batch kind.
 *       - in: query
 *         name: onlyWithAdjustments
 *         schema: { type: boolean }
 *         description: Drop batches that have no correlated adjustments.
 *       - in: query
 *         name: limit
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Batches with adjustments and rollups. }
 *       500: { description: Query failed. }
 */
router.get('/batches-with-adjustments',          controller.getBatchesWithAdjustments)

/**
 * @openapi
 * /api/mes/analytics/batches/{kind}/{id}/netsuite:
 *   get:
 *     tags: [Analytics]
 *     summary: A batch's actual NetSuite transactions
 *     description: >
 *       Pulls the batch's real transactions (issues, completions, unbuilds, adjustments)
 *       live from NetSuite by the internal ids this service recorded — source-of-truth
 *       reconciliation for when the local record and NetSuite are suspected to disagree.
 *     parameters:
 *       - in: path
 *         name: kind
 *         required: true
 *         schema: { type: string, enum: [blend, surge, separation] }
 *         description: Batch kind.
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local batch id.
 *     responses:
 *       200: { description: The batch's NetSuite transactions. }
 *       500: { description: NetSuite lookup failed. }
 */
router.get('/batches/:kind/:id/netsuite',        controller.getBatchNetSuiteTransactions)

/**
 * @openapi
 * /api/mes/analytics/batches/{kind}/{id}:
 *   get:
 *     tags: [Analytics]
 *     summary: Full detail for one batch
 *     description: >
 *       Everything about a single batch for the batch-detail page — the full record,
 *       correlated inventory adjustments and their rollup, transaction counts and the
 *       processing log, bins, lots, ingredient inflows, and separation destinations.
 *       A local read; use the `/netsuite` variant to reconcile against NetSuite itself.
 *     parameters:
 *       - in: path
 *         name: kind
 *         required: true
 *         schema: { type: string, enum: [blend, surge, separation] }
 *         description: Batch kind.
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local batch id.
 *     responses:
 *       200: { description: Batch detail. }
 *       404: { description: Batch not found, or unknown batch kind. }
 *       500: { description: Query failed. }
 */
router.get('/batches/:kind/:id',                 controller.getBatchDetail)

/**
 * @openapi
 * /api/mes/analytics/inventory-adjustments-trend:
 *   get:
 *     tags: [Inventory Adjustments]
 *     summary: Inventory adjustment trend
 *     description: Adjustment quantities bucketed over time for the trend chart.
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: groupBy
 *         schema: { type: string }
 *         description: Bucket size, e.g. `day` / `week` / `month`.
 *       - in: query
 *         name: source
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: excludePositiveSilo
 *         schema: { type: boolean }
 *     responses:
 *       200: { description: Trend points. }
 *       500: { description: Query failed. }
 */
router.get('/inventory-adjustments-trend',       controller.getInventoryAdjustmentTrend)

/**
 * @openapi
 * /api/mes/analytics/inventory-adjustments/{id}/retry:
 *   post:
 *     tags: [Inventory Adjustments]
 *     summary: Retry an inventory adjustment
 *     description: >
 *       Re-posts an errored or skipped adjustment to NetSuite, optionally with operator
 *       corrections to the bin, item, quantity or lot. Backs the Retry button on the
 *       Inventory Adjustment Review screen. Writes to live NetSuite.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local inventory adjustment id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               binId:    { type: integer, description: Corrected NetSuite bin. }
 *               itemId:   { type: integer, description: Corrected NetSuite item. }
 *               qtyDelta: { type: number,  description: Corrected signed quantity. }
 *               tankName: { type: string }
 *               lotName:  { type: string }
 *               decidedBy: { type: string }
 *     responses:
 *       200: { description: Adjustment re-posted. }
 *       400: { description: Adjustment not found, not retryable, or the post failed. }
 */
router.post('/inventory-adjustments/:id/retry',  controller.retryInventoryAdjustment)

/**
 * @openapi
 * /api/mes/analytics/inventory-adjustments/{id}/reject:
 *   post:
 *     tags: [Inventory Adjustments]
 *     summary: Reject an inventory adjustment
 *     description: Dismisses an adjustment that should not post (status becomes `rejected`). Nothing is written to NetSuite.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Local inventory adjustment id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               decidedBy: { type: string }
 *               reason:    { type: string }
 *     responses:
 *       200: { description: Adjustment rejected. }
 *       400: { description: Adjustment not found or reject failed. }
 */
router.post('/inventory-adjustments/:id/reject', controller.rejectInventoryAdjustment)

module.exports = router
