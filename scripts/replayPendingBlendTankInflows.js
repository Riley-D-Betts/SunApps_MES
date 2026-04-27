/**
 * Replay MesBlendTankInflow rows that landed on status='pending_ns' before
 * the SD-577 fix to the WO issue path. Re-issues each via the new direct
 * /record/v1/workOrderIssue endpoint.
 *
 * Strategy:
 *   - Group by (blendTankBatchId, line). Within each group the row with the
 *     highest totalLbs is the "winner" — that's the final accumulator
 *     reading for that line on that batch. Earlier rows in the same group
 *     are duplicate captures of the same physical transfer (the dedup key
 *     was resetTime, which apparently changes between polls even when the
 *     totalizer hasn't reset).
 *   - Issue the winner. Mark dupes as 'superseded' so they don't sit at
 *     pending_ns forever.
 *   - Skip groups whose batch lacks an nsWorkOrderId, or whose batch is
 *     'completed' (NS rejects post-completion issues) unless
 *     --include-completed is passed.
 *   - Recover siloName from the original MesProcessingLog payload to get
 *     the bin. If we can't, skip with reason 'no bin'.
 *
 * Usage:
 *   node scripts/replayPendingBlendTankInflows.js
 *   node scripts/replayPendingBlendTankInflows.js --confirm
 *   node scripts/replayPendingBlendTankInflows.js --confirm --include-completed
 */

const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')
const core = require('../clients/coreClient')
const itemConfig = require('../services/mesItemConfig')

const confirm = process.argv.includes('--confirm')
const includeCompleted = process.argv.includes('--include-completed')

async function siloFromLog(batchWoId, line, resetTime) {
  const logs = await db.MesProcessingLog.findAll({
    where: { eventType: 'blend_tank_line_issue', sourceId: String(batchWoId) },
    order: [['createdAt', 'DESC']],
    limit: 200,
  })
  for (const l of logs) {
    if (!l.payload) continue
    try {
      const p = JSON.parse(l.payload)
      if (p.line !== line) continue
      if (resetTime && p.resetTime && new Date(p.resetTime).getTime() !== new Date(resetTime).getTime()) continue
      if (p.siloName) return p.siloName
    } catch { /* ignore */ }
  }
  return null
}

async function main() {
  await sequelize.authenticate()

  const inflows = await db.MesBlendTankInflow.findAll({
    where: {
      status: 'pending_ns',
      nsItemId: { [Op.ne]: null },
      blendTankBatchId: { [Op.ne]: null },
    },
    order: [['createdAt', 'ASC']],
  })

  if (inflows.length === 0) {
    console.log('No pending_ns inflows.')
    return
  }

  // Group by (batchId, line) → keep all rows, identify winner = max totalLbs
  const groups = new Map()
  for (const r of inflows) {
    const k = `${r.blendTankBatchId}|${r.line}`
    const arr = groups.get(k) || []
    arr.push(r)
    groups.set(k, arr)
  }

  const candidates = []
  for (const arr of groups.values()) {
    arr.sort((a, b) => Number(b.totalLbs) - Number(a.totalLbs))
    candidates.push({ winner: arr[0], superseded: arr.slice(1) })
  }

  // Resolve batch + silo for each
  for (const c of candidates) {
    c.batch = await db.MesBlendTankBatch.findByPk(c.winner.blendTankBatchId)
    if (!c.batch?.nsWorkOrderId) { c.skipReason = 'batch has no nsWorkOrderId'; continue }
    if (!includeCompleted && c.batch.status === 'completed') { c.skipReason = `batch already completed (use --include-completed to retry anyway)`; continue }
    c.siloName = await siloFromLog(c.batch.nsWorkOrderId, c.winner.line, c.winner.resetTime)
    c.binId = c.siloName ? itemConfig.getBinId(c.siloName) : null
    if (!c.binId) c.skipReason = `no bin (silo "${c.siloName || 'unknown'}")`
  }

  console.log(`${confirm ? 'Replaying' : '[dry run] Would replay'} pending_ns inflows:`)
  console.log(`  total inflows: ${inflows.length}`)
  console.log(`  unique groups (batch,line): ${candidates.length}`)
  console.log(`  duplicates to mark superseded: ${candidates.reduce((n, c) => n + c.superseded.length, 0)}`)
  console.log(`  ready to issue: ${candidates.filter(c => !c.skipReason).length}`)
  console.log(`  skipped: ${candidates.filter(c => c.skipReason).length}`)
  console.log()

  for (const c of candidates) {
    const w = c.winner
    const tag = c.skipReason ? `SKIP (${c.skipReason})` : 'ISSUE'
    const wo = c.batch?.nsWorkOrderId || '-'
    console.log(`  [${tag}] batch ${c.batch?.id || '?'} (WO ${wo}, status ${c.batch?.status || '?'}) · ${w.line} · ${w.ingredientType} · NS ${w.nsItemId} · ${Number(w.totalLbs).toFixed(1)} LBS · silo "${c.siloName || '?'}" → bin ${c.binId || '?'} · ${c.superseded.length} dupe(s)`)
  }

  if (!confirm) {
    console.log('\nDry run only. Re-run with --confirm to actually issue.')
    return
  }

  let ok = 0, fail = 0, skipped = 0
  for (const c of candidates) {
    if (c.skipReason) {
      skipped++
      continue
    }
    const w = c.winner
    const qty = Number(w.totalLbs)
    try {
      const body = {
        transaction: { id: c.batch.nsWorkOrderId },
        item: {
          items: [{
            item: { id: w.nsItemId },
            quantity: qty,
            inventorydetail: {
              inventoryassignment: {
                items: [{ quantity: qty, binnumber: { id: c.binId } }],
              },
            },
          }],
        },
      }
      const result = await core.netsuitePost('/record/v1/workOrderIssue', body)
      let issueId = result?.id || null
      if (!issueId && result?.headers?.location) {
        const m = result.headers.location.match(/\/(\d+)$/)
        if (m) issueId = m[1]
      }
      await w.update({ status: 'completed', nsIssueId: issueId })
      if (c.superseded.length > 0) {
        await db.MesBlendTankInflow.update(
          { status: 'superseded' },
          { where: { id: c.superseded.map(r => r.id) } }
        )
      }
      ok++
      console.log(`  ✓ batch ${c.batch.id} ${w.line} → issue ${issueId}`)
    } catch (err) {
      await w.update({ status: 'error', errorMessage: err.message })
      fail++
      console.log(`  ✗ batch ${c.batch.id} ${w.line}: ${err.message}`)
    }
  }

  console.log(`\nDone. issued=${ok}, failed=${fail}, skipped=${skipped}`)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => sequelize.close())
