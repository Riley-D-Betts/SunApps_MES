/**
 * Facility lines source — what the Production Scheduler and the staging
 * consumption queues say about packaging lines 1–6, cached for the facility
 * adapter.
 *
 * Polled by jobs/facilityLinesJob.js (cron FACILITY_LINES_CRON). Each poll reads
 * the scheduler service's hydrated window through the Gateway
 * (GET /api/scheduler/state — the same cache the Production Scheduler page
 * hydrates from; no SuiteQL of our own) and, once a minute, each line's pending
 * consumption queue (GET /api/staging/queue/:line). snapshot(nowMs) turns the
 * cached window into FACTS per line — the work order that has a logged start,
 * the one planned for right now, the next one, the CIP/downtime/maintenance
 * event covering now, the queue depth. The status decision lives in
 * facilityAdapter so it can be combined with what the historian sees (a surge
 * tank draining to the line's leg, Filler 1's inlet meter).
 *
 * Effective times mirror SunApps_NetSuite/services/schedulerCascadeService.js
 * (computeEffectiveTimes / eventsForCenter) — keep them in step. A work order
 * with an actual start pins to it and pushes everything after it on the same
 * row later, never earlier. Non-WO events belong to the merged row (lines 3/4
 * and 5/6 are one physical line), work orders to their own digit.
 *
 * Gantt strings are plant wall-clock ("2026-09-04 05:40"). Like the scheduler
 * service, this host must run in the plant time zone (America/Boise).
 */
const core = require('../clients/coreClient')
const clock = require('../sim/clock')

const LINE_DIGITS = ['1', '2', '3', '4', '5', '6']
const QUEUE_CAP = 5              // consumptionQueueService caps pending entries at 5; at 5/5 completions are rejected
const QUEUE_POLL_MS = 60_000
const WINDOW_DAYS = 2
const PLANNED_GRACE_MS = 6 * 60 * 60_000   // a never-started WO stays "planned" this long past its planned end

const EVENT_STATUS = { downtime: 'down', cip: 'cip', maintenance: 'hold', 'weekly-care': 'hold' }
const WO_STATUS_LABEL = { A: 'Planned', B: 'Released', D: 'In process', E: 'Built', G: 'Closed', H: 'Cancelled' }
const DONE_STATUSES = new Set(['E', 'G', 'H'])

const state = {
  sched: null,             // last-good scheduler window (raw)
  eff: null,               // Map eventId → { start, end } for state.sched
  schedulerVersion: null,
  schedulerUpdatedAt: null,
  schedulerStale: false,   // the scheduler service itself is serving last-good data
  pollAt: null,            // ISO of our last successful scheduler read
  error: null,
  queues: {},              // digit → { pending, cap, error, pollAt }
  queuePollAt: 0,
}

const toMs = (s) => (s ? new Date(String(s).replace(' ', 'T')).getTime() : NaN)
const pad = (n) => String(n).padStart(2, '0')
const dateStr = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const rowDigits = (wc) => String(wc?.name || '').replace(/\D/g, ' ').trim().split(/\s+/).filter(Boolean)

// ── mirrors schedulerCascadeService (keep in step) ───────────────────────────
function eventsForCenter(events, wc) {
  const members = wc.memberIds ?? [String(wc.id)]
  const synthetic = rowDigits(wc).map((d) => `line_${d}`)
  return events.filter((e) => members.includes(String(e.workCenterId)) || synthetic.includes(String(e.workCenterId)))
}

function computeEffectiveTimes(events, centers) {
  const eff = new Map()
  for (const wc of centers) {
    const rows = eventsForCenter(events, wc).slice()
      .sort((a, b) => toMs(a.actualStart ?? a.start) - toMs(b.actualStart ?? b.start))
    let prevEnd = -Infinity
    let anchored = false
    for (const e of rows) {
      const planned = toMs(e.start)
      const dur = Math.max(0, toMs(e.end) - planned)
      const aStart = e.actualStart ? toMs(e.actualStart) : null
      const aEnd = e.actualEnd ? toMs(e.actualEnd) : null
      let start, end
      if (aStart != null || aEnd != null) { start = aStart ?? planned; end = aEnd ?? start + dur; anchored = true }
      else if (anchored) { start = Math.max(planned, prevEnd); end = start + dur }
      else { start = planned; end = planned + dur }
      if (end < start) end = start
      eff.set(e.id, { start, end })
      prevEnd = Math.max(prevEnd, end)
    }
  }
  return eff
}

function centersFor(sched) {
  if (sched.workCenters?.length) return sched.workCenters
  const events = sched.events || []
  return [...new Set(events.map((e) => e.workCenterId))].filter(Boolean)
    .map((id) => ({ id, name: events.find((e) => e.workCenterId === id)?.workCenterName || `Line ${id}` }))
}

