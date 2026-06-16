'use strict'

const db = require('../models')
const { Op, fn, col } = require('sequelize')

// ── Sort field whitelists (guard against SQL injection via ORDER BY) ──────────

const BLEND_SORT_FIELDS = [
  'detectedAt', 'completedAt', 'cumulativeIssuedLbs', 'cumulativeOutputLbs',
  'cumulativeCompletedLbs', 'wastePercent', 'wasteLbs', 'tankId', 'productName', 'status',
]
const SURGE_SORT_FIELDS = [
  'detectedAt', 'completedAt', 'cumulativeIssuedLbs', 'cumulativeOutputLbs',
  'cumulativeCompletedLbs', 'wastePercent', 'wasteLbs', 'tankId', 'productName',
  'feedingUhtId', 'feedingFromEntName', 'status',
]
const SEPARATION_SORT_FIELDS = [
  'batchStart', 'batchEnd', 'createdAt', 'inputVolume', 'creamVolume', 'skimVolume',
  'wasteVolume', 'wastePercent', 'sourceSilo', 'status',
]

// ── Shared helpers ────────────────────────────────────────────────────────────

function buildWhere({ from, to, dateField, tankId, tankField, status, product }) {
  const where = {}

  const dateWhere = {}
  if (from) dateWhere[Op.gte] = new Date(from)
  if (to)   dateWhere[Op.lte] = new Date(to)
  if (Object.keys(dateWhere).length) where[dateField] = dateWhere

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

async function getSummary(Model, where, { issuedField = 'cumulativeIssuedLbs', outputField = 'cumulativeOutputLbs', completedField = 'cumulativeCompletedLbs' } = {}) {
  const attrs = [
    [fn('COUNT', col('id')), 'batchCount'],
    [fn('AVG', col('wastePercent')), 'avgWastePercent'],
    [fn('SUM', col(issuedField)), 'totalIssuedLbs'],
  ]
  if (outputField)    attrs.push([fn('SUM', col(outputField)),    'totalOutputLbs'])
  if (completedField) attrs.push([fn('SUM', col(completedField)), 'totalCompletedLbs'])

  const [result] = await Model.findAll({ where, attributes: attrs, raw: true })
  return {
    batchCount:        Number(result?.batchCount)        || 0,
    avgWastePercent:   result?.avgWastePercent   != null ? Number(result.avgWastePercent)   : null,
    totalIssuedLbs:    result?.totalIssuedLbs    != null ? Number(result.totalIssuedLbs)    : null,
    totalOutputLbs:    result?.totalOutputLbs    != null ? Number(result.totalOutputLbs)    : null,
    totalCompletedLbs: result?.totalCompletedLbs != null ? Number(result.totalCompletedLbs) : null,
  }
}

async function runTrendQuery({ tableName, dateField, issuedField, from, to, groupBy = 'day' }) {
  const conditions = [`[${dateField}] IS NOT NULL`]
  const replacements = {}

  if (from) { conditions.push(`[${dateField}] >= :from`); replacements.from = new Date(from) }
  if (to)   { conditions.push(`[${dateField}] <= :to`);   replacements.to   = new Date(to)   }

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
    getSummary(db.MesBlendTankBatch, where),
  ])
  return { total: summary.batchCount, batches: rows, summary }
}

async function getBlendTrend({ from, to, groupBy }) {
  const tableName = db.MesBlendTankBatch.getTableName()
  return runTrendQuery({ tableName, dateField: 'detectedAt', issuedField: 'cumulativeIssuedLbs', from, to, groupBy })
}

// ── Surge Tanks ───────────────────────────────────────────────────────────────

async function getSurgeBatches({ from, to, tankId, status, product, sortBy, sortDir, limit, offset }) {
  const where = buildWhere({ from, to, dateField: 'detectedAt', tankId, tankField: 'tankId', status, product })
  const order = buildOrder(sortBy, sortDir, SURGE_SORT_FIELDS)
  const safeLimit  = Math.min(Number(limit)  || 200, 500)
  const safeOffset = Math.max(Number(offset) || 0, 0)

  const [rows, summary] = await Promise.all([
    db.MesSurgeTankBatch.findAll({ where, order, limit: safeLimit, offset: safeOffset }),
    getSummary(db.MesSurgeTankBatch, where),
  ])
  return { total: summary.batchCount, batches: rows, summary }
}

async function getSurgeTrend({ from, to, groupBy }) {
  const tableName = db.MesSurgeTankBatch.getTableName()
  return runTrendQuery({ tableName, dateField: 'detectedAt', issuedField: 'cumulativeIssuedLbs', from, to, groupBy })
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
    }),
  ])
  return { total: summary.batchCount, batches: rows, summary }
}

async function getSeparationTrend({ from, to, groupBy }) {
  const tableName = db.MesSeparationBatch.getTableName()
  return runTrendQuery({ tableName, dateField: 'batchStart', issuedField: 'inputVolume', from, to, groupBy })
}

module.exports = {
  getBlendBatches,
  getBlendTrend,
  getSurgeBatches,
  getSurgeTrend,
  getSeparationBatches,
  getSeparationTrend,
}
