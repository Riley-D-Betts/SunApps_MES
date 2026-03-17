const express = require('express')
const router = express.Router()
const pollStore = require('../services/pollStore')

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
    const limit = Math.min(parseInt(req.query.limit) || 100, 10000)
    if (!q) return res.status(400).json({ error: 'Provide a q query param' })

    const filter = `contains(FQN, '${q}')`
    let url = `${historian.baseUrl}/Tags?$filter=${encodeURIComponent(filter)}&$top=${limit}&$orderby=FQN`

    const allTags = []
    while (url && allTags.length < limit) {
      const data = await historian._get(url)
      const page = (data.value || []).map(t => ({
        fqn: t.FQN,
        tagType: t.TagType,
        description: t.Description,
        engUnit: t.EngUnit,
      }))
      allTags.push(...page)
      url = allTags.length < limit ? (data['@odata.nextLink'] || null) : null
    }

    res.json({ query: q, count: allTags.length, tags: allTags })
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

    // Record into poll store so callers can query this data as history later
    pollStore.record(results)

    res.json({ tags: results })
  } catch (err) {
    console.error(`[HistorianRoutes] Multi-tag read error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/history/:fqn?since=ISO&until=ISO&resolution=raw|minutely|hourly|daily
 * Get historical values for a tag within a time range.
 *
 * For non-raw resolutions, tries AnalogSummary first (native Historian aggregation).
 * Falls back to ProcessValues + server-side step resampling if AnalogSummary fails.
 */
router.get('/history/:fqn', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const fqn = req.params.fqn
    const since = req.query.since ? new Date(req.query.since) : undefined
    const until = req.query.until ? new Date(req.query.until) : undefined
    const resolution = req.query.resolution || 'raw' // raw | minutely | hourly | daily

    const INTERVAL_MS = { minutely: 60_000, hourly: 3_600_000, daily: 86_400_000 }
    const _debug = { resolution, pages: [] }

    // ── Non-raw: try AnalogSummary first ─────────────────────────────────────
    if (resolution in INTERVAL_MS && since) {
      const intervalMs = INTERVAL_MS[resolution]
      const endTime = until || new Date()
      const summaryFilter = `FQN eq '${fqn}' and StartDateTime ge ${since.toISOString()} and EndDateTime le ${endTime.toISOString()}`
      const summaryUrl = `${historian.baseUrl}/AnalogSummary?$filter=${encodeURIComponent(summaryFilter)}&Resolution=${intervalMs}`

      _debug.entity = 'AnalogSummary'
      _debug.summaryUrl = summaryUrl

      try {
        const allSummary = []
        let url = summaryUrl
        while (url && allSummary.length < 100000) {
          const data = await historian._get(url)
          const page = data.value || []
          _debug.pages.push({ url, recordsReturned: page.length, nextLink: data['@odata.nextLink'] || null })
          allSummary.push(...page)
          url = data['@odata.nextLink'] || null
        }

        if (allSummary.length > 0) {
          // Normalize AnalogSummary rows to the same shape as ProcessValues rows
          const values = allSummary.map(r => ({
            DateTime: r.StartDateTime,
            EndDateTime: r.EndDateTime,
            Value: r.Average ?? r.Last ?? null,
            Average: r.Average,
            Minimum: r.Minimum,
            Maximum: r.Maximum,
            Count: r.Count,
            OpcQuality: r.OPCQuality,
            FQN: fqn,
            _summary: true,
          }))
          _debug.summaryCount = values.length
          return res.json({ fqn, resolution, source: 'AnalogSummary', count: values.length, values, _debug })
        }

        _debug.summaryEmpty = true
        console.log(`[HistorianRoutes] AnalogSummary returned 0 rows for ${fqn}, falling back to ProcessValues`)
      } catch (summaryErr) {
        _debug.summaryError = summaryErr.message
        console.warn(`[HistorianRoutes] AnalogSummary failed for ${fqn}: ${summaryErr.message} — falling back to ProcessValues`)
      }
    }

    // ── Raw or AnalogSummary fallback: fetch ProcessValues ───────────────────
    _debug.entity = 'ProcessValues'
    let filter = `FQN eq '${fqn}'`
    if (since) filter += ` and DateTime ge ${since.toISOString()}`
    if (until) filter += ` and DateTime le ${until.toISOString()}`
    let url = `${historian.baseUrl}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime`

    const allRaw = []
    while (url && allRaw.length < 100000) {
      const data = await historian._get(url)
      const page = data.value || []
      _debug.pages.push({ url, recordsReturned: page.length, nextLink: data['@odata.nextLink'] || null })
      allRaw.push(...page)
      url = data['@odata.nextLink'] || null
    }

    // Step-function resample for non-raw resolutions
    let values = allRaw
    if (resolution in INTERVAL_MS && allRaw.length > 0 && since) {
      const intervalMs = INTERVAL_MS[resolution]
      const end = until || new Date()
      const resampled = []
      let t = new Date(since)
      let rawIdx = 0
      let lastKnown = null

      while (t <= end) {
        while (rawIdx < allRaw.length && new Date(allRaw[rawIdx].DateTime) <= t) {
          lastKnown = allRaw[rawIdx]
          rawIdx++
        }
        if (lastKnown !== null) {
          resampled.push({
            DateTime: t.toISOString(),
            Value: lastKnown.Value,
            Text: lastKnown.Text,
            FQN: lastKnown.FQN,
            OpcQuality: lastKnown.OpcQuality,
            interpolated: true,
          })
        }
        t = new Date(t.getTime() + intervalMs)
      }
      values = resampled
      _debug.rawCount = allRaw.length
      _debug.resampledCount = resampled.length
    }

    res.json({ fqn, resolution, source: 'ProcessValues', count: values.length, values, _debug })
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

/**
 * GET /api/historian/polled-history/:fqn?since=ISO&until=ISO
 * Return tag values that were captured by live polling (via /tags endpoint).
 * This is a supplement to the Historian archive for tags with low archive frequency.
 */
router.get('/polled-history/:fqn', (req, res) => {
  try {
    const fqn = req.params.fqn
    const since = req.query.since ? new Date(req.query.since) : undefined
    const until = req.query.until ? new Date(req.query.until) : undefined

    const values = pollStore.query(fqn, since, until)
    res.json({ fqn, source: 'poll-store', count: values.length, values })
  } catch (err) {
    console.error(`[HistorianRoutes] Poll store query error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/poll-store/stats
 * Return current poll store statistics (FQN → point count).
 */
router.get('/poll-store/stats', (req, res) => {
  res.json({ fqns: pollStore.listFqns(), counts: pollStore.stats() })
})

/**
 * GET /api/historian/tag-detail/:fqn
 * Full tag metadata from /Tags + extended properties.
 * IntegralDivisor, TagType, EngUnit, AcquisitionType, etc.
 */
router.get('/tag-detail/:fqn', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const fqn = req.params.fqn

    // Fetch tag metadata from /Tags
    const tagsUrl = `${historian.baseUrl}/Tags?$filter=${encodeURIComponent(`FQN eq '${fqn}'`)}`
    const tagsData = await historian._get(tagsUrl)
    const tag = (tagsData.value || [])[0] || null

    // Fetch extended properties (v1 standalone endpoint — may 404 on some installs)
    let extendedProps = []
    try {
      const extUrl = `${historian.baseUrl}/TagExtendedProperties?$filter=${encodeURIComponent(`FQN eq '${fqn}'`)}`
      const extData = await historian._get(extUrl)
      extendedProps = extData.value || []
    } catch (extErr) {
      console.warn(`[HistorianRoutes] TagExtendedProperties not available: ${extErr.message}`)
    }

    if (!tag) return res.status(404).json({ error: `Tag not found: ${fqn}` })
    res.json({ fqn, tag, extendedProps })
  } catch (err) {
    console.error(`[HistorianRoutes] Tag detail error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/analog-summary/:fqn?since=ISO&until=ISO&resolution=ms
 * Full AnalogSummary — returns Average, Min, Max, StdDev, Integral, Count per interval.
 */
router.get('/analog-summary/:fqn', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const fqn = req.params.fqn
    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const until = req.query.until ? new Date(req.query.until) : new Date()
    const resolution = parseInt(req.query.resolution) || 3_600_000 // default 1 hour

    const filter = `FQN eq '${fqn}' and StartDateTime ge ${since.toISOString()} and EndDateTime le ${until.toISOString()}`
    let url = `${historian.baseUrl}/AnalogSummary?$filter=${encodeURIComponent(filter)}&Resolution=${resolution}`

    const all = []
    const pages = []
    while (url && all.length < 100000) {
      const data = await historian._get(url)
      const page = data.value || []
      pages.push({ url, recordsReturned: page.length, nextLink: data['@odata.nextLink'] || null })
      all.push(...page)
      url = data['@odata.nextLink'] || null
    }

    res.json({ fqn, since: since.toISOString(), until: until.toISOString(), resolution, count: all.length, values: all, _debug: { pages } })
  } catch (err) {
    console.error(`[HistorianRoutes] AnalogSummary error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/state-summary/:fqn?since=ISO&until=ISO&resolution=ms
 * StateSummary — time-in-state statistics for discrete/string tags.
 */
router.get('/state-summary/:fqn', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const fqn = req.params.fqn
    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const until = req.query.until ? new Date(req.query.until) : new Date()
    const resolution = parseInt(req.query.resolution) || 3_600_000

    const filter = `FQN eq '${fqn}' and StartDateTime ge ${since.toISOString()} and EndDateTime le ${until.toISOString()}`
    let url = `${historian.baseUrl}/StateSummary?$filter=${encodeURIComponent(filter)}&Resolution=${resolution}`

    const all = []
    const pages = []
    while (url && all.length < 100000) {
      const data = await historian._get(url)
      const page = data.value || []
      pages.push({ url, recordsReturned: page.length, nextLink: data['@odata.nextLink'] || null })
      all.push(...page)
      url = data['@odata.nextLink'] || null
    }

    res.json({ fqn, since: since.toISOString(), until: until.toISOString(), resolution, count: all.length, values: all, _debug: { pages } })
  } catch (err) {
    console.error(`[HistorianRoutes] StateSummary error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/events?since=ISO&until=ISO&type=&source=&limit=500
 * Query alarm/event history.
 */
router.get('/events', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const since = req.query.since ? new Date(req.query.since) : new Date(Date.now() - 24 * 60 * 60 * 1000)
    const until = req.query.until ? new Date(req.query.until) : null
    const type = req.query.type || null      // e.g. 'Alarm.Set', 'Alarm.Clear'
    const source = req.query.source || null  // Source_Name filter
    const limit = Math.min(parseInt(req.query.limit) || 500, 10000)

    // Events uses single-quoted DateTime in v2
    const clauses = [`EventTime gt '${since.toISOString()}'`]
    if (until) clauses.push(`EventTime lt '${until.toISOString()}'`)
    if (type) clauses.push(`Type eq '${type}'`)
    if (source) clauses.push(`Source_Name eq '${source}'`)
    const filter = clauses.join(' and ')

    let url = `${historian.baseUrl}/Events?$filter=${encodeURIComponent(filter)}&$top=${limit}&$orderby=EventTime desc`

    const all = []
    const pages = []
    while (url && all.length < limit) {
      const data = await historian._get(url)
      const page = data.value || []
      pages.push({ url, recordsReturned: page.length, nextLink: data['@odata.nextLink'] || null })
      all.push(...page)
      url = all.length < limit ? (data['@odata.nextLink'] || null) : null
    }

    res.json({ since: since.toISOString(), count: all.length, events: all, _debug: { pages } })
  } catch (err) {
    console.error(`[HistorianRoutes] Events error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/tag-groups
 * List all data sources (TagGroups).
 */
router.get('/tag-groups', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const data = await historian._get(`${historian.baseUrl}/TagGroups`)
    res.json({ count: (data.value || []).length, groups: data.value || [] })
  } catch (err) {
    console.error(`[HistorianRoutes] TagGroups error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/tag-properties
 * List all tag property names defined on this Historian install.
 */
router.get('/tag-properties', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const data = await historian._get(`${historian.baseUrl}/TagProperties`)
    res.json({ count: (data.value || []).length, properties: data.value || [] })
  } catch (err) {
    console.error(`[HistorianRoutes] TagProperties error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

/**
 * GET /api/historian/system-params
 * List Historian system parameters (on-premises only).
 */
router.get('/system-params', async (req, res) => {
  try {
    const historian = req.app.locals.historian
    const data = await historian._get(`${historian.baseUrl}/SystemParameters`)
    res.json({ count: (data.value || []).length, params: data.value || [] })
  } catch (err) {
    console.error(`[HistorianRoutes] SystemParameters error:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