// ── facts per line ───────────────────────────────────────────────────────────
function deriveLine(digit, sched, eff, nowMs) {
  const centers = centersFor(sched)
  const wc = centers.find((c) => rowDigits(c).includes(digit)) || { id: digit, name: `Line ${digit}` }
  const row = eventsForCenter(sched.events || [], wc)
  const at = (e) => eff.get(e.id) || { start: toMs(e.start), end: toMs(e.end) }
  const wos = row.filter((e) => e.workOrderId && String(e.lineId) === `line_${digit}` && !DONE_STATUSES.has(e.woStatus))
  const others = row.filter((e) => !e.workOrderId)
  const wo = (e) => (e ? {
    id: e.workOrderId,
    number: e.woNumber || e.name || `WO ${e.workOrderId}`,
    item: e.itemName || '',
    quantity: e.woQuantity ?? null,
    nsStatus: e.woStatus || '',
    nsStatusLabel: WO_STATUS_LABEL[e.woStatus] || e.woStatus || '',
    nsInProcess: e.woStatus === 'D',       // NetSuite flips a WO to In Process on its first completion/issue
    start: at(e).start,
    end: at(e).end,
    plannedStart: toMs(e.start),
    actualStart: e.actualStart ? toMs(e.actualStart) : null,
    actualEnd: e.actualEnd ? toMs(e.actualEnd) : null,
  } : null)
  const notStarted = (e) => !e.actualStart && !e.actualEnd
  const byStart = (a, b) => at(a).start - at(b).start

  const current = wos.filter((e) => e.actualStart && !e.actualEnd).sort(byStart)[0]
  const planned = wos.filter((e) => notStarted(e) && at(e).start <= nowMs && at(e).end + PLANNED_GRACE_MS > nowMs).sort((a, b) => at(b).start - at(a).start)[0]
  const next = wos.filter((e) => notStarted(e) && at(e).start > nowMs).sort(byStart)[0]
  const lastDone = wos.filter((e) => e.actualEnd).sort((a, b) => toMs(b.actualEnd) - toMs(a.actualEnd))[0]
  const event = others.filter((e) => at(e).start <= nowMs && nowMs < at(e).end).sort(byStart)[0]

  return {
    line: digit,
    row: wc.name,
    current: wo(current),
    planned: wo(planned),
    next: wo(next),
    lastDone: wo(lastDone),
    event: event ? {
      id: event.id, type: event.eventTypeId, status: EVENT_STATUS[event.eventTypeId] || 'hold',
      name: event.name || event.eventTypeId || 'Event', memo: event.memo || '', start: at(event).start, end: at(event).end,
    } : null,
    queue: state.queues[digit] || null,
  }
}

/** Facts for every line at `nowMs`, from the cached scheduler window. */
function snapshot(nowMs = clock.now()) {
  const lines = {}
  if (state.sched) for (const d of LINE_DIGITS) lines[d] = deriveLine(d, state.sched, state.eff, nowMs)
  return {
    lines,
    pollAt: state.pollAt,
    error: state.error,
    schedulerStale: state.schedulerStale,
    schedulerUpdatedAt: state.schedulerUpdatedAt,
    schedulerVersion: state.schedulerVersion,
    queuePollAt: state.queuePollAt ? new Date(state.queuePollAt).toISOString() : null,
  }
}

// ── polling ──────────────────────────────────────────────────────────────────
async function pollQueues(nowMs) {
  for (const d of LINE_DIGITS) {
    const prev = state.queues[d] || { pending: 0, cap: QUEUE_CAP }
    try {
      const q = await core.getStagingQueue(d)
      state.queues[d] = { pending: Number(q?.pending) || 0, cap: QUEUE_CAP, error: q?.success === false ? (q.error || 'queue read failed') : null, pollAt: new Date(nowMs).toISOString() }
    } catch (err) {
      state.queues[d] = { ...prev, error: err.message, pollAt: new Date(nowMs).toISOString() }
    }
  }
  state.queuePollAt = nowMs
}

/** Read the scheduler window (and, once a minute, the queues). Returns true when the scheduler version moved. */
async function poll() {
  const nowMs = clock.now()
  let changed = false
  try {
    const sched = await core.getSchedulerState(dateStr(nowMs - WINDOW_DAYS * 864e5), dateStr(nowMs + WINDOW_DAYS * 864e5))
    changed = sched.version !== state.schedulerVersion || sched.updatedAt !== state.schedulerUpdatedAt
    state.sched = sched
    state.eff = computeEffectiveTimes(sched.events || [], centersFor(sched))
    state.schedulerVersion = sched.version ?? null
    state.schedulerUpdatedAt = sched.updatedAt ?? null
    state.schedulerStale = !!sched.stale
    state.pollAt = new Date(nowMs).toISOString()
    state.error = null
  } catch (err) {
    state.error = err.message   // keep last-good; the adapter ages it out by pollAt
  }
  if (nowMs - state.queuePollAt >= QUEUE_POLL_MS) await pollQueues(nowMs)
  return changed
}

function health() {
  return {
    pollAt: state.pollAt, error: state.error, schedulerVersion: state.schedulerVersion, schedulerUpdatedAt: state.schedulerUpdatedAt,
    schedulerStale: state.schedulerStale, events: state.sched?.events?.length ?? null,
    queues: Object.fromEntries(Object.entries(state.queues).map(([d, q]) => [d, q.error ? `error: ${q.error}` : `${q.pending}/${q.cap}`])),
  }
}

function reset() {
  Object.assign(state, { sched: null, eff: null, schedulerVersion: null, schedulerUpdatedAt: null, schedulerStale: false, pollAt: null, error: null, queues: {}, queuePollAt: 0 })
}

module.exports = { poll, snapshot, health, reset, computeEffectiveTimes, eventsForCenter, deriveLine, LINE_DIGITS, QUEUE_CAP, WO_STATUS_LABEL }
