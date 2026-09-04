/**
 * Facility adapter — turns the live-status snapshot (statusStore.snapshot())
 * into EntityState records keyed by facility-map SVG id.
 *
 * Pure: (snapshot, assignments, nowMs, lines) → { [svgId]: EntityState }.
 * `lines` is facilityLinesSource.snapshot(): scheduler + staging-queue facts
 * per packaging line, combined here with the historian's physical evidence.
 * `trucks` is facilityTrucksSource.snapshot(): the NetSuite milk-truck queue,
 * joined to the receiving bays' XFR.Source (truck number). No I/O, no clock
 * side effects beyond reading `now` for staleness. The state service diffs the
 * result against the previous tick and broadcasts only what changed.
 *
 * EntityState (the contract the SunApps map renders):
 *   { status, level, primary, metrics, product, group, reverse, stale, source }
 *   status: running | idle | cip | flowing | stale
 *   group:  work order number — everything in one product chain shares it
 *   reverse: pipes only — animate against the registry from→to direction
 */
const J = require('./facilityJoins')
const { PRODUCT_INDEX_ITEM_MAP } = require('./mesItemConfig')

const STALE_MS = 90_000

const round = (v, d = 1) => (v == null || Number.isNaN(Number(v)) ? null : Math.round(Number(v) * 10 ** d) / 10 ** d)
const pct = (v) => (v == null ? null : Math.max(0, Math.min(1, Number(v) / 100)))

function parseProduct(name, kind) {
  const p = String(name || '').toLowerCase()
  if (!p || p === 'none' || p === 'empty') return null
  return {
    kind,
    organic: /organic|\borg\b/.test(p),
    a2: /\ba2\b/.test(p),
    fat: /skim|fat free|\b0%/.test(p) ? 'skim' : /1%/.test(p) ? '1%' : /2%/.test(p) ? '2%' : /3\.25|3\.5|whole/.test(p) ? 'whole' : /cream/.test(p) ? 'cream' : /raw/.test(p) ? 'raw' : null,
  }
}

