const bomAdminService = require('../services/bomAdminService')

/**
 * GET /api/mes/bom-admin/groups
 * Selectable item groups (surge FGs / batch goods / raw items) + twin map.
 */
exports.groups = async (req, res) => {
  try {
    const groups = await bomAdminService.getGroups()
    return res.status(200).json({ success: true, ...groups })
  } catch (error) {
    console.error('[BomAdminController] groups error:', error)
    return res.status(500).json({ success: false, error: error.message || 'Failed to load groups' })
  }
}

/**
 * GET /api/mes/bom-admin/search?q=...
 * Free-text assembly-item search (fallback when not picking a group).
 */
exports.search = async (req, res) => {
  try {
    const items = await bomAdminService.searchItems(req.query.q)
    return res.status(200).json({ success: true, items })
  } catch (error) {
    console.error('[BomAdminController] search error:', error)
    return res.status(500).json({ success: false, error: error.message || 'Failed to search items' })
  }
}

/**
 * GET /api/mes/bom-admin/item/:id
 * Current/default BOM revision components for an assembly item.
 */
exports.getItem = async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10)
    if (!Number.isFinite(id)) return res.status(400).json({ success: false, error: 'Invalid item id' })
    const bom = await bomAdminService.getItemBom(id)
    return res.status(200).json({ success: true, ...bom })
  } catch (error) {
    console.error('[BomAdminController] getItem error:', error)
    // Missing / non-assembly items are user errors, not server faults.
    const status = /not found|not an assembly|no editable BOM/i.test(error.message) ? 400 : 500
    return res.status(status).json({ success: false, error: error.message || 'Failed to load item BOM' })
  }
}

/**
 * POST /api/mes/bom-admin/preview   Body: { itemId, components: [...] }
 */
exports.preview = async (req, res) => {
  try {
    const { itemId, components } = req.body || {}
    if (!itemId) return res.status(400).json({ success: false, error: 'itemId required' })
    const result = await bomAdminService.previewBom(itemId, components)
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    console.error('[BomAdminController] preview error:', error)
    return res.status(400).json({ success: false, error: error.message || 'Failed to preview BOM' })
  }
}

/**
 * POST /api/mes/bom-admin/commit    Body: { itemId, components: [...] }
 * Overwrites the item's current BOM revision components.
 */
exports.commit = async (req, res) => {
  try {
    const { itemId, components } = req.body || {}
    if (!itemId) return res.status(400).json({ success: false, error: 'itemId required' })
    const result = await bomAdminService.commitBom(itemId, components)
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    console.error('[BomAdminController] commit error:', error)
    return res.status(400).json({ success: false, error: error.message || 'Failed to commit BOM' })
  }
}

/**
 * POST /api/mes/bom-admin/bulk/surge-twins   Body: { commit?: boolean }
 * Dry-run by default; set every surge FG BOM to 1 lb of its batch twin.
 */
exports.bulkSurgeTwins = async (req, res) => {
  try {
    const commit = !!(req.body && req.body.commit)
    const result = await bomAdminService.bulkSurgeTwins({ commit })
    return res.status(200).json({ success: true, ...result })
  } catch (error) {
    console.error('[BomAdminController] bulkSurgeTwins error:', error)
    return res.status(500).json({ success: false, error: error.message || 'Failed to run bulk surge-twins' })
  }
}
