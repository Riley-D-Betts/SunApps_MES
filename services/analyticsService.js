'use strict'

const db = require('../models')
const { Op, fn, col, cast, literal } = require('sequelize')

// ── Sort field whitelists (guard against SQL injection via ORDER BY) ──────────

const BLEND_SORT_FIELDS = [
  'detectedAt', 'completedAt', 'cumulativeIssuedLbs', 'cumulativeOutputLbs',
  'cumulativeCompletedLbs', 'wastePercent', 'wasteLbs', 'tankId', 'productName', 'status',
]
const SURGE_SORT_FIELDS = [
  'detectedAt', 'completedAt', 'cumulativeIssuedLbs', 'cumulativeOutputLbs',
  'cumulativeCompletedLbs', 'wastePercent', 'wasteLbs', 'tankId', 'productName',
  'feedingUhtId', 'feedingFromEntName', 'status',
  // SD-717: the metered-drain columns are sortable in the analytics UI —
  // without these entries buildOrder silently falls back to detectedAt.
  'meteredDrainLbs', 'outputWithDrainLbs',
]
const SEPARATION_SORT_FIELDS = [
  'batchStart', 'batchEnd', 'createdAt', 'inputVolume', 'creamVolume', 'skimVolume',
  'wasteVolume', 'wastePercent', 'sourceSilo', 'status',
]
const INV_ADJUST_SORT_FIELDS = [
  'createdAt', 'source', 'status', 'tankName', 'binId', 'itemId',
  'qtyDelta', 'observedLbs', 'nsQtyBefore',
]

// Split a comma-separated filter value into a clean array of distinct terms.
function splitValues(raw) {
  return String(raw).split(',').map(s => s.trim()).filter(Boolean)
}

// Coerce a query-string flag ('true'/'1'/true) to a boolean.
function truthy(v) {
  return v === true || v === 'true' || v === '1' || v === 1
}

// ── Shared helpers ────────────────────────────────────────────────────────────

function buildWhere({ from, to, dateField, tankId, tankField, status, product }) {
  const where = {}

  // NOTE: Op.gte/Op.lte are Symbol keys, which Object.keys() does not see — guard
  // on the raw inputs instead, or the date range is silently ignored.
  if (from || to) {
    const dateWhere = {}
    if (from) dateWhere[Op.gte] = new Date(from)
    if (to)   dateWhere[Op.lte] = new Date(to)
    where[dateField] = dateWhere
  }

  if (tankId) {
    const values = String(tankId).split(',').map(s => s.trim()).filter(Boolean)
    if (values.length === 1) where[tankField] = values[0]
    else if (values.length > 1) where[tankField] = { [Op.in]: values }
  }

  if (status) {
    const values = String(status).split(',').map(s => s.trim()).filter(Boolean)
    if (values.length === 1) where.status = values[0]
    else if (values.length > 1) where.status = { [Op.in]: values }
  }

  if (product) {
    where.productName = { [Op.like]: `%${product}%` }
  }

  return where
}