function buildEntities(snapshot, assignments, nowMs = Date.now(), lines = null, trucks = null) {
  const e = {}
  const isStale = (pollAt) => !pollAt || nowMs - Date.parse(pollAt) > STALE_MS
  const ent = (id, status, extra = {}) => { e[id] = { status, source: 'mes', ...extra }; return e[id] }
  const light = (id, extra = {}) => {
    // pipes: a later, richer claim wins over a bare "flowing"
    if (!id) return
    e[id] = { status: 'flowing', source: 'mes', ...(e[id] || {}), ...extra }
  }
  const surgeIdOf = Object.fromEntries(Object.entries(assignments.surge).map(([svg, hid]) => [hid, svg]))
  const blendIdOf = Object.fromEntries(Object.entries(assignments.blend).map(([svg, hid]) => [hid, svg]))

  // ── work-order groups (from active batches in tick state) ──────────────
  const tick = snapshot.tick || {}
  const surgeWO = {}   // ST81 → WO number
  const surgeUht = {}  // ST81 → feeding UHT
  for (const b of tick.surgeBatches || []) {
    if (!b?.tankId || !b.nsWorkOrderNumber) continue
    surgeWO[b.tankId] = b.nsWorkOrderNumber
    if (b.feedingUhtId) surgeUht[b.tankId] = b.feedingUhtId
  }
  const blendWO = {}   // BlendTank1A → WO number
  for (const b of tick.batches || []) {
    if (b?.tankId && b.nsWorkOrderNumber) blendWO[J.normalizeVessel(b.tankId)] = b.nsWorkOrderNumber
  }
  const uhtWO = {}
  for (const [st, uht] of Object.entries(surgeUht)) if (surgeWO[st]) uhtWO[uht] = surgeWO[st]

  // ── silos ───────────────────────────────────────────────────────────────
  const siloStale = isStale(snapshot.silos?.[0]?.pollAt || snapshot.lastPoll?.equipment)
  for (const s of snapshot.silos || []) {
    const id = J.SILOS[J.normalizeSilo(s.siloId)]
    if (!id) continue
    const active = Array.isArray(s.activity) && s.activity.length > 0
    ent(id, siloStale ? 'stale' : active ? 'running' : 'idle', {
      level: pct(s.levelPct),
      primary: s.productName && s.productName !== 'None' ? s.productName : 'Empty',
      product: parseProduct(s.productName, s.kind === 'cream' ? 'cream' : 'milk'),
      metrics: [{ label: 'gal', value: round(s.gallons, 0) }, { label: 'lb', value: round(s.lbs, 0) }, { label: '°F', value: round(s.tempF) }].filter((m) => m.value != null),
      stale: siloStale,
    })
  }

  // ── separator ───────────────────────────────────────────────────────────
  const sep = snapshot.separator
  if (sep) {
    const stale = isStale(sep.pollAt)
    const cip = !!(sep.cipChemReq || sep.cipRinseReq)
    const running = !cip && /run|active|open|process/i.test(String(sep.state)) && !stale
    const dests = (sep.destinations || []).map(J.normalizeSilo)
    ent('seperator', stale ? 'stale' : cip ? 'cip' : running ? 'running' : 'idle', {
      primary: running ? `${sep.transferName || 'Separator'} · ${J.normalizeSilo(sep.source) || '?'} → ${dests.join(' + ') || '?'}` : cip ? 'CIP' : 'Idle',
      metrics: [{ label: 'cream gpm', value: round(sep.creamFlowGpm) }, { label: 'skim gpm', value: round(sep.skimFlowGpm) }, { label: 'feed lb', value: round(sep.feedTotalLbs, 0) }, { label: 'rpm', value: round(sep.motorRpm, 0) }].filter((m) => m.value != null),
      stale,
    })
    if (running) {
      const src = J.normalizeSilo(sep.source)
      if (J.SEP_LINE[src]) light(J.SEP_LINE[src], { reverse: true, primary: `Feed · ${src} → separator` })
      if (J.SILOS[src] && e[J.SILOS[src]]) e[J.SILOS[src]].status = 'running'
      for (const d of dests) {
        if (J.SEP_LINE[d]) light(J.SEP_LINE[d], { primary: `${d.startsWith('C') ? 'Cream' : 'Skim'} · separator → ${d}` })
        if (J.SILOS[d] && e[J.SILOS[d]]) e[J.SILOS[d]].status = 'running'
      }
    } else if (cip) {
      for (const id of Object.values(J.SEP_LINE)) if (!e[id]) e[id] = { status: 'idle', source: 'mes' }
    }
  }

  // ── blend feed lines ML1–4 / CL1–2 ──────────────────────────────────────
  const bt = snapshot.blendTanks
  const blendStale = isStale(bt?.pollAt)
  for (const ln of bt?.lines || []) {
    const pipe = J.BLEND_LINES[ln.line]
    if (!pipe) continue
    if (!ln.active || blendStale) { if (!e[pipe]) e[pipe] = { status: blendStale ? 'stale' : 'idle', source: 'mes', primary: `${ln.line} · idle` }; continue }
    const silo = J.normalizeSilo(ln.siloName)
    const dest = J.normalizeVessel(ln.requestedBy)
    const destSvg = blendIdOf[dest] || null
    const group = blendWO[dest] || null
    light(pipe, { primary: `${ln.line} · ${silo || '?'} → ${dest || '?'} · ${round(ln.totalizerLbs, 0) ?? 0} lb`, metrics: [{ label: 'lb', value: round(ln.totalizerLbs, 0) }, { label: 'target lb', value: round(ln.requestedTargetLbs, 0) }].filter((m) => m.value != null), group })
    if (J.SILO_TRANSLINE[silo]) light(J.SILO_TRANSLINE[silo], { group })
    if (J.SILOS[silo] && e[J.SILOS[silo]]) { e[J.SILOS[silo]].status = 'running'; if (group) e[J.SILOS[silo]].group = group }
    if (destSvg && J.MANIFOLD_TO_TANK[destSvg]) light(J.MANIFOLD_TO_TANK[destSvg], { group })
    const ts = dest && dest.match(/^TSTAT(\d)$/)
    if (ts && J.UHTS[`UHT${ts[1]}`]) light(J.UHTS[`UHT${ts[1]}`].balanceline, { group, primary: `${ln.line} → TSTAT${ts[1]} (bypass)` })
  }

  // ── blend tanks ─────────────────────────────────────────────────────────
  const tankById = Object.fromEntries((bt?.tanks || []).map((t) => [J.normalizeVessel(t.tankId), t]))
  for (const [svgId, hid] of Object.entries(assignments.blend)) {
    const t = tankById[J.normalizeVessel(hid)]
    if (!t) continue
    const lbs = Number(t.weightLbs) || 0
    const level = t.batchSize > 0 ? Math.min(1, lbs / t.batchSize) : lbs > 0 ? null : 0
    const group = blendWO[J.normalizeVessel(hid)] || null
    ent(svgId, blendStale ? 'stale' : t.batchActive ? 'running' : 'idle', {
      level,
      primary: t.batchActive ? `${t.productName || 'Batch'} · ${round(lbs, 0)} lb${t.batchSize ? ` of ${round(t.batchSize, 0)}` : ''}` : lbs > 500 ? `${t.productName || 'Product'} · ${round(lbs, 0)} lb (holding)` : 'Empty',
      product: parseProduct(t.productName, 'finished'),
      metrics: [{ label: 'lb', value: round(lbs, 0) }, { label: 'batch lb', value: round(t.batchSize, 0) }, { label: 'WO', value: group }].filter((m) => m.value != null),
      group,
      stale: blendStale,
    })
  }

  // ── UHTs, balance tanks, homogenizers ───────────────────────────────────
  const uhtStale = isStale(snapshot.uhts?.pollAt)
  for (const u of snapshot.uhts?.uhts || []) {
    const j = J.UHTS[u.uhtId]
    if (!j) continue
    const cip = u.mode === 'CIP'
    const running = u.mode === 'PROCESS' && (u.active || u.jobRunning || Number(u.flowGpm) > 1)
    const status = uhtStale ? 'stale' : cip ? 'cip' : running ? 'running' : 'idle'
    const group = uhtWO[u.uhtId] || blendWO[J.normalizeVessel(u.fromEntName)] || null
    const from = J.normalizeVessel(u.fromEntName)
    ent(j.uht, status, {
      primary: cip ? `CIP · ${u.stepName || ''}`.trim() : running ? `PROCESS · ${u.stepName || ''} · ${round(u.flowGpm) ?? 0} gpm` : `${u.mode || 'IDLE'}`,
      metrics: [{ label: 'gpm', value: round(u.flowGpm) }, { label: 'gal', value: round(u.galActual, 0) }, { label: 'step', value: u.stepNum }, { label: 'from', value: from }, { label: 'to', value: u.destSurgeTankId }].filter((m) => m.value != null && m.value !== ''),
      group, stale: uhtStale,
    })
    ent(j.balance, status, { primary: from ? `Fed by ${from}` : status === 'running' ? 'In use' : 'Idle', group, stale: uhtStale })
    ent(j.hom, status, { primary: status === 'running' ? 'Homogenizing' : status === 'cip' ? 'CIP' : 'Idle', group, stale: uhtStale })
    if (cip) { light(j.homline, { status: 'cip' }); light(j.balanceline, { status: 'cip' }) }
    if (running) {
      light(j.homline, { group })
      const fromSvg = blendIdOf[from]
      if (fromSvg) {
        if (J.OUTLET_LINE[fromSvg]) light(J.OUTLET_LINE[fromSvg], { group })
        light(j.balanceline, { group })
        if (e.vmatrix) e.vmatrix.status = 'running'; else ent('vmatrix', 'running', { primary: `${from} → ${u.uhtId}` })
      }
      const dest = u.destSurgeTankId && surgeIdOf[u.destSurgeTankId]
      if (dest && J.SURGE_IN[dest]) light(J.SURGE_IN[dest], { group, primary: `${u.uhtId} → ${u.destSurgeTankId}` })
      if (dest && !e.surgemanifold1) ent('surgemanifold1', 'running')
    }
  }

  // ── surge tanks → filler legs ───────────────────────────────────────────
  const surgeStale = isStale(snapshot.surgeTanks?.pollAt)
  const stById = Object.fromEntries((snapshot.surgeTanks?.tanks || []).map((t) => [t.tankId, t]))
  for (const [svgId, hid] of Object.entries(assignments.surge)) {
    const t = stById[hid]
    if (!t) continue
    const cip = Number(t.state) === 4
    const active = t.activeFill || t.drainingToFiller
    const group = surgeWO[hid] || null
    const legs = (t.fillerLines || []).map((n) => J.SEL_LEG[n]).filter(Boolean)
    ent(svgId, surgeStale ? 'stale' : cip ? 'cip' : active ? 'running' : 'idle', {
      level: pct(t.mainLevelPct),
      primary: [t.productDesc || t.productName || (t.empty ? 'Empty' : 'Product'), t.activeFill && t.connectedUht ? `filling from ${t.connectedUht}` : null, t.drainingToFiller ? `draining → leg ${(t.fillerLines || []).join('/')}` : null].filter(Boolean).join(' · '),
      product: parseProduct(t.productDesc || t.productName, 'finished'),
      metrics: [{ label: '%', value: round(t.mainLevelPct, 0) }, { label: 'gal', value: round(t.mainGallons, 0) }, { label: 'lb/min', value: round(t.pollRateLbsPerMin, 0) }, { label: 'WO', value: group }].filter((m) => m.value != null),
      group, stale: surgeStale,
    })
    if (t.drainingToFiller && !surgeStale) {
      light(J.SURGE_OUT[svgId], { group })
      if (!e.surgemanifold2) ent('surgemanifold2', 'running')
      for (const leg of legs) {
        light(leg, { group, primary: `${hid} → ${leg.replace('line', '').replace('filler', 'Filler ').replace('filler', ' & Filler ')}` })
        for (const f of J.LEG_FILLERS[leg] || []) if (e[f]) e[f].group = e[f].group || group
      }
    }
  }

  // ── filler 1 (the only metered filler) ──────────────────────────────────
  for (const f of snapshot.fillers?.fillers || []) {
    if (!f.measured) continue
    const id = `line${f.fillerId}filler`
    const stale = isStale(snapshot.fillers?.pollAt)
    const prev = e[id] || {}
    ent(id, stale ? 'stale' : f.running ? 'running' : 'idle', {
      ...prev,
      primary: f.running ? `Running · ${round(f.inletGpm) ?? 0} gpm inlet` : 'Not running',
      metrics: [{ label: 'gpm', value: round(f.inletGpm) }, { label: 'gal', value: round(f.inletTotalizerGal, 0) }].filter((m) => m.value != null),
      stale,
    })
  }

  // ── receiving bays + milk-truck queue ───────────────────────────────────
  buildReceiving(e, snapshot, trucks, nowMs)

  // ── packaging lines 1–6 (scheduler + staging queue + physical evidence) ──
  if (lines) buildLines(e, lines, nowMs)

  return e
}

