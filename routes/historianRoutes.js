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
 * @openapi
 * /api/historian/search:
 *   get:
 *     tags: [Historian]
 *     summary: Search tags by name
 *     description: >
 *       Substring search over the Historian `Tags` entity — returns every tag whose
 *       fully-qualified name contains `q`. Follows OData `@odata.nextLink` pages until
 *       `limit` is reached. The install carries ~23,000 tags, so always pass a narrowing `q`.
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string }
 *         description: Substring to match against the tag FQN, e.g. `MSILO` or `Separator.`.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100, maximum: 10000 }
 *         description: Maximum tags to return (clamped to 10000).
 *     responses:
 *       200:
 *         description: Matching tags.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 query: { type: string }
 *                 count: { type: integer }
 *                 tags:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       fqn:         { type: string, example: MSILO1.GALLONS }
 *                       tagType:     { type: string, enum: [Analog, Discrete, String] }
 *                       description: { type: string }
 *                       engUnit:     { type: string }
 *       400: { description: Missing `q` query param. }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/tag/{fqn}:
 *   get:
 *     tags: [Historian]
 *     summary: Current value of one tag
 *     description: Reads the tag's latest archived value from the Historian `ProcessValues` entity.
 *     parameters:
 *       - in: path
 *         name: fqn
 *         required: true
 *         schema: { type: string }
 *         description: Fully-qualified tag name.
 *         example: ColdMilkSeparator1.CurrentWO
 *     responses:
 *       200:
 *         description: The current value.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 FQN:        { type: string }
 *                 DateTime:   { type: string, format: date-time }
 *                 Value:      { type: number, nullable: true }
 *                 Text:       { type: string, nullable: true }
 *                 OpcQuality: { type: integer, description: '192 = good.' }
 *       404: { description: No value available for that tag. }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/tags:
 *   get:
 *     tags: [Historian]
 *     summary: Current values for several tags
 *     description: >
 *       Reads the current value of each requested tag in parallel. Every result is also
 *       written into the in-memory poll store, so repeated calls build up a queryable
 *       series retrievable via `/api/historian/polled-history/{fqn}` — useful for tags the
 *       Historian archives too infrequently to trend.
 *     parameters:
 *       - in: query
 *         name: fqn
 *         required: true
 *         style: form
 *         explode: true
 *         schema:
 *           type: array
 *           items: { type: string }
 *         description: Repeat once per tag, e.g. `?fqn=MSILO1.GALLONS&fqn=MSILO2.GALLONS`.
 *     responses:
 *       200:
 *         description: One entry per requested tag (`value` is null when unavailable).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 tags:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       fqn:   { type: string }
 *                       value: { type: object, nullable: true }
 *       400: { description: No `fqn` query param supplied. }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/history/{fqn}:
 *   get:
 *     tags: [Historian]
 *     summary: Historical values for a tag
 *     description: >
 *       Trend data for one tag over a time window. For non-raw resolutions the route first
 *       tries `AnalogSummary` (native Historian aggregation); if that errors or returns no
 *       rows it falls back to raw `ProcessValues` and step-resamples them server-side,
 *       carrying each last-known value forward and marking the synthesised points
 *       `interpolated: true`. The `source` field in the response says which path was taken.
 *       Aggregation requires `since` — without it the request is always served raw.
 *       Results are capped at 100,000 rows.
 *     parameters:
 *       - in: path
 *         name: fqn
 *         required: true
 *         schema: { type: string }
 *         description: Fully-qualified tag name.
 *         example: MSILO1.GALLONS
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Window start (ISO 8601). Required for any non-raw resolution.
 *       - in: query
 *         name: until
 *         schema: { type: string, format: date-time }
 *         description: Window end (ISO 8601). Defaults to now.
 *       - in: query
 *         name: resolution
 *         schema:
 *           type: string
 *           enum: [raw, minutely, hourly, daily]
 *           default: raw
 *         description: Aggregation bucket size.
 *     responses:
 *       200:
 *         description: The series, plus a `_debug` block listing each OData page fetched.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fqn:        { type: string }
 *                 resolution: { type: string }
 *                 source:     { type: string, enum: [AnalogSummary, ProcessValues] }
 *                 count:      { type: integer }
 *                 values:
 *                   type: array
 *                   items:
 *                     type: object
 *                     description: >
 *                       AnalogSummary rows carry Average/Minimum/Maximum/Count and `_summary: true`;
 *                       resampled ProcessValues rows carry `interpolated: true`.
 *                 _debug:     { type: object }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/batches:
 *   get:
 *     tags: [Historian]
 *     summary: Separator batches from the historian
 *     description: >
 *       Runs the same separator-batch extraction the separation cron job uses, straight
 *       against the historian. Read-only — unlike the cron job this does not persist
 *       anything or post to NetSuite, so it is safe for ad-hoc inspection.
 *     parameters:
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Window start (ISO 8601). Defaults to 24 hours ago.
 *     responses:
 *       200:
 *         description: Batches detected in the window.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:   { type: integer }
 *                 since:   { type: string, format: date-time }
 *                 batches: { type: array, items: { type: object } }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/polled-history/{fqn}:
 *   get:
 *     tags: [Historian]
 *     summary: History captured by live polling
 *     description: >
 *       Returns values for a tag from the in-memory poll store rather than the Historian
 *       archive. The store is filled by calls to `/api/historian/tags`, which supplements
 *       tags the Historian archives too infrequently to trend usefully. The store is
 *       process-local and non-durable — it is empty after a restart and is cleared by
 *       the replay reset.
 *     parameters:
 *       - in: path
 *         name: fqn
 *         required: true
 *         schema: { type: string }
 *         description: Fully-qualified tag name.
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Window start (ISO 8601). Omit for everything held.
 *       - in: query
 *         name: until
 *         schema: { type: string, format: date-time }
 *         description: Window end (ISO 8601).
 *     responses:
 *       200:
 *         description: Polled values (empty if the tag was never polled).
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fqn:    { type: string }
 *                 source: { type: string, example: poll-store }
 *                 count:  { type: integer }
 *                 values: { type: array, items: { type: object } }
 *       500: { description: Poll store query failed. }
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
 * @openapi
 * /api/historian/poll-store/stats:
 *   get:
 *     tags: [Historian]
 *     summary: Poll store statistics
 *     description: Lists every tag currently held in the in-memory poll store and how many points each has.
 *     responses:
 *       200:
 *         description: Poll store contents.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fqns:   { type: array, items: { type: string } }
 *                 counts: { type: object, additionalProperties: { type: integer }, description: 'FQN → point count.' }
 */
