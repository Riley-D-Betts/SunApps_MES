const statusStore = require('../services/statusStore')
const clock = require('../sim/clock')

/**
 * Packaging poll — reads the live packaging-line tags (services/packagingTags.js)
 * and turns them into per-line evidence for the facility map: which counters
 * moved and when, cases per minute, pallets today, filler flow, Filler 1's lane
 * cartons and modes, sterile flags.
 *
 * Movement is tracked HERE, not in the provider: a counter that changed value
 * within the window is "moving"; the first sighting of a value never counts.
 * Rates come from a six-minute sample ring (needs two samples ≥ 60 s apart; a
 * negative delta is a counter reset and reads as no rate).
 *
 * Lines 5 and 6 share Pall5 and the CsPckr5 counters. Their movement goes to
 * whichever filler has product flowing; when neither flow tag reads, both get it.
 *
 * The utilization state and reason codes are passed through raw — the site's
 * util_state / util_reas tables are not in the historian (see the tag audit).
 */
const COUNTER_MOVE_MS = 5 * 60_000
const FILLER1_MOVE_MS = 3 * 60_000
const LINE_MOVE_MS = 10 * 60_000
const RATE_WINDOW_MS = 6 * 60_000
const RATE_MIN_SPAN_MS = 60_000
const FLOW_MIN = 5 // in the tag's own unit; both l/h and l/min read well above this while filling

const last = new Map()   // key → { value, at }   (at = when the value last CHANGED)
const rings = new Map()  // key → [{ t, v }]

function track(key, value, nowMs) {
  if (value == null || !Number.isFinite(value)) return
  const prev = last.get(key)
  if (!prev) last.set(key, { value, at: null })
  else if (value !== prev.value) last.set(key, { value, at: nowMs })
  const ring = rings.get(key) || []
  ring.push({ t: nowMs, v: value })
  while (ring.length && nowMs - ring[0].t > RATE_WINDOW_MS) ring.shift()
  rings.set(key, ring)
}
const movedAt = (key) => last.get(key)?.at ?? null
const movedWithin = (key, ms, nowMs) => { const at = movedAt(key); return at != null && nowMs - at <= ms }
function ratePerMin(key) {
  const ring = rings.get(key)
  if (!ring || ring.length < 2) return null
  const a = ring[0], b = ring[ring.length - 1]
  if (b.t - a.t < RATE_MIN_SPAN_MS) return null
  const d = b.v - a.v
  if (d < 0) return null
  return Math.round((d / ((b.t - a.t) / 60_000)) * 10) / 10
}
const latest = (a, b) => (a == null ? b : b == null ? a : Math.max(a, b))