// ─── receiving ───────────────────────────────────────────────────────────────
const TRUCKS_STALE_MS = 10 * 60_000
const fmtLb = (v) => (v == null ? null : Math.round(v).toLocaleString('en-US'))

/**
 * Receiving bays from the historian (what is physically unloading, into which
 * silo, how many pounds so far) joined by truck number to NetSuite's milk-truck
 * records (who it is, vendor, load, QC status). The receiving desk (`rec1`)
 * and the Receiving Bay room summarise the queue: unloading, checked in,
 * in QC, failed, next scheduled.
 */
function buildReceiving(e, snapshot, trucks, nowMs) {
  const rec = snapshot.receiving
  const stale = !rec?.pollAt || nowMs - Date.parse(rec.pollAt) > STALE_MS
  const trucksStale = !trucks?.pollAt || nowMs - Date.parse(trucks.pollAt) > TRUCKS_STALE_MS
  const truckOf = (no) => (no && trucks?.byTruckNo?.[no]) || null
  const light = (id, extra = {}) => { if (id) e[id] = { status: 'flowing', source: 'mes', ...(e[id] || {}), ...extra } }
  const unloadingNames = []

  for (const bay of rec?.bays || []) {
    const drawn = J.REC_BAYS[bay.bayId]
    if (!drawn) continue
    const unloading = !stale && bay.transferReady && !bay.transferComplete && (bay.qtyActualLbs > 0 || !!bay.source)
    // XFR.Source / destinations linger after a load finishes — only trust them while unloading
    const truck = unloading ? truckOf(bay.source) : null
    const product = unloading ? (bay.itemId && PRODUCT_INDEX_ITEM_MAP[Number(bay.itemId)]?.name) || truck?.item || null : null
    const target = (bay.qtyTargetLbs > 0 ? bay.qtyTargetLbs : null) || truck?.netLb || truck?.farmLb || null
    const dests = unloading ? (bay.destinations || []).map((d) => J.normalizeSilo(d)) : []
    const who = bay.source ? `Truck ${bay.source}${truck ? ` · ${truck.name}` : ''}` : 'Truck'
    const group = unloading ? (truck?.name || (bay.source ? `Truck ${bay.source}` : null)) : null
    if (unloading) unloadingNames.push(truck?.name || `truck ${bay.source || '?'}`)
    e[drawn.tank] = {
      status: stale ? 'stale' : unloading ? 'running' : 'idle',
      level: unloading && target ? Math.max(0, Math.min(1, bay.qtyActualLbs / target)) : null,
      primary: unloading
        ? [who, product, `${fmtLb(bay.qtyActualLbs)} lb${target ? ` of ${fmtLb(target)}` : ''}`, dests.length ? `→ ${dests.join(' + ')}` : null].filter(Boolean).join(' · ')
        : `Idle${bay.intakeQtyLbs ? ` · last load ${fmtLb(bay.intakeQtyLbs)} lb` : ''}`,
      product: product ? parseProduct(product, 'milk') : null,
      metrics: [
        { label: 'lb', value: unloading ? Math.round(bay.qtyActualLbs) : null },
        { label: 'load lb', value: target ? Math.round(target) : null },
        { label: 'to', value: dests.join(' + ') || null },
        { label: 'vendor', value: truck?.vendor || null },
        { label: 'load', value: truck?.loadNo || null },
        { label: 'QC', value: truck?.status || null },
      ].filter((m) => m.value != null && m.value !== ''),
      group, stale, source: 'mes', link: '/milk-trucks',
    }
    if (!unloading) continue
    light(drawn.line, { group, primary: `${drawn.label} → receiving header` })
    e.valves2 = { status: 'running', source: 'mes', primary: 'Receiving header' }
    for (const silo of dests) {
      light(J.REC_SILO_LINE[silo], { group, primary: `${who} → ${silo}` })
      const sid = J.SILOS[silo]
      if (sid && e[sid]) {
        if (e[sid].status === 'idle') e[sid].status = 'running'
        e[sid].primary = `${e[sid].primary} · ← ${drawn.label}, truck ${bay.source || '?'}${truck ? ` (${truck.name})` : ''}`
        if (!e[sid].group) e[sid].group = group
      }
    }
  }

  // receiving desk + room: the queue
  if (rec || trucks) {
    const onSite = trucks?.onSite || []
    const by = (id) => onSite.filter((t) => t.statusId === id)
    const next = trucks?.scheduled?.find((t) => t.arrivalMs > nowMs - 60 * 60_000) || null
    const failed = by(5)
    const parts = [
      unloadingNames.length ? `${unloadingNames.length} unloading (${unloadingNames.join(', ')})` : null,
      by(7).length ? `${by(7).length} checked in` : null,
      by(1).length ? `${by(1).length} pending QC` : null,
      by(2).length ? `${by(2).length} passed QC` : null,
      failed.length ? `${failed.length} FAILED QC (${failed.map((t) => t.name).join(', ')})` : null,
      next ? `next ${next.name} ${next.vendor ? `(${next.vendor}) ` : ''}${when(next.arrivalMs, nowMs)}` : trucks && !trucksStale ? 'no trucks scheduled' : null,
      trucksStale && trucks?.error ? 'truck list unavailable' : null,
    ].filter(Boolean)
    const status = stale ? 'stale' : unloadingNames.length ? 'running' : failed.length ? 'hold' : 'idle'
    const desk = {
      status, primary: parts.join(' · ') || 'Quiet',
      metrics: [
        { label: 'on site', value: onSite.length || null },
        { label: 'received today', value: trucks?.receivedToday?.length || null },
        { label: 'scheduled', value: trucks?.scheduled?.length || null },
      ].filter((m) => m.value != null),
      stale: stale || trucksStale, source: 'mes', link: '/milk-trucks',
    }
    e.rec1 = desk
    e.recbay = { ...desk, metrics: undefined }
  }
}

