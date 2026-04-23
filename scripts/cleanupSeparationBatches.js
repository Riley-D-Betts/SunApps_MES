/**
 * One-off cleanup for junk MesSeparationBatch rows.
 *
 * Targets:
 *   - Mock batches (sourceSilo starting with 'SILO_') — these came from the
 *     mockProvider when dev ran against the mock historian, with no real bins
 *     or items so every row landed on pending_ns. Harmless but noisy.
 *   - Optionally, status='error' rows from pre-SD-577 runs where the old item
 *     resolution pushed an invalid NS item to /assemblyUnbuild.
 *
 * Defaults to dry-run. Pass --confirm to actually delete. Pass --errors to
 * include the error rows in the delete.
 *
 * Usage:
 *   node scripts/cleanupSeparationBatches.js
 *   node scripts/cleanupSeparationBatches.js --confirm
 *   node scripts/cleanupSeparationBatches.js --confirm --errors
 */

const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

const confirm = process.argv.includes('--confirm')
const includeErrors = process.argv.includes('--errors')

async function main() {
  await sequelize.authenticate()

  const where = {
    [Op.or]: [
      { sourceSilo: { [Op.like]: 'SILO_%' } },
      ...(includeErrors ? [{ status: 'error' }] : []),
    ],
  }

  const rows = await db.MesSeparationBatch.findAll({
    where,
    attributes: ['id', 'batchId', 'sourceSilo', 'status', 'inputVolume', 'createdAt'],
    order: [['createdAt', 'DESC']],
  })

  if (rows.length === 0) {
    console.log('No matching rows.')
    return
  }

  console.log(`${confirm ? 'Deleting' : '[dry run] Would delete'} ${rows.length} row(s):`)
  const byKind = {}
  for (const r of rows) {
    const kind = r.sourceSilo?.startsWith('SILO_') ? 'mock'
      : r.status === 'error' ? 'error'
      : 'other'
    byKind[kind] = (byKind[kind] || 0) + 1
  }
  for (const [k, n] of Object.entries(byKind)) {
    console.log(`  ${k}: ${n}`)
  }

  // Show a small sample so we can confirm it's what we expect.
  console.log('Sample (up to 10):')
  for (const r of rows.slice(0, 10)) {
    console.log(`  #${r.id}  ${r.batchId.padEnd(25)}  ${String(r.sourceSilo).padEnd(10)}  ${r.status.padEnd(12)}  ${Math.round(r.inputVolume)} lb  ${r.createdAt.toISOString()}`)
  }

  if (!confirm) {
    console.log('\nDry run only. Re-run with --confirm to delete.')
    return
  }

  const deleted = await db.MesSeparationBatch.destroy({ where })
  console.log(`Deleted ${deleted} row(s).`)
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => sequelize.close())
