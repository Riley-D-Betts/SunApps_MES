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

/**
 * Mark a pairing bad. status='rejected' makes the surge resolver HOLD future
 * batches that resolve to this (FG ⇐ raw) combo (resolveLayer3Component →
 * pairingStatus='blocked') instead of auto-posting a WO. Idempotent.
 */
async function rejectPairing(id, { decidedBy, reason } = {}) {
  const row = await db.MesFgInputPairing.findByPk(id)
  if (!row) throw new Error(`Pairing ${id} not found`)
  if (row.status === 'rejected') return row  // idempotent
  await row.update({
    status: 'rejected',
    decidedBy: decidedBy || null,
    decidedAt: new Date(clock.now()),
    notes: reason != null ? reason : row.notes,
  })
  console.log(`[FgPairingService] Pairing ${id} (FG ${row.fgItemId} ← raw ${row.rawInputItemId}) REJECTED by ${decidedBy || 'unknown'} — future batches with this combo will be held`)
  return row
}

/**
 * Fix a pairing: the auto-detected raw input was wrong. Reject the current row
 * and approve the corrected (FG ⇐ correctRaw) combo in one step. If a row for
 * the corrected combo already exists (unique key fgItemId+rawInputItemId), we
 * approve that one; otherwise we create it approved.
 *
 * Returns { approved, rejected } so the caller can refresh both rows. When the
 * supplied raw input matches the current one, this degrades to a plain approve.
 */
async function fixPairing(id, { rawInputItemId, rawInputName, decidedBy, notes } = {}) {
  const row = await db.MesFgInputPairing.findByPk(id)
  if (!row) throw new Error(`Pairing ${id} not found`)
  const newRaw = Number(rawInputItemId)
  if (!Number.isFinite(newRaw) || newRaw <= 0) {
    throw new Error('A valid rawInputItemId is required to fix a pairing')
  }

  const decidedAt = new Date(clock.now())

  // No real change — just approve the existing combo.
  if (newRaw === Number(row.rawInputItemId)) {
    const approved = await approvePairing(id, { decidedBy, notes })
    return { approved, rejected: null }
  }

  // Reject the wrong combo, recording where it was redirected.
  await row.update({
    status: 'rejected',
    decidedBy: decidedBy || null,
    decidedAt,
    notes: `Corrected to raw ${newRaw}${notes ? ` — ${notes}` : ''}`,
  })

  // Approve (or create-approved) the corrected combo.
  let approved = await db.MesFgInputPairing.findOne({
    where: { fgItemId: row.fgItemId, rawInputItemId: newRaw },
  })
  if (approved) {
    await approved.update({
      status: 'approved',
      decidedBy: decidedBy || null,
      decidedAt,
      rawInputName: rawInputName != null ? rawInputName : approved.rawInputName,
      notes: notes != null ? notes : approved.notes,
    })
  } else {
    approved = await db.MesFgInputPairing.create({
      fgItemId: row.fgItemId,
      rawInputItemId: newRaw,
      fgName: row.fgName,
      rawInputName: rawInputName || null,
      status: 'approved',
      createdBy: decidedBy || 'fix',
      decidedBy: decidedBy || null,
      decidedAt,
      notes: notes || null,
    })
  }
  console.log(`[FgPairingService] Pairing ${id} fixed: FG ${row.fgItemId} ← raw ${row.rawInputItemId} REJECTED, FG ${row.fgItemId} ← raw ${newRaw} APPROVED (by ${decidedBy || 'unknown'})`)
  return { approved, rejected: row }
}

module.exports = {
  listPairings,
  getPairing,
  approvePairing,
  rejectPairing,
  fixPairing,
}