function buildOrder(sortBy, sortDir, validFields) {
  const field = validFields.includes(sortBy) ? sortBy : validFields[0]
  const dir = String(sortDir || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
  return [[field, dir]]
}

async function getSummary(Model, where, { issuedField = 'cumulativeIssuedLbs', outputField = 'cumulativeOutputLbs', completedField = 'cumulativeCompletedLbs', skimField = null, concurrentField = null, meteredDrainField = null, wasteField = null } = {}) {
  const attrs = [
    [fn('COUNT', col('id')), 'batchCount'],
    [fn('AVG', col('wastePercent')), 'avgWastePercent'],
    [fn('SUM', col(issuedField)), 'totalIssuedLbs'],
  ]
  if (outputField)    attrs.push([fn('SUM', col(outputField)),    'totalOutputLbs'])
  if (completedField) attrs.push([fn('SUM', col(completedField)), 'totalCompletedLbs'])
  if (skimField)      attrs.push([fn('SUM', col(skimField)),      'totalSkimLbs'])
  // Count batches whose waste is an upper bound because they filled and drained
  // at once (BIT column → cast to INT so SUM works on SQL Server).
  if (concurrentField) attrs.push([fn('SUM', cast(col(concurrentField), 'INT')), 'concurrentCount'])
  // Raw metered Filler-1 drain credit (SD-708) — pre-floor/pre-clamp diagnostic
  // sum, NOT the applied arrival effect (that's outputWithDrainLbs per batch).
  if (meteredDrainField) attrs.push([fn('SUM', col(meteredDrainField)), 'totalMeteredDrainLbs'])
  // Total waste over the filtered range (SD-717) — feeds the Waste-$ cards.
  if (wasteField) attrs.push([fn('SUM', col(wasteField)), 'totalWasteLbs'])

  const [result] = await Model.findAll({ where, attributes: attrs, raw: true })
  return {
    batchCount:        Number(result?.batchCount)        || 0,
    avgWastePercent:   result?.avgWastePercent   != null ? Number(result.avgWastePercent)   : null,
    totalIssuedLbs:    result?.totalIssuedLbs    != null ? Number(result.totalIssuedLbs)    : null,
    totalOutputLbs:    result?.totalOutputLbs    != null ? Number(result.totalOutputLbs)    : null,
    totalCompletedLbs: result?.totalCompletedLbs != null ? Number(result.totalCompletedLbs) : null,
    totalSkimLbs:      result?.totalSkimLbs      != null ? Number(result.totalSkimLbs)      : null,
    ...(concurrentField ? { concurrentCount: Number(result?.concurrentCount) || 0 } : {}),
    ...(meteredDrainField ? { totalMeteredDrainLbs: result?.totalMeteredDrainLbs != null ? Number(result.totalMeteredDrainLbs) : 0 } : {}),
    ...(wasteField ? { totalWasteLbs: result?.totalWasteLbs != null ? Number(result.totalWasteLbs) : 0 } : {}),
  }
}

async function runTrendQuery({ tableName, dateField, issuedField, from, to, groupBy = 'day', tankField, tankId, status, product }) {
  const conditions = [`[${dateField}] IS NOT NULL`]
  const replacements = {}

  if (from) { conditions.push(`[${dateField}] >= :from`); replacements.from = new Date(from) }
  if (to)   { conditions.push(`[${dateField}] <= :to`);   replacements.to   = new Date(to)   }

  // Mirror the table's filters so the chart and table always agree.
  if (tankField && tankId) {
    const values = splitValues(tankId)
    if (values.length) {
      const names = values.map((_, i) => `:tank${i}`)
      values.forEach((v, i) => { replacements[`tank${i}`] = v })
      conditions.push(`[${tankField}] IN (${names.join(', ')})`)
    }
  }
  if (status) {
    const values = splitValues(status)
    if (values.length) {
      const names = values.map((_, i) => `:status${i}`)
      values.forEach((v, i) => { replacements[`status${i}`] = v })
      conditions.push(`[status] IN (${names.join(', ')})`)
    }
  }
  if (product) {
    conditions.push(`[productName] LIKE :product`)
    replacements.product = `%${product}%`
  }

  const dateExpr = groupBy === 'week'
    ? `DATEADD(day, -(DATEPART(weekday, [${dateField}]) - 1), CONVERT(date, [${dateField}]))`
    : `CONVERT(date, [${dateField}])`

  const sql = `
    SELECT
      ${dateExpr} AS [date],
      COUNT(*) AS [batchCount],
      ISNULL(SUM([${issuedField}]), 0) AS [totalIssuedLbs],
      AVG([wastePercent]) AS [avgWastePercent]
    FROM [${tableName}]
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${dateExpr}
    ORDER BY [date] ASC
  `

  try {
    const rows = await db.sequelize.query(sql, {
      replacements,
      type: db.Sequelize.QueryTypes.SELECT,
    })
    return (Array.isArray(rows) ? rows : []).map(r => ({
      date:            r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      batchCount:      Number(r.batchCount) || 0,
      totalIssuedLbs:  Number(r.totalIssuedLbs) || 0,
      avgWastePercent: r.avgWastePercent != null ? Number(r.avgWastePercent) : null,
    }))
  } catch (err) {
    console.error(`[analyticsService] Trend query error (${tableName}):`, err.message)
    return []
  }
}

// ── Blend Tanks ───────────────────────────────────────────────────────────────

async function getBlendBatches({ from, to, tankId, status, product, sortBy, sortDir, limit, offset }) {
  const where = buildWhere({ from, to, dateField: 'detectedAt', tankId, tankField: 'tankId', status, product })
  const order = buildOrder(sortBy, sortDir, BLEND_SORT_FIELDS)
  const safeLimit  = Math.min(Number(limit)  || 200, 500)
  const safeOffset = Math.max(Number(offset) || 0, 0)

  const [rows, summary] = await Promise.all([
    db.MesBlendTankBatch.findAll({ where, order, limit: safeLimit, offset: safeOffset }),
    getSummary(db.MesBlendTankBatch, where, { wasteField: 'wasteLbs' }),
  ])
  return { total: summary.batchCount, batches: rows, summary }
}

async function getBlendTrend({ from, to, groupBy, tankId, status, product }) {
  const tableName = db.MesBlendTankBatch.getTableName()
  return runTrendQuery({ tableName, dateField: 'detectedAt', issuedField: 'cumulativeIssuedLbs', from, to, groupBy, tankField: 'tankId', tankId, status, product })
}

// ── Surge Tanks ───────────────────────────────────────────────────────────────

async function getSurgeBatches({ from, to, tankId, status, product, sortBy, sortDir, limit, offset }) {
  const where = buildWhere({ from, to, dateField: 'detectedAt', tankId, tankField: 'tankId', status, product })
  const order = buildOrder(sortBy, sortDir, SURGE_SORT_FIELDS)
  const safeLimit  = Math.min(Number(limit)  || 200, 500)
  const safeOffset = Math.max(Number(offset) || 0, 0)

  const [rows, summary] = await Promise.all([
    db.MesSurgeTankBatch.findAll({ where, order, limit: safeLimit, offset: safeOffset }),
    getSummary(db.MesSurgeTankBatch, where, { concurrentField: 'concurrentFillDrain', meteredDrainField: 'meteredDrainLbs', wasteField: 'wasteLbs' }),
  ])
  return { total: summary.batchCount, batches: rows, summary }
}

async function getSurgeTrend({ from, to, groupBy, tankId, status, product }) {
  const tableName = db.MesSurgeTankBatch.getTableName()
  return runTrendQuery({ tableName, dateField: 'detectedAt', issuedField: 'cumulativeIssuedLbs', from, to, groupBy, tankField: 'tankId', tankId, status, product })
}

// ── Separation ────────────────────────────────────────────────────────────────

async function getSeparationBatches({ from, to, sourceSilo, status, sortBy, sortDir, limit, offset }) {
  const where = buildWhere({ from, to, dateField: 'batchStart', tankId: sourceSilo, tankField: 'sourceSilo', status })
  const order = buildOrder(sortBy, sortDir, SEPARATION_SORT_FIELDS)
  const safeLimit  = Math.min(Number(limit)  || 200, 500)
  const safeOffset = Math.max(Number(offset) || 0, 0)

  const [rows, summary] = await Promise.all([
    db.MesSeparationBatch.findAll({ where, order, limit: safeLimit, offset: safeOffset }),
    getSummary(db.MesSeparationBatch, where, {
      issuedField: 'inputVolume',
      outputField: 'creamVolume',
      completedField: null,
      skimField: 'skimVolume',
    }),
  ])
  return { total: summary.batchCount, batches: rows, summary }
}

async function getSeparationTrend({ from, to, groupBy, sourceSilo, status }) {
  const tableName = db.MesSeparationBatch.getTableName()
  return runTrendQuery({ tableName, dateField: 'batchStart', issuedField: 'inputVolume', from, to, groupBy, tankField: 'sourceSilo', tankId: sourceSilo, status })
}

// ── Inventory Adjustments ───────────────────────────────────────────────────
// The auto inventory adjustments the system posts to NetSuite — 'sweep' (5-min
// tank-at-rest reconciliation) and 'shortfall' (inline top-ups before a retry).
// Every attempt is audited, including dry_run / error / skipped rows.

function buildInvAdjustWhere({ from, to, source, status, binId, itemId, tankName, excludePositiveSilo }) {
  const where = {}

  // Op.gte/Op.lte are Symbol keys (invisible to Object.keys) — guard on raw inputs.
  if (from || to) {
    const dateWhere = {}
    if (from) dateWhere[Op.gte] = new Date(from)
    if (to)   dateWhere[Op.lte] = new Date(to)
    where.createdAt = dateWhere
  }

  if (source) {
    const values = splitValues(source)
    if (values.length === 1) where.source = values[0]
    else if (values.length > 1) where.source = { [Op.in]: values }
  }
  if (status) {
    const values = splitValues(status)
    if (values.length === 1) where.status = values[0]
    else if (values.length > 1) where.status = { [Op.in]: values }
  }
  if (binId)  where.binId  = Number(binId)
  if (itemId) where.itemId = String(itemId)
  if (tankName) where.tankName = { [Op.like]: `%${tankName}%` }

  // Exclude positive silo adjustments — a sweep up-adjustment on a silo, i.e. as
  // if a truck delivery raised the silo level. Keep null-tankName rows and any
  // non-positive delta (NOT (silo AND up) expressed null-safely).
  if (truthy(excludePositiveSilo)) {
    where[Op.and] = [
      literal("([tankName] IS NULL OR [tankName] NOT LIKE '%silo%' OR [qtyDelta] <= 0)"),
    ]
  }

  return where
}

async function getInvAdjustSummary(where) {
  const attrs = [
    [fn('COUNT', col('id')), 'count'],
    [fn('SUM', col('qtyDelta')), 'netLbs'],
    [fn('SUM', literal('CASE WHEN [qtyDelta] > 0 THEN [qtyDelta] ELSE 0 END')), 'netUp'],
    [fn('SUM', literal('CASE WHEN [qtyDelta] < 0 THEN [qtyDelta] ELSE 0 END')), 'netDown'],
    [fn('SUM', literal("CASE WHEN [status] = 'error'   THEN 1 ELSE 0 END")), 'errorCount'],
    [fn('SUM', literal("CASE WHEN [status] = 'dry_run' THEN 1 ELSE 0 END")), 'dryRunCount'],
    [fn('SUM', literal("CASE WHEN [source] = 'sweep'     THEN 1 ELSE 0 END")), 'sweepCount'],
    [fn('SUM', literal("CASE WHEN [source] = 'shortfall' THEN 1 ELSE 0 END")), 'shortfallCount'],
  ]
  const [r] = await db.MesInventoryAdjustment.findAll({ where, attributes: attrs, raw: true })
  return {
    count:          Number(r?.count)          || 0,
    netLbs:         r?.netLbs   != null ? Number(r.netLbs)   : 0,
    netUp:          r?.netUp    != null ? Number(r.netUp)    : 0,
    netDown:        r?.netDown  != null ? Number(r.netDown)  : 0,
    errorCount:     Number(r?.errorCount)     || 0,
    dryRunCount:    Number(r?.dryRunCount)    || 0,
    sweepCount:     Number(r?.sweepCount)     || 0,
    shortfallCount: Number(r?.shortfallCount) || 0,
  }
}

async function getInventoryAdjustments({ from, to, source, status, binId, itemId, tankName, excludePositiveSilo, sortBy, sortDir, limit, offset }) {
  const where = buildInvAdjustWhere({ from, to, source, status, binId, itemId, tankName, excludePositiveSilo })
  const order = buildOrder(sortBy, sortDir, INV_ADJUST_SORT_FIELDS)
  const safeLimit  = Math.min(Number(limit)  || 200, 500)
  const safeOffset = Math.max(Number(offset) || 0, 0)

  const [rows, summary] = await Promise.all([
    db.MesInventoryAdjustment.findAll({ where, order, limit: safeLimit, offset: safeOffset }),
    getInvAdjustSummary(where),
  ])
  return { total: summary.count, adjustments: rows, summary }
}

async function getInventoryAdjustmentTrend({ from, to, groupBy = 'day', source, status, excludePositiveSilo }) {
  const tableName = db.MesInventoryAdjustment.getTableName()
  const dateField = 'createdAt'
  const conditions = [`[${dateField}] IS NOT NULL`]
  const replacements = {}

  if (from) { conditions.push(`[${dateField}] >= :from`); replacements.from = new Date(from) }
  if (to)   { conditions.push(`[${dateField}] <= :to`);   replacements.to   = new Date(to)   }
  if (source) {
    const values = splitValues(source)
    if (values.length) {
      const names = values.map((_, i) => `:source${i}`)
      values.forEach((v, i) => { replacements[`source${i}`] = v })
      conditions.push(`[source] IN (${names.join(', ')})`)
    }
  }
  if (status) {
    const values = splitValues(status)
    if (values.length) {
      const names = values.map((_, i) => `:status${i}`)
      values.forEach((v, i) => { replacements[`status${i}`] = v })
      conditions.push(`[status] IN (${names.join(', ')})`)
    }
  }
  if (truthy(excludePositiveSilo)) {
    conditions.push("([tankName] IS NULL OR [tankName] NOT LIKE '%silo%' OR [qtyDelta] <= 0)")
  }

  const dateExpr = groupBy === 'week'
    ? `DATEADD(day, -(DATEPART(weekday, [${dateField}]) - 1), CONVERT(date, [${dateField}]))`
    : `CONVERT(date, [${dateField}])`

  const sql = `
    SELECT
      ${dateExpr} AS [date],
      COUNT(*) AS [count],
      ISNULL(SUM([qtyDelta]), 0) AS [netLbs],
      SUM(CASE WHEN [status] = 'error' THEN 1 ELSE 0 END) AS [errorCount]
    FROM [${tableName}]
    WHERE ${conditions.join(' AND ')}
    GROUP BY ${dateExpr}
    ORDER BY [date] ASC
  `

  try {
    const rows = await db.sequelize.query(sql, {
      replacements,
      type: db.Sequelize.QueryTypes.SELECT,
    })
    return (Array.isArray(rows) ? rows : []).map(r => ({
      date:       r.date instanceof Date ? r.date.toISOString().slice(0, 10) : String(r.date).slice(0, 10),
      count:      Number(r.count) || 0,
      netLbs:     Number(r.netLbs) || 0,
      errorCount: Number(r.errorCount) || 0,
    }))
  } catch (err) {
    console.error(`[analyticsService] Trend query error (${tableName}):`, err.message)
    return []
  }
}

module.exports = {
  getBlendBatches,
  getBlendTrend,
  getSurgeBatches,
  getSurgeTrend,
  getSeparationBatches,
  getSeparationTrend,
  getInventoryAdjustments,
  getInventoryAdjustmentTrend,
}
