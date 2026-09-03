const express = require('express')
const router = express.Router()
const db = require('../models')
const rawMilkPriceService = require('../services/rawMilkPriceService')
const fgRevenueRateService = require('../services/fgRevenueRateService')
const { getProductByNsId } = require('../services/surgeTankProductParser')

// Bulk FG item display name from the parser catalog (no NS call) — null for
// ids the catalog doesn't know (manual rows for new items).
function fgItemName(fgItemId) {
  const p = getProductByNsId(Number(fgItemId))
  return p ? p.name : null
}

/**
 * Costs config API (SD-717) — the single audited source for the cost
 * constants that price waste/shrink (SunApps batch views, analytics, and the
 * Portal's reports). Append-only: POST adds a new price row; the newest row
 * is the current price; prior rows are the audit history.
 */

const num = v => (v == null ? null : Number(v))

function toDto(row) {
  return {
    milkCostPerLb: num(row.milkCostPerLb),
    fgCasePrice: num(row.fgCasePrice),
    effectiveFrom: row.effectiveFrom,
    note: row.note || null,
  }
}

/**
 * @openapi
 * /api/mes/config/costs:
 *   get:
 *     tags: [Costs Config]
 *     summary: Current cost constants (newest price row)
 *     description: >
 *       Returns the current cost constants used to price waste/shrink. An
 *       unseeded environment returns 200 with explicit nulls (consumers hide
 *       their $ figures) — never a 404. Pass `history=N` to also receive the
 *       most recent N price rows (max 100), newest first.
 *
 *       Also returns `families` — the current per-family raw milk prices
 *       (organic / conventional / a2 / cream_organic / cream_conventional),
 *       each `{ pricePerLb, source, basis, effectiveFrom }` where source is
 *       'ns' (derived daily from NetSuite purchase transactions) or 'manual'
 *       (POST /raw-milk). Families with no price row yet are omitted.
 *       `history=N` additionally returns `familyHistory` (flat, newest
 *       first). The flat milkCostPerLb remains the fallback for batches no
 *       family classifies.
 *
 *       Also returns `fgRevenue` — current FG revenue rates per bulk FG item
 *       (what a pound would have earned as invoiced finished goods, derived
 *       daily from packaging WOs + invoices), each
 *       `{ revenuePerLb, source, basis, effectiveFrom, itemName }`.
 *       `history=N` adds `fgRevenueHistory`. No flat fallback exists for
 *       lost revenue — unpriced items simply hide the figure.
 *     parameters:
 *       - in: query
 *         name: history
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *         description: Also return the most recent N price rows.
 *     responses:
 *       200:
 *         description: Current constants (plus optional history).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               description: milkCostPerLb ($/lb), fgCasePrice ($/case, nullable), effectiveFrom, note; history[] when requested.
 *       500: { description: Query failed. }
 */
