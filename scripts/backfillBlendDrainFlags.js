/**
 * Backfill blend fill-while-draining flags (SD-722).
 *
 * For every completed blend batch closed in [--from, --to] (plant dates,
 * inclusive) whose drainedWhileFilling is still NULL (or all, with --recheck),
 * reads the tank's outlet-valve history over its fill window and stores
 * drainedWhileFilling + drainOverlapMinutes — see
 * services/blendDrainCheckService.js. Reads the historian (sequential, 2 reads
 * per batch); writes ONLY those two columns on our own table. Never touches
 * NetSuite.
 *
 * Dry run by default (prints the verdicts); --confirm writes. Table set
 * follows ENVIRONMENT. Needs HISTORIAN_PROVIDER=rest.
 *
 *   ENVIRONMENT=prod HISTORIAN_PROVIDER=rest node scripts/backfillBlendDrainFlags.js --from 2026-07-01
 *   ENVIRONMENT=prod HISTORIAN_PROVIDER=rest node scripts/backfillBlendDrainFlags.js --from 2026-07-01 --confirm
 */
const { Op } = require('sequelize')
const config = require('../config')
const db = require('../models')
const { createProvider } = require('../historian')
const plantTime = require('../utils/plantTime')
const drainCheck = require('../services/blendDrainCheckService')

const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def }
const fromDay = arg('from')
const toDay = arg('to', plantTime.plantDateString())
const confirm = process.argv.includes('--confirm')
const recheck = process.argv.includes('--recheck')
if (!fromDay) { console.error('usage: node scripts/backfillBlendDrainFlags.js --from YYYY-MM-DD [--to YYYY-MM-DD] [--recheck] [--confirm]'); process.exit(2) }

async function main() {
  await config.sequelize.authenticate()
  if (confirm) await db.ensureRuntimeSchema()   // the app's own guarded DDL — adds the two columns if this table set has not booted 1.0.13
  const historian = createProvider(config.HISTORIAN_PROVIDER)
  const where = {
    status: 'completed',
    cumulativeIssuedLbs: { [Op.gte]: 100 },
    completedAt: { [Op.gte]: plantTime.startOfPlantDay(fromDay), [Op.lt]: plantTime.startOfPlantDay(plantTime.addPlantDays(toDay, 1)) },
  }
  const hasColumn = (await db.sequelize.query(`SELECT COUNT(*) AS n FROM sys.columns WHERE Name = N'drainedWhileFilling' AND Object_ID = Object_ID(N'${db.MesBlendTankBatch.getTableName()}')`, { type: db.Sequelize.QueryTypes.SELECT }))[0].n > 0
  if (hasColumn && !recheck) where.drainedWhileFilling = null
  const batches = await db.MesBlendTankBatch.findAll({ where, order: [['id', 'ASC']], attributes: ['id', 'tankId', 'productName', 'wastePercent', 'actualStartAt', 'detectedAt', 'createdAt', 'completedAt'] })
  console.log(`${confirm ? 'WRITING' : 'DRY RUN'} · ${config.TABLE_PREFIX}MesBlendTankBatches · closed ${fromDay}..${toDay} · ${batches.length} batch(es)${hasColumn ? '' : ' (column not present yet — dry run only shows verdicts)'}`)
  const rows = []
  for (const b of batches) {
    try {
      const r = await drainCheck.checkBatch(b, historian, { dryRun: !confirm || !hasColumn && !confirm })
      rows.push({ id: b.id, tank: b.tankId, product: String(b.productName || '').slice(0, 28), wastePct: b.wastePercent != null ? Number(b.wastePercent) : null, drained: r.checked ? r.drained : '?', minutes: r.minutes, uht1: r.byUht && r.byUht.UHT1, uht2: r.byUht && r.byUht.UHT2 })
    } catch (err) {
      rows.push({ id: b.id, tank: b.tankId, error: err.message.slice(0, 80) })
    }
  }
  console.table(rows)
  console.log(`drained while filling: ${rows.filter(r => r.drained === true).length} of ${rows.length}${confirm ? ' — written' : ' — dry run, nothing written'}`)
  await config.sequelize.close()
}
main().catch(err => { console.error('BACKFILL FAILED:', err.message); process.exit(1) })
