/**
 * SD-597 diagnostic: why did an A2 4% Whole surge batch (a silo->TSTAT->surge
 * bypass) back-look to a blend tank and pin "Raw Kirkland 2% Organic Lactose
 * Free" as its component?
 *
 * Read-only. Prints the surge batch's resolution fields (the smoking gun is
 * componentResolvedFrom: 'blend-tank-recent' = the 72h stale fallback fired) and
 * the blend batches on that tank that the fallback could have grabbed.
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')

async function main() {
  await sequelize.authenticate()

  // Recent surge batches whose FG looks like A2 (Alexandre / A2 / 4% Whole).
  const surge = await db.MesSurgeTankBatch.findAll({
    where: {
      [Op.or]: [
        { productName: { [Op.like]: '%A2%' } },
        { productName: { [Op.like]: '%Alexandre%' } },
        { productName: { [Op.like]: '%4% Whole%' } },
      ],
    },
    order: [['detectedAt', 'DESC']],
    limit: 15,
  })

  console.log(`\n=== ${surge.length} recent A2/Alexandre/4%-Whole surge batches ===`)
  for (const b of surge) {
    console.log(
      `  id=${b.id} status=${b.status} product="${b.productName}"\n` +
      `      mesItem=${b.mesItem} componentItemId=${b.componentItemId} resolvedFrom=${b.componentResolvedFrom}` +
      ` layerSkip=${b.layerSkipReason} pairing=${b.pairingStatus}\n` +
      `      feedingFromEntName=${b.feedingFromEntName} feedingUhtId=${b.feedingUhtId}` +
      ` detected=${b.detectedAt && b.detectedAt.toISOString()}`
    )
  }

  // For any surge batch that resolved from a blend tank, show the blend batches
  // on that tank within 72h before it — i.e. exactly what the fallback queried.
  const fromBlend = surge.filter(b => /^blend-tank/.test(b.componentResolvedFrom || '') && b.feedingFromEntName)
  for (const b of fromBlend) {
    const windowStart = new Date(new Date(b.detectedAt).getTime() - 72 * 60 * 60 * 1000)
    const candidates = await db.MesBlendTankBatch.findAll({
      where: {
        tankId: b.feedingFromEntName,
        detectedAt: { [Op.gte]: windowStart, [Op.lte]: b.detectedAt },
      },
      order: [['detectedAt', 'DESC']],
    })
    console.log(`\n=== blend batches on ${b.feedingFromEntName} in the 72h before surge id=${b.id} (${b.detectedAt && b.detectedAt.toISOString()}) ===`)
    for (const c of candidates) {
      console.log(
        `  blend id=${c.id} status=${c.status} mesItem=${c.mesItem} product="${c.productName}"` +
        ` completedLbs=${c.cumulativeCompletedLbs} detected=${c.detectedAt && c.detectedAt.toISOString()}`
      )
    }
    if (!candidates.length) console.log('  (none)')
  }

  await sequelize.close()
}
main().catch(e => { console.error(e); process.exit(1) })