router.get('/', async (req, res) => {
  try {
    const order = [['effectiveFrom', 'DESC'], ['id', 'DESC']]
    const latest = await db.MesCostConfig.findOne({ order })
    const out = latest
      ? toDto(latest)
      : { milkCostPerLb: null, fgCasePrice: null, effectiveFrom: null, note: null }
    out.families = await rawMilkPriceService.getCurrentPrices()
    const rates = await fgRevenueRateService.getCurrentRates()
    out.fgRevenue = Object.fromEntries(Object.entries(rates).map(([id, r]) => [
      id, { ...r, itemName: fgItemName(id) },
    ]))
    const historyN = parseInt(req.query.history)
    if (Number.isFinite(historyN) && historyN > 0) {
      const limit = Math.min(historyN, 100)
      const rows = await db.MesCostConfig.findAll({ order, limit })
      out.history = rows.map(toDto)
      const famRows = await db.MesRawMilkPrice.findAll({ order, limit })
      out.familyHistory = famRows.map(r => ({
        family: r.family,
        pricePerLb: num(r.pricePerLb),
        source: r.source,
        basis: r.basis || null,
        effectiveFrom: r.effectiveFrom,
      }))
      const fgRows = await db.MesFgRevenueRate.findAll({ order, limit })
      out.fgRevenueHistory = fgRows.map(r => ({
        fgItemId: r.fgItemId,
        itemName: fgItemName(r.fgItemId),
        revenuePerLb: num(r.revenuePerLb),
        source: r.source,
        basis: r.basis || null,
        effectiveFrom: r.effectiveFrom,
      }))
    }
    res.json(out)
  } catch (err) {
    console.error('[CostsConfigRoutes] GET error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * @openapi
 * /api/mes/config/costs:
 *   post:
 *     tags: [Costs Config]
 *     summary: Append a new cost row (becomes the current price)
 *     description: >
 *       Appends a price row — rows are never updated or deleted, so every
 *       change is audited. Also the post-deploy seed mechanism (see
 *       DEPLOY_CHECKLIST).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [milkCostPerLb]
 *             properties:
 *               milkCostPerLb: { type: number, minimum: 0, exclusiveMinimum: true, example: 0.34 }
 *               fgCasePrice: { type: number, minimum: 0, example: 10.35 }
 *               note: { type: string, maxLength: 200 }
 *     responses:
 *       201: { description: Row created; body is the new current constants. }
 *       400: { description: Invalid milkCostPerLb / fgCasePrice. }
 *       500: { description: Insert failed. }
 */
router.post('/', async (req, res) => {
  try {
    const { milkCostPerLb, fgCasePrice, note } = req.body || {}
    const milk = Number(milkCostPerLb)
    if (!Number.isFinite(milk) || milk <= 0) {
      return res.status(400).json({ error: 'milkCostPerLb is required and must be a positive number' })
    }
    let fg = null
    if (fgCasePrice != null && fgCasePrice !== '') {
      fg = Number(fgCasePrice)
      if (!Number.isFinite(fg) || fg <= 0) {
        return res.status(400).json({ error: 'fgCasePrice must be a positive number when provided' })
      }
    }
    const row = await db.MesCostConfig.create({
      milkCostPerLb: milk,
      fgCasePrice: fg,
      note: note != null ? String(note).slice(0, 200) : null,
    })
    res.status(201).json(toDto(row))
  } catch (err) {
    console.error('[CostsConfigRoutes] POST error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * @openapi
 * /api/mes/config/costs/raw-milk:
 *   post:
 *     tags: [Costs Config]
 *     summary: Append a manual per-family raw milk price row
 *     description: >
 *       Manual override / seed for one raw milk family — the only pricing
 *       path for families NetSuite can't derive (A2 has no priced purchase
 *       transactions). Append-only, like the flat costs. NOTE — for families
 *       the daily NS sync CAN derive, a manual row stands only until the next
 *       sync finds a differing NS price and re-asserts it.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [family, pricePerLb]
 *             properties:
 *               family: { type: string, enum: [organic, conventional, a2, cream_organic, cream_conventional] }
 *               pricePerLb: { type: number, minimum: 0, exclusiveMinimum: true, example: 0.39 }
 *               note: { type: string, maxLength: 200 }
 *     responses:
 *       201: { description: Row created; body is the new current row for that family. }
 *       400: { description: Unknown family or invalid pricePerLb. }
 *       500: { description: Insert failed. }
 */
router.post('/raw-milk', async (req, res) => {
  try {
    const { family, pricePerLb, note } = req.body || {}
    if (!rawMilkPriceService.FAMILIES.includes(family)) {
      return res.status(400).json({ error: `family must be one of: ${rawMilkPriceService.FAMILIES.join(', ')}` })
    }
    const price = Number(pricePerLb)
    if (!Number.isFinite(price) || price <= 0) {
      return res.status(400).json({ error: 'pricePerLb is required and must be a positive number' })
    }
    const row = await rawMilkPriceService.appendManual({ family, pricePerLb: price, note })
    res.status(201).json({
      family: row.family,
      pricePerLb: num(row.pricePerLb),
      source: row.source,
      basis: row.basis || null,
      effectiveFrom: row.effectiveFrom,
    })
  } catch (err) {
    console.error('[CostsConfigRoutes] POST /raw-milk error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * @openapi
 * /api/mes/config/costs/fg-revenue:
 *   post:
 *     tags: [Costs Config]
 *     summary: Append a manual FG revenue rate for one bulk FG item
 *     description: >
 *       Manual override / seed for a bulk FG item's revenue-per-lb (what a
 *       pound would have earned as invoiced finished goods). fgItemId is NOT
 *       restricted to the parser catalog, so items the parser doesn't know
 *       yet can still be priced. Append-only. For items the daily NS sync
 *       CAN derive, a manual row stands only until the next sync finds a
 *       differing rate.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fgItemId, revenuePerLb]
 *             properties:
 *               fgItemId: { type: string, example: "6420", description: Bulk FG assembly NS internal id. }
 *               revenuePerLb: { type: number, minimum: 0, exclusiveMinimum: true, example: 0.86 }
 *               note: { type: string, maxLength: 200 }
 *     responses:
 *       201: { description: Row created; body is the new current rate for that item. }
 *       400: { description: Invalid fgItemId / revenuePerLb. }
 *       500: { description: Insert failed. }
 */
router.post('/fg-revenue', async (req, res) => {
  try {
    const { fgItemId, revenuePerLb, note } = req.body || {}
    if (!/^\d+$/.test(String(fgItemId ?? ''))) {
      return res.status(400).json({ error: 'fgItemId is required and must be a NetSuite internal id (digits only)' })
    }
    const rate = Number(revenuePerLb)
    if (!Number.isFinite(rate) || rate <= 0) {
      return res.status(400).json({ error: 'revenuePerLb is required and must be a positive number' })
    }
    const row = await fgRevenueRateService.appendManual({ fgItemId, revenuePerLb: rate, note })
    res.status(201).json({
      fgItemId: row.fgItemId,
      itemName: fgItemName(row.fgItemId),
      revenuePerLb: num(row.revenuePerLb),
      source: row.source,
      basis: row.basis || null,
      effectiveFrom: row.effectiveFrom,
    })
  } catch (err) {
    console.error('[CostsConfigRoutes] POST /fg-revenue error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
