/**
 * Backfill / re-price the persisted Milk Loss history (SD-729).
 *
 * Recomputes MesLossDaily rows for every plant day in [--from, --to]
 * (inclusive, YYYY-MM-DD) at CURRENT raw-milk prices via
 * lossReportService.rollupDaily — the same function the nightly
 * lossRollupJob runs for the last 3 days. Idempotent: each day is deleted and
 * re-inserted in one transaction. Batch tables are only read.
 *
 * Dry run by default (prints what it would write, per day); --confirm writes.
 * Table set follows ENVIRONMENT (dev_/prod_), like everything else.
 *
 * Usage:
 *   ENVIRONMENT=prod node scripts/backfillLossDaily.js --from 2026-07-01 --to 2026-09-13
 *   ENVIRONMENT=prod node scripts/backfillLossDaily.js --from 2026-07-01 --to 2026-09-13 --confirm
 */
const config = require('../config')
const db = require('../models')
const svc = require('../services/lossReportService')
const plantTime = require('../utils/plantTime')

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def
}
const fromDay = arg('from')
const toDay = arg('to', plantTime.addPlantDays(plantTime.plantDateString(), -1))
const confirm = process.argv.includes('--confirm')
if (!fromDay || !/^\d{4}-\d{2}-\d{2}$/.test(fromDay) || !/^\d{4}-\d{2}-\d{2}$/.test(toDay) || toDay < fromDay) {
  console.error('usage: node scripts/backfillLossDaily.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--confirm]')
  process.exit(2)
}

async function main() {
  await config.sequelize.authenticate()
  console.log(`${confirm ? 'WRITING' : 'DRY RUN'} · tables ${config.TABLE_PREFIX}* · plant days ${fromDay}..${toDay}`)
  const from = plantTime.startOfPlantDay(fromDay)
  const to = plantTime.startOfPlantDay(plantTime.addPlantDays(toDay, 1))

  // Preview: the same per-day rows the rollup will persist, summarised.
  const rows = await svc.computeStages({ from, to, groupBy: 'day' }, await require('../services/lossReportService')._pricingContext())
  const perDay = new Map()
  for (const r of rows) {
    const d = perDay.get(r.bucket) || { day: r.bucket, rows: 0, batches: 0, wasteLbs: 0, wasteUsd: 0 }
    d.rows++; d.batches += r.batches; d.wasteLbs += r.wasteLbs; d.wasteUsd += r.wasteUsd || 0
    perDay.set(r.bucket, d)
  }
  const days = [...perDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1))
  console.table(days.map(d => ({ day: d.day, groups: d.rows, batches: d.batches, wasteLbs: Math.round(d.wasteLbs), wasteUsd: Math.round(d.wasteUsd) })))
  console.log(`${days.length} day(s) with data, ${rows.length} group row(s) before collapsing products`)

  if (!confirm) {
    console.log('Dry run — nothing written. Re-run with --confirm to persist.')
  } else {
    // Ensure the table exists on a DB that has never booted this version.
    await db.MesLossDaily.sync()
    const result = await svc.rollupDaily({ fromDay, toDay })
    console.log('Written:', JSON.stringify(result))
  }
  await config.sequelize.close()
}

main().catch(err => { console.error('BACKFILL FAILED:', err.message); process.exit(1) })
