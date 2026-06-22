const fgPairingService = require('../services/fgPairingService')

/**
 * GET /api/mes/fg-pairings?status=approved|pending
 */
exports.list = async (req, res) => {
  try {
    const { status } = req.query
    if (status && !['approved', 'pending', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, error: `Invalid status: ${status}` })
    }
    const pairings = await fgPairingService.listPairings({ status })
    return res.status(200).json({ success: true, pairings })
  } catch (error) {
    console.error('[FgPairingController] list error:', error)
    return res.status(500).json({ success: false, error: error.message || 'Failed to list pairings' })
  }
}

/**
 * POST /api/mes/fg-pairings/:id/approve
 * Body: { decidedBy?, notes? }
 */
exports.approve = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'Invalid pairing id' })
    }
    const { decidedBy, notes } = req.body || {}
    const row = await fgPairingService.approvePairing(id, { decidedBy, notes })
    return res.status(200).json({ success: true, pairing: row })
  } catch (error) {
    console.error('[FgPairingController] approve error:', error)
    const status = /not found/i.test(error.message) ? 404 : 500
    return res.status(status).json({ success: false, error: error.message || 'Failed to approve pairing' })
  }
}

/**
 * POST /api/mes/fg-pairings/:id/reject
 * Body: { decidedBy?, reason? }
 * Marks the (FG ⇐ raw) combo bad — future surge batches with it are held.
 */
exports.reject = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'Invalid pairing id' })
    }
    const { decidedBy, reason } = req.body || {}
    const row = await fgPairingService.rejectPairing(id, { decidedBy, reason })
    return res.status(200).json({ success: true, pairing: row })
  } catch (error) {
    console.error('[FgPairingController] reject error:', error)
    const status = /not found/i.test(error.message) ? 404 : 500
    return res.status(status).json({ success: false, error: error.message || 'Failed to reject pairing' })
  }
}

/**
 * POST /api/mes/fg-pairings/:id/fix
 * Body: { rawInputItemId, rawInputName?, decidedBy?, notes? }
 * Rejects the wrong combo and approves the corrected (FG ⇐ correctRaw) combo.
 */
exports.fix = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) {
      return res.status(400).json({ success: false, error: 'Invalid pairing id' })
    }
    const { rawInputItemId, rawInputName, decidedBy, notes } = req.body || {}
    const result = await fgPairingService.fixPairing(id, { rawInputItemId, rawInputName, decidedBy, notes })
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    console.error('[FgPairingController] fix error:', error)
    const status = /not found/i.test(error.message) ? 404 : 400
    return res.status(status).json({ success: false, error: error.message || 'Failed to fix pairing' })
  }
}
