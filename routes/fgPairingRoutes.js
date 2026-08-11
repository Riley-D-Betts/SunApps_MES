const express = require('express')
const router = express.Router()
const controller = require('../controllers/fgPairingController')

/**
 * @openapi
 * /api/mes/fg-pairings:
 *   get:
 *     tags: [FG Pairings]
 *     summary: List finished-good pairings
 *     description: >
 *       Finished-good ⇐ raw-input pairings — the learned map of which raw input legitimately
 *       feeds which FG on a surge tank. A newly-observed combination lands here as `pending`;
 *       until it is approved, surge batches using it are held rather than posted to NetSuite.
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [approved, pending, rejected] }
 *         description: Filter by decision status. Omit for all.
 *     responses:
 *       200:
 *         description: Pairings.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:  { type: boolean }
 *                 pairings: { type: array, items: { type: object } }
 *       400: { description: Invalid status value. }
 *       500: { description: Query failed. }
 */
router.get('/', controller.list)

/**
 * @openapi
 * /api/mes/fg-pairings/{id}/approve:
 *   post:
 *     tags: [FG Pairings]
 *     summary: Approve a pairing
 *     description: Marks the FG ⇐ raw-input combination valid, so future surge batches using it post to NetSuite without being held.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Pairing id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               decidedBy: { type: string }
 *               notes:     { type: string }
 *     responses:
 *       200: { description: Pairing approved. }
 *       400: { description: Invalid pairing id. }
 *       404: { description: Pairing not found. }
 *       500: { description: Approve failed. }
 */
router.post('/:id/approve', controller.approve)

/**
 * @openapi
 * /api/mes/fg-pairings/{id}/reject:
 *   post:
 *     tags: [FG Pairings]
 *     summary: Reject a pairing
 *     description: Marks the FG ⇐ raw-input combination bad. Future surge batches using it are held for review instead of posting.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Pairing id.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               decidedBy: { type: string }
 *               reason:    { type: string }
 *     responses:
 *       200: { description: Pairing rejected. }
 *       400: { description: Invalid pairing id. }
 *       404: { description: Pairing not found. }
 *       500: { description: Reject failed. }
 */
router.post('/:id/reject', controller.reject)

/**
 * @openapi
 * /api/mes/fg-pairings/{id}/fix:
 *   post:
 *     tags: [FG Pairings]
 *     summary: Correct a pairing
 *     description: >
 *       Rejects the wrong FG ⇐ raw-input combination and approves the corrected one in a
 *       single step — for when the observed raw input was mis-identified rather than simply
 *       invalid.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *         description: Pairing id of the incorrect combination.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rawInputItemId]
 *             properties:
 *               rawInputItemId: { type: integer, description: NetSuite item id of the correct raw input. }
 *               rawInputName:   { type: string, description: Display name for the corrected raw input. }
 *               decidedBy:      { type: string }
 *               notes:          { type: string }
 *     responses:
 *       200: { description: Pairing corrected — the bad combo is rejected and the correct one approved. }
 *       400: { description: Invalid pairing id or missing correction details. }
 *       404: { description: Pairing not found. }
 */
router.post('/:id/fix', controller.fix)

module.exports = router