router.get('/poll-store/stats', (req, res) => {
  res.json({ fqns: pollStore.listFqns(), counts: pollStore.stats() })
})

/**
 * @openapi
 * /api/historian/tag-detail/{fqn}:
 *   get:
 *     tags: [Historian]
 *     summary: Full metadata for one tag
 *     description: >
 *       Everything the Historian knows about a tag — the `Tags` row (TagType, EngUnit,
 *       min/max, interpolation type, source) plus its extended properties. The extended
 *       properties lookup is best-effort: `TagExtendedProperties` 404s on some Historian
 *       installs, in which case `extendedProps` comes back empty rather than failing.
 *     parameters:
 *       - in: path
 *         name: fqn
 *         required: true
 *         schema: { type: string }
 *         description: Fully-qualified tag name.
 *     responses:
 *       200:
 *         description: Tag metadata.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fqn:           { type: string }
 *                 tag:           { type: object }
 *                 extendedProps: { type: array, items: { type: object } }
 *       404: { description: Tag not found. }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/analog-summary/{fqn}:
 *   get:
 *     tags: [Historian]
 *     summary: Statistical summary for an analog tag
 *     description: >
 *       Raw `AnalogSummary` rows for an analog tag — First/Last, Minimum/Maximum with their
 *       timestamps, Average, StdDev, Integral, Count and PercentGood per interval. Unlike
 *       `/history/{fqn}` this returns the Historian's rows untouched, with no normalisation
 *       or ProcessValues fallback. Results are capped at 100,000 rows.
 *     parameters:
 *       - in: path
 *         name: fqn
 *         required: true
 *         schema: { type: string }
 *         description: Fully-qualified tag name of an analog tag.
 *         example: MSILO1.GALLONS
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Window start (ISO 8601). Defaults to 24 hours ago.
 *       - in: query
 *         name: until
 *         schema: { type: string, format: date-time }
 *         description: Window end (ISO 8601). Defaults to now.
 *       - in: query
 *         name: resolution
 *         schema: { type: integer, default: 3600000 }
 *         description: Interval size in MILLISECONDS (not a keyword). Default 3600000 = 1 hour.
 *     responses:
 *       200:
 *         description: Summary rows.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fqn:        { type: string }
 *                 since:      { type: string, format: date-time }
 *                 until:      { type: string, format: date-time }
 *                 resolution: { type: integer }
 *                 count:      { type: integer }
 *                 values:     { type: array, items: { type: object } }
 *                 _debug:     { type: object }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/state-summary/{fqn}:
 *   get:
 *     tags: [Historian]
 *     summary: Time-in-state summary for a discrete tag
 *     description: >
 *       Raw `StateSummary` rows — how long a discrete or string tag spent in each state per
 *       interval. This is the primitive behind the filler-hours report. Results are capped
 *       at 100,000 rows.
 *     parameters:
 *       - in: path
 *         name: fqn
 *         required: true
 *         schema: { type: string }
 *         description: Fully-qualified tag name of a discrete or string tag.
 *         example: Separator.ProcessActive
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Window start (ISO 8601). Defaults to 24 hours ago.
 *       - in: query
 *         name: until
 *         schema: { type: string, format: date-time }
 *         description: Window end (ISO 8601). Defaults to now.
 *       - in: query
 *         name: resolution
 *         schema: { type: integer, default: 3600000 }
 *         description: Interval size in MILLISECONDS. Default 3600000 = 1 hour.
 *     responses:
 *       200:
 *         description: State summary rows.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 fqn:        { type: string }
 *                 since:      { type: string, format: date-time }
 *                 until:      { type: string, format: date-time }
 *                 resolution: { type: integer }
 *                 count:      { type: integer }
 *                 values:     { type: array, items: { type: object } }
 *                 _debug:     { type: object }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/events:
 *   get:
 *     tags: [Historian]
 *     summary: Alarm and event history
 *     description: Queries the Historian `Events` entity, newest first, with optional type and source filters.
 *     parameters:
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *         description: Window start (ISO 8601, exclusive). Defaults to 24 hours ago.
 *       - in: query
 *         name: until
 *         schema: { type: string, format: date-time }
 *         description: Window end (ISO 8601, exclusive). Omit for no upper bound.
 *       - in: query
 *         name: type
 *         schema: { type: string }
 *         description: Exact event type match.
 *         example: Alarm.Set
 *       - in: query
 *         name: source
 *         schema: { type: string }
 *         description: Exact `Source_Name` match.
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 500, maximum: 10000 }
 *         description: Maximum events to return (clamped to 10000).
 *     responses:
 *       200:
 *         description: Events, ordered by EventTime descending.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 since:  { type: string, format: date-time }
 *                 count:  { type: integer }
 *                 events: { type: array, items: { type: object } }
 *                 _debug: { type: object }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/tag-groups:
 *   get:
 *     tags: [Historian]
 *     summary: List tag groups
 *     description: Returns the Historian's hierarchical tag grouping (data sources) — useful for discovering what equipment exists.
 *     responses:
 *       200:
 *         description: Tag groups.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:  { type: integer }
 *                 groups: { type: array, items: { type: object } }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/tag-properties:
 *   get:
 *     tags: [Historian]
 *     summary: List tag property names
 *     description: Every tag property name defined on this Historian install.
 *     responses:
 *       200:
 *         description: Property names.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:      { type: integer }
 *                 properties: { type: array, items: { type: object } }
 *       500: { description: Historian query failed. }
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
 * @openapi
 * /api/historian/system-params:
 *   get:
 *     tags: [Historian]
 *     summary: List Historian system parameters
 *     description: Historian system configuration parameters. On-premises installs only — cloud Historian does not expose this entity.
 *     responses:
 *       200:
 *         description: System parameters.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 count:  { type: integer }
 *                 params: { type: array, items: { type: object } }
 *       500: { description: Historian query failed, or the entity is unavailable on this install. }
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