// ─── lines ───────────────────────────────────────────────────────────────────
const LINE_STALE_MS = 5 * 60_000        // our scheduler reads failing this long → stale
const CHANGEOVER_MS = 45 * 60_000       // within this of a planned start → changeover
const SHARED_RANK = { running: 5, down: 4, hold: 3, changeover: 2, cip: 1, idle: 0, stale: -1 }

const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
function when(ms, nowMs) {
  if (ms == null || Number.isNaN(ms)) return ''
  const a = new Date(ms), b = new Date(nowMs)
  const sameDay = a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  if (sameDay) return hhmm(ms)
  const dayDiff = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 864e5)
  const day = dayDiff === 1 ? 'tomorrow' : dayDiff === -1 ? 'yesterday' : a.toLocaleDateString('en-US', { weekday: 'short' })
  return `${day} ${hhmm(ms)}`
}
const fmtDur = (ms) => { const m = Math.round(ms / 60_000); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` }
const shortItem = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 48)

/**
 * Line status, in this order of trust:
 *   1. a work order with a logged start and no end → running
 *   2. a CIP / downtime / maintenance event covering now → cip / down / hold
 *   3. the WO planned for now, backed by evidence (NetSuite says In Process, product
 *      on the line's surge leg, Filler 1's meter) → running, "no start logged"
 *   4. the WO planned for now with no evidence → changeover just after its start, idle (late) after that
 *   5. the next WO within 45 min → changeover
 *   6. idle, naming the next WO
 * The scheduler is the source for what is being made; the historian only confirms.
 */
function buildLines(e, lines, nowMs) {
  const stale = !lines.pollAt || nowMs - Date.parse(lines.pollAt) > LINE_STALE_MS
  const painted = {}   // digit → { status, group, primary }
  for (const [d, L] of Object.entries(lines.lines || {})) {
    const fillerId = `line${d}filler`
    const legFlowing = e[J.LINE_LEG[d]]?.status === 'flowing'
    const fillerRunning = e[fillerId]?.status === 'running'   // only Filler 1 is metered; nothing else sets a filler status before this
    const evidence = fillerRunning ? 'filler meter' : legFlowing ? 'product on leg' : null
    let status = 'idle'
    let wo = null
    let primary = ''
    if (L.current) {
      status = 'running'; wo = L.current
      primary = `${wo.number} · ${shortItem(wo.item)} · since ${when(wo.start, nowMs)}`
    } else if (L.event) {
      status = L.event.status; wo = L.planned
      primary = [L.event.name, L.event.memo, `until ${when(L.event.end, nowMs)}`].filter(Boolean).join(' · ')
    } else if (L.planned && (L.planned.nsInProcess || evidence)) {
      status = 'running'; wo = L.planned
      primary = `${wo.number} · ${shortItem(wo.item)} · ${L.planned.nsInProcess ? 'in process' : evidence} (no start logged)`
    } else if (L.planned) {
      wo = L.planned
      const late = nowMs - wo.start
      if (late < CHANGEOVER_MS) { status = 'changeover'; primary = `Changeover → ${wo.number} · ${shortItem(wo.item)} · planned ${when(wo.start, nowMs)}` }
      else { status = 'idle'; primary = `${wo.number} not started · planned ${when(wo.start, nowMs)} (${fmtDur(late)} late)` }
    } else if (L.next && L.next.start - nowMs < CHANGEOVER_MS) {
      status = 'changeover'; wo = L.next
      primary = `Changeover → ${wo.number} · ${shortItem(wo.item)} · ${when(wo.start, nowMs)}`
    } else {
      status = 'idle'
      primary = L.next ? `Next ${L.next.number} · ${shortItem(L.next.item)} · ${when(L.next.start, nowMs)}` : 'No WO scheduled'
    }
    if (stale) { status = evidence ? 'running' : 'stale'; if (!evidence) primary = `Scheduler unavailable${lines.error ? ` · ${lines.error}` : ''}` }

    const q = L.queue
    const queueFull = !!q && !q.error && q.pending >= q.cap
    if (queueFull) primary += ` · ⚠ consumption queue ${q.pending}/${q.cap} — completions blocked`
    const group = wo && (status === 'running' || status === 'changeover') ? wo.number : null

    const metrics = [
      { label: 'WO', value: wo?.number },
      { label: 'item', value: wo ? shortItem(wo.item) : null },
      { label: 'qty', value: wo?.quantity },
      { label: 'NS', value: wo?.nsStatusLabel || null },
      { label: 'started', value: wo?.actualStart ? when(wo.actualStart, nowMs) : null },
      { label: 'ends', value: status === 'running' && wo ? when(wo.end, nowMs) : null },
      { label: 'next', value: L.next && L.next !== wo ? `${L.next.number} ${when(L.next.start, nowMs)}` : null },
      { label: 'queue', value: q && !q.error ? `${q.pending}/${q.cap}` : null },
    ].filter((m) => m.value != null && m.value !== '')

    e[`line${d}`] = { status, primary, metrics, group, stale: stale || !!lines.schedulerStale, source: 'scheduler', link: '/production-scheduler' }
    painted[d] = { status, group, primary }

    for (const m of J.LINE_MEMBERS[d] || []) {
      if (m === 'line56pallet') continue
      const prev = e[m] || {}
      if (m === fillerId && prev.metrics) {
        // Filler 1 keeps its metered status; it borrows the line's story and colour
        e[m] = { ...prev, status: prev.status === 'running' ? 'running' : status, primary: `${prev.primary} · ${primary}`, group: group || prev.group || null }
        continue
      }
      e[m] = { ...prev, status, primary, group: group || prev.group || null, source: 'scheduler', stale }
    }
  }
  // shared 5/6 palletizer follows whichever line is doing more
  const sh = ['5', '6'].map((d) => painted[d]).filter(Boolean).sort((a, b) => (SHARED_RANK[b.status] ?? 0) - (SHARED_RANK[a.status] ?? 0))[0]
  if (sh) e.line56pallet = { ...(e.line56pallet || {}), status: sh.status, primary: sh.primary, group: sh.group, source: 'scheduler', stale }
}

module.exports = { buildEntities, buildLines, buildReceiving, parseProduct, STALE_MS }
