const db = require('../models')
const clock = require('../sim/clock')

async function listPairings({ status } = {}) {
  const where = {}
  if (status) where.status = status
  return db.MesFgInputPairing.findAll({
    where,
    order: [['status', 'ASC'], ['createdAt', 'DESC']],
  })
}

async function getPairing(id) {
  return db.MesFgInputPairing.findByPk(id)
}

async function approvePairing(id, { decidedBy, notes } = {}) {
  const row = await db.MesFgInputPairing.findByPk(id)
  if (!row) throw new Error(`Pairing ${id} not found`)
  if (row.status === 'approved') return row  // idempotent
  await row.update({
    status: 'approved',
    decidedBy: decidedBy || null,
    decidedAt: new Date(clock.now()),
    notes: notes != null ? notes : row.notes,
  })
  console.log(`[FgPairingService] Pairing ${id} (FG ${row.fgItemId} ← raw ${row.rawInputItemId}) approved by ${decidedBy || 'unknown'}`)
  return row
}

module.exports = {
  listPairings,
  getPairing,
  approvePairing,
}
