/**
 * SD-722 — READ-ONLY replay of the surge Layer-3 pin cross-check against real
 * batch rows. For each batch id it re-runs the component resolution AS OF the
 * batch's detectedAt (sim clock) and prints the old pin next to what the new
 * vetted resolver would do (pin / pin a different recent batch / reject).
 *
 *   ENVIRONMENT=prod node scripts/checkSurgePinCrossCheck.js 173 175 178 151 68
 *
 * Blend-fed batches run the full _resolveLayer3Source (recent-blend lookup +
 * FG vetting) against the DB. Silo / UHT-feed-line batches can't replay the
 * historical milk-line reading, so their stored pin is vetted directly with the
 * same family check the live path applies. The historian is a stub that
 * returns no live data, so the live-SCADA fallback never fires here.
 *
 * Safety: every Sequelize write method is replaced with a throwing stub before
 * anything runs — this script cannot modify any table in any environment. It
 * makes no NetSuite or historian calls.
 */
const path = require('path')
process.chdir(path.resolve(__dirname, '..'))
const db = require('../models')
const clock = require('../sim/clock')
const itemConfig = require('../services/mesItemConfig')

// Hard read-only guard.
for (const model of Object.values(db)) {
  if (!model || typeof model.findAll !== 'function') continue
  for (const m of ['create', 'bulkCreate', 'update', 'destroy', 'upsert', 'increment', 'decrement', 'findOrCreate']) {
    model[m] = () => { throw new Error(`read-only script: ${model.name}.${m} blocked`) }
  }
  model.prototype.save = model.prototype.update = model.prototype.destroy = model.prototype.increment = function () {
    throw new Error('read-only script: instance write blocked')
  }
}

const surge = require('../services/surgeTankMesService')
const stubHistorian = {
  getMilkLineStatus: async () => [],
  getBlendTankStatus: async () => [],
  getUhtStatus: async () => [],
}

;(async () => {
  const ids = process.argv.slice(2).map(Number).filter(Boolean)
  if (!ids.length) { console.error('usage: node scripts/checkSurgePinCrossCheck.js <batchId> …'); process.exit(2) }
  // This may run against a DB where ensureRuntimeSchema hasn't added the newest
  // columns yet (read-only: we never run it). Drop model attributes the physical
  // table lacks so default SELECTs don't reference missing columns.
  const qi = db.sequelize.getQueryInterface()
  for (const model of [db.MesSurgeTankBatch, db.MesBlendTankBatch, db.MesFgInputPairing]) {
    const cols = await qi.describeTable(model.getTableName())
    for (const k of Object.keys(model.rawAttributes)) {
      if (!cols[model.rawAttributes[k].field || k]) delete model.rawAttributes[k]
    }
    model.refreshAttributes()
  }
  const rows = await db.MesSurgeTankBatch.findAll({ where: { id: ids }, order: [['id', 'ASC']], raw: true })

  // Evaluate AS OF each batch's detectedAt: a blend batch counts as "active"
  // only if it was open then, and "completed" only if it had completed by then.
  // (status in the DB is today's status.) Rewrite the resolver's queries.
  const Op = db.Sequelize.Op
  const asOf = (where = {}) => {
    const now = new Date(clock.now())
    const w = { ...where }
    if (w.status === 'active') {
      delete w.status
      w.detectedAt = { [Op.lte]: now }
      // Still open today, or completed only after the surge batch started.
      // (pending_ns / error rows never ran a WO and are not "active".)
      w[Op.or] = [{ status: 'active' }, { status: 'completed', completedAt: { [Op.gt]: now } }]
    } else if (w.status === 'completed') {
      w.completedAt = { [Op.lte]: now }
    }
    return w
  }
  const origFindAll = db.MesBlendTankBatch.findAll.bind(db.MesBlendTankBatch)
  db.MesBlendTankBatch.findAll = (opts = {}) => origFindAll({ ...opts, where: asOf(opts.where) })
  db.MesBlendTankBatch.findOne = async (opts = {}) => (await origFindAll({ ...opts, where: asOf(opts.where), limit: 1 }))[0] || null
  for (const b of rows) {
    clock.initSim({ start: new Date(b.detectedAt), speedup: 1 })
    const fg = b.mesItem
    const canonical = itemConfig.FG_TO_RAW_FG_MAP[String(fg)] ?? null
    let verdict
    if (/^blendtank/i.test(String(b.feedingFromEntName || ''))) {
      const r = await surge._resolveLayer3Source({ feedingFromEntName: b.feedingFromEntName, feedingUhtId: b.feedingUhtId }, stubHistorian, fg ? Number(fg) : null)
      verdict = !r ? 'defer (nothing resolves)'
        : r.deferred ? `REJECT ${r.rejectedItemId} → unpinned, layerSkipReason=${r.layerSkipReason} (${r.reason})`
          : `PIN ${r.itemId} via ${r.resolvedFrom}`
    } else if (b.componentItemId) {
      const v = await surge.vetComponentForFg(fg, b.componentItemId)
      verdict = v.ok ? `PIN ${b.componentItemId} (${v.why})` : `REJECT ${b.componentItemId} → unpinned (${v.reason})`
    } else {
      verdict = 'n/a (no stored pin, not blend-fed)'
    }
    console.log(`#${b.id} ${b.tankId} "${b.productName}" FG ${fg} | src ${b.feedingFromEntName} | old pin ${b.componentItemId ?? '-'} (${b.componentResolvedFrom ?? '-'}) | canonical ${canonical ?? '-'} | NEW: ${verdict}`)
  }
  process.exit(0)
})().catch(err => { console.error('checkSurgePinCrossCheck failed:', err); process.exit(1) })