function derive(raw, nowMs) {
  const lines = {}
  const flowOf = (d) => raw.fillerFlow?.[d]?.rate ?? null
  const flowing = (d) => { const r = flowOf(d); return r != null && r >= FLOW_MIN }

  // machines by their own key (5 = shared 5/6)
  const pallOf = (d) => {
    const p = raw.palletizers?.[d]; if (!p) return null
    const kC = `pall${d}.cases`, kP = `pall${d}.pallets`
    track(kC, p.lifetimeCases, nowMs); track(kP, p.palletsToday, nowMs)
    const at = latest(movedAt(kC), movedAt(kP))
    return { ...p, casesPerMin: ratePerMin(kC), movedAt: at, moving: at != null && nowMs - at <= COUNTER_MOVE_MS }
  }
  const csOf = (d) => {
    const c = raw.casePackers?.[d]; if (!c) return null
    const k = `cs${d}.cases`
    track(k, c.lifetimeCases, nowMs)
    const at = movedAt(k)
    return { ...c, casesPerMin: ratePerMin(k), movedAt: at, moving: at != null && nowMs - at <= COUNTER_MOVE_MS }
  }
  track('cases56', raw.casesToday56, nowMs)

  for (const d of ['1', '2', '3', '4', '5', '6']) {
    const shared = d === '5' || d === '6'
    const mk = shared ? '5' : d
    const pall = pallOf(mk), cs = csOf(mk)
    // shared 5/6: attribute to the filler with flow; when neither filler shows flow the
    // movement is real but the owner is unknown — both lines get it, flagged ambiguous,
    // and the adapter lets the scheduler break the tie
    let share = true
    let ambiguous = false
    if (shared) {
      const f5on = flowing('5'), f6on = flowing('6')
      if (f5on || f6on) share = flowing(d)
      else ambiguous = true
    }
    const casesToday = shared && share ? raw.casesToday56 ?? null : null
    const fl = raw.fillerFlow?.[d] || null
    let filler1 = null
    if (d === '1' && raw.filler1) {
      track('f1.lane1', raw.filler1.lane1Good, nowMs); track('f1.lane2', raw.filler1.lane2Good, nowMs)
      const at = latest(movedAt('f1.lane1'), movedAt('f1.lane2'))
      const r1 = ratePerMin('f1.lane1'), r2 = ratePerMin('f1.lane2')
      filler1 = { ...raw.filler1, cartonsPerMin: r1 == null && r2 == null ? null : Math.round(((r1 || 0) + (r2 || 0)) * 10) / 10, movedAt: at, moving: at != null && nowMs - at <= FILLER1_MOVE_MS }
    }
    const signals = []
    if (fl && flowing(d)) signals.push({ what: 'product flowing', at: nowMs })
    if (filler1?.moving) signals.push({ what: 'cartons moving', at: filler1.movedAt })
    if (share && cs?.moving) signals.push({ what: ambiguous ? 'cases moving (shared 5/6)' : 'cases moving', at: cs.movedAt })
    if (share && pall?.moving) signals.push({ what: ambiguous ? 'pallets moving (shared 5/6)' : 'pallets moving', at: pall.movedAt })
    const lastMovementAt = [filler1?.movedAt, share ? cs?.movedAt : null, share ? pall?.movedAt : null].filter((x) => x != null).sort((a, b) => b - a)[0] ?? null
    const moving = signals.length > 0 || (lastMovementAt != null && nowMs - lastMovementAt <= LINE_MOVE_MS && share)
    lines[d] = {
      moving,
      movement: signals[0]?.what || null,
      lastMovementAt: lastMovementAt != null ? new Date(lastMovementAt).toISOString() : null,
      hasCounters: !!(pall || cs || filler1 || fl),
      sharedAmbiguous: shared && ambiguous && !!((cs && cs.moving) || (pall && pall.moving)),
      fillerFlow: fl ? fl.rate : null,
      fillerFlowUnit: fl ? fl.unit : null,
      filler1,
      sterile: raw.sterile?.fillers?.[d] ?? null,
      casePacker: cs ? { ...cs, shared, attributed: share } : null,
      palletizer: pall ? { ...pall, shared, attributed: share } : null,
      casesToday,
    }
  }
  return { lines, legs: raw.sterile?.legs || {} }
}

async function run(historian) {
  const pollStart = Date.now()
  try {
    const raw = await historian.getPackagingStatus()
    const nowMs = clock.now()
    const derived = derive(raw, nowMs)
    statusStore.setPackaging({ ...derived, pollDurationMs: Date.now() - pollStart })
    const moving = Object.entries(derived.lines).filter(([, l]) => l.moving).map(([d, l]) => `L${d} (${l.movement || 'recent'})`)
    console.log(`[PackagingJob] Polled ${Object.keys(raw.palletizers || {}).length} palletizers, ${Object.keys(raw.casePackers || {}).length} case packers — moving: ${moving.join(', ') || 'none'} in ${Date.now() - pollStart}ms`)
  } catch (err) {
    console.error('[PackagingJob] Poll error:', err.message)
    statusStore.pushEvent('packaging.poll.error', 'Packaging poll failed', { error: err.message })
  }
}

function reset() { last.clear(); rings.clear() }

module.exports = { run, reset, derive, track, ratePerMin, COUNTER_MOVE_MS, LINE_MOVE_MS, FLOW_MIN }
