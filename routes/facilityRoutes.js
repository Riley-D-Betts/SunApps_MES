const express = require('express')
const router = express.Router()
const facilityState = require('../services/facilityStateService')
const settings = require('../services/facilitySettingsService')
const statusStore = require('../services/statusStore')
const { DEFAULT_ASSIGNMENTS, mergeAssignments } = require('../services/facilityJoins')
const clock = require('../sim/clock')

const SVG_ID = /^[a-z][a-z0-9_-]{0,63}$/i
const OVERRIDE_MAX_MINUTES = 7 * 24 * 60

/**
 * @openapi
 * /api/mes/facility/state:
 *   get:
 *     summary: Full facility-map state for hydration
 *     description: >
 *       Every map entity (keyed by SVG id) with its current status, level, metrics and
 *       work-order group, plus the version the socket change-sets continue from. Browsers call
 *       this once, join socket room `facility-map`, and then apply `facility:updated` change-sets.
 *     responses:
 *       200:
 *         description: "Full state: { entities, updatedAt, version, stale, assignments }"
 */
router.get('/state', async (req, res) => {
  try {
    res.json(await facilityState.getState())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * @openapi
 * /api/mes/facility/health:
 *   get:
 *     summary: Facility-state service health (version, last refresh, broadcast errors)
 */
router.get('/health', (req, res) => res.json(facilityState.health()))

/**
 * @openapi
 * /api/mes/facility/refresh:
 *   post:
 *     summary: Recompute now and return the full state (read-your-write for admin edits)
 */
router.post('/refresh', async (req, res) => {
  try {
    await facilityState.requestRefresh(req.body?.reason || 'client')
    res.json(await facilityState.getState())
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * @openapi
 * /api/mes/facility/assignments:
 *   get:
 *     summary: Admin assignments (SVG id → historian id) with defaults and the ids currently seen
 *   put:
 *     summary: Save assignments; unknown ids are ignored, missing ones keep their defaults
 */
router.get('/assignments', (req, res) => {
  const snap = statusStore.snapshot()
  res.json({
    assignments: mergeAssignments(settings.get('assignments', {})),
    overrides: settings.get('assignments', {}),
    defaults: DEFAULT_ASSIGNMENTS,
    seen: {
      surge: (snap.surgeTanks?.tanks || []).map((t) => t.tankId),
      blend: (snap.blendTanks?.tanks || []).map((t) => t.tankId),
    },
  })
})

router.put('/assignments', async (req, res) => {
  try {
    const body = req.body || {}
    const overrides = {}
    for (const group of Object.keys(DEFAULT_ASSIGNMENTS)) {
      if (!body[group] || typeof body[group] !== 'object') continue
      overrides[group] = {}
      for (const [svgId, hid] of Object.entries(body[group])) {
        if (!(svgId in DEFAULT_ASSIGNMENTS[group])) continue
        if (typeof hid === 'string' && hid.trim()) overrides[group][svgId] = hid.trim()
      }
    }
    await settings.set('assignments', overrides)
    res.json({ ok: true, assignments: mergeAssignments(overrides), overrides })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/**
 * @openapi
 * /api/mes/facility/overrides:
 *   get:
 *     summary: Active manual overrides (SVG id → status, note, who, until)
 * /api/mes/facility/overrides/{id}:
 *   put:
 *     summary: Set a manual override on a map element
 *     description: >
 *       Pins the element's status regardless of what the historian or scheduler derive, until
 *       the override expires or is cleared. An override on line<n> paints the line and all its
 *       drawn members. Body: { status, note?, by?, minutes? } — minutes omitted or 0 means until
 *       cleared (capped at 7 days). Every map client sees it on the next tick.
 *   delete:
 *     summary: Clear a manual override
 */
router.get('/overrides', (req, res) => res.json({ overrides: facilityState.activeOverrides(clock.now()) }))

router.put('/overrides/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '')
    if (!SVG_ID.test(id)) return res.status(400).json({ error: 'bad id' })
    const { status, note, by, minutes } = req.body || {}
    if (!facilityState.OVERRIDE_STATUSES.has(status)) return res.status(400).json({ error: `status must be one of ${[...facilityState.OVERRIDE_STATUSES].join(', ')}` })
    const mins = Math.min(OVERRIDE_MAX_MINUTES, Math.max(0, Number(minutes) || 0))
    const nowMs = clock.now()
    const overrides = { ...facilityState.activeOverrides(nowMs) }
    overrides[id] = {
      status,
      note: typeof note === 'string' ? note.trim().slice(0, 200) : '',
      by: typeof by === 'string' ? by.trim().slice(0, 80) : '',
      setAt: new Date(nowMs).toISOString(),
      until: mins ? new Date(nowMs + mins * 60_000).toISOString() : null,
    }
    await settings.set('overrides', overrides)   // listeners re-derive + broadcast before this resolves
    res.json({ ok: true, overrides })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/overrides/:id', async (req, res) => {
  try {
    const id = String(req.params.id || '')
    const overrides = { ...facilityState.activeOverrides(clock.now()) }
    const existed = id in overrides
    delete overrides[id]
    if (existed) await settings.set('overrides', overrides)
    res.json({ ok: true, cleared: existed, overrides })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
