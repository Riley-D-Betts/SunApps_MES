const express = require('express')
const router = express.Router()
const controller = require('../controllers/bomAdminController')

/**
 * @openapi
 * /api/mes/bom-admin/groups:
 *   get:
 *     tags: [BOM Admin]
 *     summary: Selectable item groups
 *     description: >
 *       The item groups the BOM admin UI offers as starting points — surge finished goods,
 *       batch goods, and raw items — plus the surge-FG → batch-twin map that pairs each
 *       finished good with the batch item representing the same product mid-process.
 *     responses:
 *       200: { description: Groups and the twin map. }
 *       500: { description: Query failed. }
 */
router.get('/groups', controller.groups)

/**
 * @openapi
 * /api/mes/bom-admin/search:
 *   get:
 *     tags: [BOM Admin]
 *     summary: Search assembly items
 *     description: Free-text search over NetSuite assembly items — the fallback when the item isn't in one of the predefined groups.
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *         description: Search text matched against item name / id.
 *     responses:
 *       200: { description: Matching items. }
 *       500: { description: Search failed. }
 */
router.get('/search', controller.search)

/**
 * @openapi
 * /api/mes/bom-admin/item/{id}:
 *   get:
 *     tags: [BOM Admin]
 *     summary: Get an item's BOM components
 *     description: Components of the item's current (default) BOM revision.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: NetSuite item internal id.
 *     responses:
 *       200: { description: BOM components. }
 *       400: { description: Invalid id, item not found, not an assembly, or it has no editable BOM. }
 *       500: { description: Query failed. }
 */
router.get('/item/:id', controller.getItem)

/**
 * @openapi
 * /api/mes/bom-admin/preview:
 *   post:
 *     tags: [BOM Admin]
 *     summary: Preview a BOM change
 *     description: >
 *       Validates a proposed component list against the item's current BOM revision and
 *       returns the diff — including circular-reference checks — without writing anything
 *       to NetSuite. Run this before `/commit`.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [itemId]
 *             properties:
 *               itemId:     { type: integer, description: NetSuite assembly item id. }
 *               components:
 *                 type: array
 *                 description: Proposed component lines (item + quantity).
 *                 items: { type: object }
 *     responses:
 *       200: { description: Preview of the change. }
 *       400: { description: Missing itemId or the proposed BOM is invalid. }
 */
router.post('/preview', controller.preview)

/**
 * @openapi
 * /api/mes/bom-admin/commit:
 *   post:
 *     tags: [BOM Admin]
 *     summary: Commit a BOM change
 *     description: >
 *       OVERWRITES the components of the item's current BOM revision in live NetSuite.
 *       Destructive and not versioned by this service — preview first.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [itemId]
 *             properties:
 *               itemId:     { type: integer, description: NetSuite assembly item id. }
 *               components:
 *                 type: array
 *                 description: Component lines that will replace the revision's current lines.
 *                 items: { type: object }
 *     responses:
 *       200: { description: BOM committed. }
 *       400: { description: Missing itemId or the commit was rejected. }
 */
router.post('/commit', controller.commit)

/**
 * @openapi
 * /api/mes/bom-admin/bulk/surge-twins:
 *   post:
 *     tags: [BOM Admin]
 *     summary: Bulk-set surge FG BOMs to their batch twin
 *     description: >
 *       Sets every surge finished good's BOM to a single line — 1 lb of its batch twin.
 *       Dry-run by default; pass `commit: true` to actually write to live NetSuite across
 *       every surge FG at once.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               commit:
 *                 type: boolean
 *                 default: false
 *                 description: false (default) previews the changes; true writes them to NetSuite.
 *     responses:
 *       200: { description: Per-item results — planned when previewing, applied when committing. }
 *       500: { description: Bulk operation failed. }
 */
router.post('/bulk/surge-twins', controller.bulkSurgeTwins)

module.exports = router
