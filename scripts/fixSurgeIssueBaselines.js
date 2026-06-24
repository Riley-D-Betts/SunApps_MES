/**
 * One-time fix: advance lastIssuedUhtGal → lastTotalizerGal for any
 * MesSurgeTankIssueState row where lastIssuedUhtGal=0 but
 * lastTotalizerGal>0.  These rows were created with the old buggy
 * initialisation (baseline=0) and are stuck trying to issue the entire
 * UHT run history in one shot, which always fails for insufficient inventory.
 *
 * After this fix each subsequent tick will only issue the incremental delta
 * that accumulates from this point forward.
 *
 * Safe to re-run: rows that already have lastIssuedUhtGal>0 are untouched.
 */
const { sequelize } = require('../config')
const db = require('../models')

async function main() {
  await sequelize.authenticate()

  const stale = await db.MesSurgeTankIssueState.findAll({
    where: {
      lastIssuedUhtGal: 0,
    },
  })

  const toFix = stale.filter(s => parseFloat(s.lastTotalizerGal) > 0)
  console.log(`Found ${stale.length} states with lastIssuedUhtGal=0; ${toFix.length} have a non-zero totalizer and need fixing.`)

  for (const s of toFix) {
    const newBaseline = parseFloat(s.lastTotalizerGal)
    console.log(`  batchId=${s.surgeTankBatchId}  uht=${s.uhtId}  old=0 → new=${newBaseline.toFixed(2)} gal`)
    await s.update({ lastIssuedUhtGal: newBaseline })
  }

  console.log('Done.')
  await sequelize.close()
}

main().catch(err => { console.error('FAILED:', err); process.exit(1) })
