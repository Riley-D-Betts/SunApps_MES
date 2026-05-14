/**
 * Cancel "phantom" tank batches — rows that got created by the pre-fix
 * jobs/surgeTankJob and jobs/blendTankJob when the historian returned a
 * sentinel productDesc/NOTE_STRING ("Empty", "CIP", "Water", etc.) or a CIP-
 * mode tank state. These never represented real production runs and will
 * either sit forever as 'active' / 'pending_ns' or keep getting ticked
 * without anything to issue.
 *
 * Identification rules (applied per tank):
 *
 *   1. tankId contains '→' (blend tanks only). This is the legacy UHT-direct
 *      virtual-batch convention used by the deleted code path in
 *      jobs/blendTankJob:147-214 (pre-SD-597). Rows like 'ML2→TSTAT1' /
 *      'ML4→TSTAT1' / 'ML2→TSTAT2' are zombies — the code that would have
 *      closed them is gone, so they stay 'active' forever and pollute the
 *      tick state.
 *   2. productName matches a known sentinel (case-insensitive trim against
 *      PRODUCT_SENTINELS — same set used by the jobs).
 *   3. status === 'pending_ns' AND nsWorkOrderId IS NULL (parser found no
 *      match and no NS WO was ever created).
 *
 * On match, the row is updated to status='cancelled', completedAt=now, with
 * an errorMessage noting the reason. The corresponding NS WOs (if any exist
 * for active rows) are NOT touched — they get cleaned up in NetSuite manually
 * or via the existing NS workflow.
 *
 * Defaults to dry-run. Pass --confirm to apply.
 *
 * Usage:
 *   node scripts/cleanupPhantomTankBatches.js                # dry-run
 *   node scripts/cleanupPhantomTankBatches.js --confirm      # apply
 *   node scripts/cleanupPhantomTankBatches.js --surge-only   # skip blend
 *   node scripts/cleanupPhantomTankBatches.js --blend-only   # skip surge
 */

const db = require('../models')
const { sequelize } = require('../config')

const confirm = process.argv.includes('--confirm')
const surgeOnly = process.argv.includes('--surge-only')
const blendOnly = process.argv.includes('--blend-only')

// Must stay in sync with PRODUCT_SENTINELS in jobs/surgeTankJob.js + jobs/blendTankJob.js.
const PRODUCT_SENTINELS = new Set(['', 'none', 'empty', 'cip', 'water', 'sterile', 'n/a', '-', '--'])

function isSentinel(productName) {
  if (productName == null) return true
  const t = String(productName).trim().toLowerCase()
  return PRODUCT_SENTINELS.has(t)
}

// Pre-SD-597, jobs/blendTankJob:147-214 created MesBlendTankBatch rows with a
// composite tankId of '{line}→{requestedBy}' (e.g. 'ML2→TSTAT1') whenever a
// milk/cream line started flowing toward a UHT/TSTAT. That code path is gone;
// these rows have no closer and accumulate forever.
function isLegacyUhtDirect(row) {
  return typeof row.tankId === 'string' && row.tankId.includes('→')
}

function classifyReason(row, { isBlend }) {
  if (isBlend && isLegacyUhtDirect(row)) {
    return `legacy UHT-direct virtual batch (tankId='${row.tankId}', NS WO=${row.nsWorkOrderId || 'none'})`
  }
  if (isSentinel(row.productName)) return `sentinel productName ("${row.productName}")`
  if (row.status === 'pending_ns' && !row.nsWorkOrderId) return 'pending_ns with no NS WO (parser found nothing)'
  return null
}

async function cleanupModel(Model, label, { isBlend }) {
  // Pull a wider net than strictly needed — rows the operator may still want
  // — and classify each one. We only cancel rows that match a rule.
  const candidates = await Model.findAll({
    where: { status: ['active', 'pending_ns'] },
    order: [['detectedAt', 'ASC']],
  })

  if (candidates.length === 0) {
    console.log(`[${label}] No active / pending_ns rows found.`)
    return { matched: 0, cancelled: 0 }
  }

  let matched = 0
  let cancelled = 0
  for (const row of candidates) {
    const reason = classifyReason(row, { isBlend })
    if (!reason) continue
    matched++

    const detected = row.detectedAt ? new Date(row.detectedAt).toISOString() : '?'
    console.log(`[${label}] id=${row.id} tank=${row.tankId} status=${row.status} product="${row.productName}" nsWO=${row.nsWorkOrderId || 'none'} detected=${detected}`)
    console.log(`  reason: ${reason}`)

    if (!confirm) {
      console.log('  [dry run] would set status=cancelled\n')
      continue
    }
    try {
      await row.update({
        status: 'cancelled',
        completedAt: new Date(),
        errorMessage: `Phantom cleanup: ${reason}`,
      })
      cancelled++
      console.log('  OK — cancelled\n')
    } catch (err) {
      console.error(`  FAILED: ${err.message}\n`)
    }
  }
  return { matched, cancelled }
}

async function main() {
  console.log(`Phantom tank batch cleanup ${confirm ? '(LIVE)' : '(dry run — pass --confirm to apply)'}`)
  console.log('Sentinels:', [...PRODUCT_SENTINELS].filter(Boolean).join(', '), '\n')

  const totals = { surge: { matched: 0, cancelled: 0 }, blend: { matched: 0, cancelled: 0 } }

  if (!blendOnly) {
    totals.surge = await cleanupModel(db.MesSurgeTankBatch, 'SurgeTank', { isBlend: false })
    console.log()
  }
  if (!surgeOnly) {
    totals.blend = await cleanupModel(db.MesBlendTankBatch, 'BlendTank', { isBlend: true })
    console.log()
  }

  console.log('Summary:')
  if (!blendOnly) console.log(`  Surge: ${totals.surge.matched} match(es), ${confirm ? `${totals.surge.cancelled} cancelled` : 'dry run'}`)
  if (!surgeOnly) console.log(`  Blend: ${totals.blend.matched} match(es), ${confirm ? `${totals.blend.cancelled} cancelled` : 'dry run'}`)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => sequelize.close())
