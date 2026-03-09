const express = require('express')
const router = express.Router()

/**
 * Historian query API — lets SunApps_API (or any client) pull data
 * from the AVEVA Historian via MES_Service as a gateway.
 *
 * All routes receive the historian provider instance via app.locals.historian
 */

/**
 * GET /api/historian/search?q=keyword&limit=100
 * Search for tags whose FQN contains the query string.
 * Queries the Historian Tags entity directly.
 */
router.get('/search', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const q = req.query.q
    const limit = parseInt(req.query.limit) || 100
    if (!q) return res.status(400).json({ error: 'Provide a q query param' })

    const filter = `contains(FQN, '${q}')`
    const url = `${historian.baseUrl}/Tags?$filter=${encodeURIComponent(filter)}&$top=${limit}&$orderby=FQN`
    const data = await historian._get(url)
    const tags = (data.value || []).map(t => ({
      fqn: t.FQN,
      tagType: t.TagType,
      description: t.Description,
      engUnit: t.EngUnit,
    }))
    res.json({ query: q, count: tags.length, tags })
  } catch (err) {
    console.error(`[HistorianRoutes] Tag search error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/tag/:fqn
 * Get the current value of a single tag.
 * Example: /api/historian/tag/ColdMilkSeparator1.CurrentWO
 */
router.get('/tag/:fqn', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const fqn = req.params.fqn
    const value = await historian._getCurrentValue(fqn)
    if (!value) return res.status(404).json({ error: `No value for tag: ${fqn}` })
    res.json(value)
  } catch (err) {
    console.error(`[HistorianRoutes] Tag read error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/tags?fqn=Tag1&fqn=Tag2
 * Get current values for multiple tags at once.
 */
router.get('/tags', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    let fqns = req.query.fqn
    if (!fqns) return res.status(400).json({ error: 'Provide one or more fqn query params' })
    if (!Array.isArray(fqns)) fqns = [fqns]

    const results = await Promise.all(
      fqns.map(async (fqn) => {
        const value = await historian._getCurrentValue(fqn)
        return { fqn, value }
      })
    )
    res.json({ tags: results })
  } catch (err) {
    console.error(`[HistorianRoutes] Multi-tag read error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/history/:fqn?since=ISO&until=ISO
 * Get historical values for a tag within a time range.
 */
router.get('/history/:fqn', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const fqn = req.params.fqn
    const since = req.query.since ? new Date(req.query.since) : undefined
    const until = req.query.until ? new Date(req.query.until) : undefined

    const values = await historian._queryProcessValues(fqn, since, until)
    res.json({ fqn, count: values.length, values })
  } catch (err) {
    console.error(`[HistorianRoutes] History read error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/batches?since=ISO
 * Get separator batches since a timestamp (same as the poller uses).
 * Defaults to last 24 hours.
 */
router.get('/batches', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const since = req.query.since
      ? new Date(req.query.since)
      : new Date(Date.now() - 24 * 60 * 60 * 1000)

    const batches = await historian.getSeparatorBatches(since)
    res.json({ count: batches.length, since: since.toISOString(), batches })
  } catch (err) {
    console.error(`[HistorianRoutes] Batches read error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
