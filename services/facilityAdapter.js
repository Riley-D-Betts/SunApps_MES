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

  // ── product chains: every active element joins a chain keyed by the vessel or
  //    train it belongs to (BlendTank1A, TSTAT1, UHT1, ST81, line1); chains that
  //    physically connect are linked and the whole chain takes ONE colour at the end
  const chain = { of: {}, links: [], legTank: {} }
  const tag = (id, key) => { if (id && key) chain.of[id] = key }
  const link = (a, b) => { if (a && b && a !== b) chain.links.push([a, b]) }

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
    tag(pipe, dest)
    if (J.SILO_TRANSLINE[silo]) { light(J.SILO_TRANSLINE[silo], { group }); tag(J.SILO_TRANSLINE[silo], dest) }
    if (J.SILOS[silo] && e[J.SILOS[silo]]) { e[J.SILOS[silo]].status = 'running'; if (group) e[J.SILOS[silo]].group = group; tag(J.SILOS[silo], dest) }
    if (destSvg && J.MANIFOLD_TO_TANK[destSvg]) { light(J.MANIFOLD_TO_TANK[destSvg], { group }); tag(J.MANIFOLD_TO_TANK[destSvg], dest) }
    const ts = dest && dest.match(/^TSTAT(\d)$/)
    if (ts && J.UHTS[`UHT${ts[1]}`]) { light(J.UHTS[`UHT${ts[1]}`].balanceline, { group, primary: `${ln.line} → TSTAT${ts[1]} (bypass)` }); tag(J.UHTS[`UHT${ts[1]}`].balanceline, dest) }
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
    if (t.batchActive && !blendStale) tag(svgId, J.normalizeVessel(hid))
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
      for (const id of [j.uht, j.balance, j.hom, j.homline]) tag(id, u.uhtId)
      link(u.uhtId, `TSTAT${u.uhtId.replace(/\D/g, '')}`)   // the balance tank and the lines into it belong to this train
      const fromSvg = blendIdOf[from]
      if (fromSvg) {
        if (J.OUTLET_LINE[fromSvg]) { light(J.OUTLET_LINE[fromSvg], { group }); tag(J.OUTLET_LINE[fromSvg], u.uhtId) }
        light(j.balanceline, { group }); tag(j.balanceline, u.uhtId)
        if (e.vmatrix) e.vmatrix.status = 'running'; else ent('vmatrix', 'running', { primary: `${from} → ${u.uhtId}` })
        link(u.uhtId, from)
      }
      const dest = u.destSurgeTankId && surgeIdOf[u.destSurgeTankId]
      if (dest && J.SURGE_IN[dest]) { light(J.SURGE_IN[dest], { group, primary: `${u.uhtId} → ${u.destSurgeTankId}` }); tag(J.SURGE_IN[dest], u.uhtId) }
      if (dest) link(u.uhtId, u.destSurgeTankId)
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
    if (!surgeStale && (t.activeFill || t.drainingToFiller)) tag(svgId, hid)
    if (t.drainingToFiller && !surgeStale) {
      light(J.SURGE_OUT[svgId], { group }); tag(J.SURGE_OUT[svgId], hid)
      if (!e.surgemanifold2) ent('surgemanifold2', 'running')
      for (const leg of legs) {
        light(leg, { group, primary: `${hid} → ${leg.replace('line', '').replace('filler', 'Filler ').replace('filler', ' & Filler ')}` })
        tag(leg, hid); chain.legTank[leg] = hid
        for (const f of J.LEG_FILLERS[leg] || []) if (e[f]) e[f].group = e[f].group || group
      }
    }
  }
  // Filler 1's inlet meter (FT1140 on leg TR11) is proof of draw even when no tank has latched Sel 1
  const f1meter = (snapshot.fillers?.fillers || []).find((f) => f.fillerId === 1 && f.measured)
  if (f1meter && Number(f1meter.inletGpm) > 1 && !isStale(snapshot.fillers?.pollAt) && !e.filler1filler2line) {
    light('filler1filler2line', { primary: `Filler 1 drawing ${round(f1meter.inletGpm)} gpm (no tank selected)` })
    if (!e.surgemanifold2) ent('surgemanifold2', 'running')
  }

  // ── filler 1 (the only metered filler) ──────────────────────────────────
  for (const f of snapshot.fillers?.fillers || []) {
    if (!f.measured) continue
    const id = `line${f.fillerId}filler`
    const stale = isStale(snapshot.fillers?.pollAt)
    const prev = e[id] || {}
    const drawing = Number(f.inletGpm) > 1
    ent(id, stale ? 'stale' : drawing ? 'running' : 'idle', {
      ...prev,
      primary: drawing ? `Running · ${round(f.inletGpm)} gpm inlet` : f.running ? 'In production mode · no product yet' : 'Not running',
      metrics: [{ label: 'gpm', value: round(f.inletGpm) }, { label: 'gal', value: round(f.inletTotalizerGal, 0) }].filter((m) => m.value != null),
      stale,
    })
  }

  // ── receiving bays + milk-truck queue ───────────────────────────────────
  buildReceiving(e, snapshot, trucks, nowMs)

  // ── packaging lines 1–6 (scheduler + staging queue + physical evidence) ──
  buildLines(e, lines, nowMs, snapshot.packaging, chain)

  // ── one colour per connected product chain ──────────────────────────────
  unifyChains(e, chain, { surgeWO, blendWO })

  return e
}

// ─── chains ──────────────────────────────────────────────────────────────────
/**
 * Union the chain keys that were linked while building, then give every tagged
 * element of a connected chain the same group: the packaging work order if a
 * line is in the chain, else the surge batch WO, else the blend batch WO, else
 * a stable synthetic key anchored on the chain's surge tank / UHT / balance tank.
 * This is what makes "silo → line → blend → UHT → surge → leg → filler" read as
 * one thing even though NetSuite gives each stage its own work order.
 */
function unifyChains(e, chain, { surgeWO, blendWO }) {
  const parent = {}
  const find = (k) => { while (parent[k] != null && parent[k] !== k) k = parent[k]; return k }
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb }
  for (const k of Object.values(chain.of)) if (parent[k] == null) parent[k] = k
  for (const [a, b] of chain.links) { if (parent[a] == null) parent[a] = a; if (parent[b] == null) parent[b] = b; union(a, b) }
  const members = {}   // root → Set of keys
  for (const k of Object.keys(parent)) (members[find(k)] ||= new Set()).add(k)
  const rank = (k) => (/^ST8/.test(k) ? 0 : /^UHT/.test(k) ? 1 : /^TSTAT/.test(k) ? 2 : /^BlendTank|^CocoaTank/.test(k) ? 3 : /^line/.test(k) ? 4 : 5)
  const groupOf = {}
  for (const [root, keys] of Object.entries(members)) {
    const sorted = [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    const lineKey = sorted.find((k) => /^line\d$/.test(k))
    const g = (lineKey && e[lineKey]?.group)
      || sorted.map((k) => surgeWO[k]).find(Boolean)
      || sorted.map((k) => blendWO[k]).find(Boolean)
      || `chain:${sorted[0]}`
    groupOf[root] = g
  }
  for (const [id, key] of Object.entries(chain.of)) {
    if (!e[id]) continue
    e[id].group = groupOf[find(key)]
  }
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
const LINE_STALE_MS = 5 * 60_000        // our scheduler reads failing this long → scheduler unavailable
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
const ago = (iso, nowMs) => (iso ? fmtDur(Math.max(0, nowMs - Date.parse(iso))) : null)

/**
 * Line status, in this order of trust:
 *   1. a work order with a logged start and no end → running
 *   2. a CIP / downtime / maintenance event covering now → cip / down / hold
 *   3. the WO planned for now, backed by evidence (counters or flow moving on the
 *      packaging poll, NetSuite In Process, product on the line's surge leg,
 *      Filler 1's meter) → running, "no start logged"
 *   4. the WO planned for now with no evidence → changeover just after its start, idle (late) after that
 *   5. the next WO within 45 min → changeover
 *   6. idle, naming the next WO
 * Without the scheduler the historian decides alone: movement → running.
 * The case packer and palletizer then take their own colour from their own
 * counters, and the filler from its flow.
 */
/** Lines 3/4 and 5/6 are one physical line scheduled as one row: a WO sitting on the idle twin while the other twin moves belongs to the moving twin. */
const PAIRS = [['3', '4'], ['5', '6']]
function reattributePairs(byLine, ownEvidence) {
  const out = { ...byLine }
  for (const [a, b] of PAIRS) {
    for (const [x, y] of [[a, b], [b, a]]) {
      const Lx = out[x], Ly = out[y]
      if (!Lx || !Ly) continue
      const woX = Lx.current || Lx.planned
      const woY = Ly.current || Ly.planned
      if (woX && !woY && !ownEvidence(x) && ownEvidence(y)) {
        out[y] = { ...Ly, current: Lx.current, planned: Lx.planned, event: Ly.event || Lx.event, movedFrom: x }
        out[x] = { ...Lx, current: null, planned: null, movedTo: y, movedWo: woX }
      }
    }
  }
  return out
}

function buildLines(e, lines, nowMs, packaging, chain = null) {
  const schedOk = !!(lines?.pollAt && nowMs - Date.parse(lines.pollAt) <= LINE_STALE_MS && lines.lines)
  const pk = packaging?.pollAt && nowMs - Date.parse(packaging.pollAt) <= STALE_MS ? packaging : null
  // evidence that belongs to ONE line (packaging counters, Filler 1's meter) — a surge leg feeds both twins, so it never moves a WO
  const meterGpm = (d) => Number((e[J.LINE_FILLER[d]]?.metrics || []).find((m) => m.label === 'gpm')?.value) || 0
  const ownEvidence = (d) => !!(pk?.lines?.[d]?.moving || meterGpm(d) > 1)
  const byLine = schedOk ? reattributePairs(lines.lines, ownEvidence) : {}
  const painted = {}   // digit → { status, group, primary }
  for (const d of ['1', '2', '3', '4', '5', '6']) {
    const L = schedOk ? byLine[d] : null
    const P = pk?.lines?.[d] || null
    if (!L && !P) continue
    const fillerId = J.LINE_FILLER[d]
    const legFlowing = e[J.LINE_LEG[d]]?.status === 'flowing'
    const fillerRunning = meterGpm(d) > 1   // Filler 1 inlet meter (the only filler statused before this)
    const evidence = P?.moving ? P.movement || 'movement on the line' : fillerRunning ? 'filler meter' : legFlowing ? 'product on leg' : null
    let status = 'idle'
    let wo = null
    let primary = ''
    if (L?.movedTo) {
      status = 'idle'; wo = null
      primary = `${L.movedWo.number} · ${shortItem(L.movedWo.item)} · running on line ${L.movedTo}`
    } else if (L) {
      if (L.current) {
        status = 'running'; wo = L.current
        primary = `${wo.number} · ${shortItem(wo.item)} · since ${when(wo.start, nowMs)}`
      } else if (L.event) {
        status = L.event.status; wo = L.planned
        primary = [L.event.name, L.event.memo, `until ${when(L.event.end, nowMs)}`].filter(Boolean).join(' · ')
      } else if (L.planned && (L.planned.nsInProcess || evidence)) {
        status = 'running'; wo = L.planned
        primary = `${wo.number} · ${shortItem(wo.item)} · ${evidence || 'in process'} (no start logged)`
      } else if (L.planned) {
        wo = L.planned
        const late = nowMs - wo.start
        if (late < CHANGEOVER_MS) { status = 'changeover'; primary = `Changeover → ${wo.number} · ${shortItem(wo.item)} · planned ${when(wo.start, nowMs)}` }
        else { status = 'idle'; primary = `${wo.number} not started · planned ${when(wo.start, nowMs)} (${fmtDur(late)} late)` }
        if (P?.sterile === false) primary += ' · filler not sterile'
      } else if (L.next && L.next.start - nowMs < CHANGEOVER_MS) {
        status = 'changeover'; wo = L.next
        primary = `Changeover → ${wo.number} · ${shortItem(wo.item)} · ${when(wo.start, nowMs)}`
      } else if (evidence) {
        status = 'running'
        primary = `Producing · ${evidence} · nothing scheduled`
      } else {
        status = 'idle'
        primary = L.next ? `Next ${L.next.number} · ${shortItem(L.next.item)} · ${when(L.next.start, nowMs)}` : 'No WO scheduled'
      }
    } else if (evidence) {
      status = 'running'
      primary = `Producing · ${evidence} · scheduler unavailable`
    } else {
      status = P?.hasCounters ? 'idle' : 'stale'
      // the error text itself stays in /health — it can be a whole HTML error page
      primary = P?.lastMovementAt ? `No movement for ${ago(P.lastMovementAt, nowMs)} · scheduler unavailable` : 'Scheduler unavailable'
    }
    if (L?.movedFrom) primary += ` · scheduled on line ${L.movedFrom}`
    if (status === 'running' && P?.hasCounters && !P.moving && P.lastMovementAt) primary += ` · ⚠ no movement for ${ago(P.lastMovementAt, nowMs)}`

    const q = L?.queue
    const queueFull = !!q && !q.error && q.pending >= q.cap
    if (queueFull) primary += ` · ⚠ consumption queue ${q.pending}/${q.cap} — completions blocked`
    const group = wo && (status === 'running' || status === 'changeover') ? wo.number : null

    const metrics = [
      { label: 'WO', value: wo?.number },
      { label: 'item', value: wo ? shortItem(wo.item) : null },
      { label: 'pallets today', value: P?.palletizer?.attributed ? P.palletizer.palletsToday : null },
      { label: 'cases/min', value: P?.casePacker?.attributed ? P.casePacker.casesPerMin : null },
      { label: 'cartons/min', value: P?.filler1?.cartonsPerMin ?? null },
      { label: P?.fillerFlowUnit || 'flow', value: P?.fillerFlow != null ? round(P.fillerFlow, 0) : null },
      { label: 'cases today', value: P?.casesToday ?? null },
      { label: 'qty', value: wo?.quantity },
      { label: 'NS', value: wo?.nsStatusLabel || null },
      { label: 'started', value: wo?.actualStart ? when(wo.actualStart, nowMs) : null },
      { label: 'ends', value: status === 'running' && wo ? when(wo.end, nowMs) : null },
      { label: 'sterile', value: P?.sterile == null ? null : P.sterile ? 'yes' : 'NO' },
      { label: 'pack', value: P?.casePacker?.attributed ? P.casePacker.recipe : null },
      { label: 'next', value: L?.next && L.next !== wo ? `${L.next.number} ${when(L.next.start, nowMs)}` : null },
      { label: 'queue', value: q && !q.error ? `${q.pending}/${q.cap}` : null },
    ].filter((m) => m.value != null && m.value !== '')

    const stale = !schedOk || !!lines?.schedulerStale
    e[`line${d}`] = { status, primary, metrics, group, stale, source: L ? 'scheduler' : 'mes', link: '/production-scheduler' }
    painted[d] = { status, group, primary }

    for (const m of J.LINE_MEMBERS[d] || []) {
      if (m === 'line56pallet') continue
      const prev = e[m] || {}
      if (m === fillerId && prev.metrics) {
        // Filler 1 keeps its metered status; it borrows the line's story and colour
        e[m] = { ...prev, status: prev.status === 'running' ? 'running' : status, primary: `${prev.primary} · ${primary}`, group: group || prev.group || null }
        continue
      }
      e[m] = { ...prev, status, primary, group: group || prev.group || null, source: L ? 'scheduler' : 'mes', stale }
    }
    if (P) paintMachines(e, d, P, status, group, nowMs)
    if (chain && (status === 'running' || status === 'changeover')) {
      for (const m of [`line${d}`, ...(J.LINE_MEMBERS[d] || [])]) if (e[m] && m !== 'line56pallet') chain.of[m] = `line${d}`
      const tank = chain.legTank[J.LINE_LEG[d]]
      if (tank && (status === 'running')) chain.links.push([`line${d}`, tank])
    }
  }
  // shared 5/6 palletizer follows whichever line is doing more, then its own counters
  const sh = ['5', '6'].map((d) => painted[d]).filter(Boolean).sort((a, b) => (SHARED_RANK[b.status] ?? 0) - (SHARED_RANK[a.status] ?? 0))[0]
  if (sh) e.line56pallet = { ...(e.line56pallet || {}), status: sh.status, primary: sh.primary, group: sh.group, source: 'scheduler' }
  if (sh && chain && sh.status === 'running') { const d = painted['6']?.status === 'running' ? '6' : '5'; chain.of.line56pallet = `line${d}` }
  const shP = pk?.lines?.['6']?.palletizer || pk?.lines?.['5']?.palletizer
  if (shP) paintPalletizer(e, 'line56pallet', shP, e.line56pallet?.status || 'idle', e.line56pallet?.group || null, nowMs)
  // sterile flags on the drawn surge-to-filler legs
  for (const [tr, pipe] of Object.entries(J.LEG_TR)) {
    const st = pk?.legs?.[tr]
    if (st == null || !e[pipe]) continue
    e[pipe].metrics = [...(e[pipe].metrics || []).filter((m) => m.label !== 'sterile'), { label: 'sterile', value: st ? 'yes' : 'NO' }]
    if (!st) e[pipe].primary = `${e[pipe].primary ? e[pipe].primary + ' · ' : ''}${tr} not sterile`
  }
}

/** Filler, case packer and palletizer take their own colour from their own counters. */
function paintMachines(e, d, P, lineStatus, group, nowMs) {
  const fillerId = J.LINE_FILLER[d]
  const f = e[fillerId]
  if (f) {
    const flowing = P.fillerFlow != null && P.fillerFlow >= 5
    const f1 = P.filler1
    const meterGpm = (f.metrics || []).find((m) => m.label === 'gpm')?.value
    const mode = f1 ? (f1.moving || meterGpm ? 'Filling' : f1.sipRunning ? 'SIP running' : f1.cipRunning ? 'CIP running' : f1.runMode ? 'In production mode · no product yet' : 'Not filling') : flowing ? 'Filling' : P.fillerFlow != null ? 'No flow' : null
    const bits = [
      mode,
      P.fillerFlow != null ? `${round(P.fillerFlow, 0)} ${P.fillerFlowUnit}` : null,
      meterGpm ? `${meterGpm} gpm inlet` : null,
      f1?.cartonsPerMin != null ? `${f1.cartonsPerMin} cartons/min` : null,
      f1 ? `lanes ${f1.lane1Good ?? '?'} / ${f1.lane2Good ?? '?'}` : null,
      P.sterile != null ? (P.sterile ? 'sterile' : 'NOT sterile') : null,
      lineStatus === 'running' || lineStatus === 'changeover' ? null : e[`line${d}`]?.primary || null,
    ].filter(Boolean)
    const fillerStatus = flowing || f1?.moving || meterGpm > 1 ? 'running' : f1?.cipRunning || f1?.sipRunning ? 'cip' : lineStatus === 'running' ? 'idle' : f.status
    e[fillerId] = { ...f, status: fillerStatus, primary: bits.join(' · '), metrics: [...(f.metrics || []), { label: 'sterile', value: P.sterile == null ? null : P.sterile ? 'yes' : 'NO' }, { label: P.fillerFlowUnit || 'flow', value: P.fillerFlow != null ? round(P.fillerFlow, 0) : null }].filter((m) => m.value != null) }
  }
  const cs = P.casePacker
  const caseId = J.LINE_CASE[d]
  if (cs && cs.attributed && e[caseId]) {
    const st = cs.moving ? 'running' : lineStatus === 'running' ? 'idle' : lineStatus
    e[caseId] = { ...e[caseId], status: st, group: st === 'running' ? group : null,
      primary: [cs.moving ? 'Packing' : cs.movedAt ? `No cases for ${fmtDur(nowMs - cs.movedAt)}` : 'No cases', cs.casesPerMin != null ? `${cs.casesPerMin} cases/min` : null, cs.recipe ? `pattern ${cs.recipe}` : null, cs.shared ? 'shared 5/6' : null].filter(Boolean).join(' · '),
      metrics: [{ label: 'cases/min', value: cs.casesPerMin }, { label: 'lifetime', value: cs.lifetimeCases }, { label: 'pack', value: cs.recipe }, { label: 'state', value: cs.state != null ? `${cs.state}/${cs.reason ?? '-'}` : null }].filter((m) => m.value != null) }
  }
  const palletId = J.LINE_PALLET[d]
  if (P.palletizer && P.palletizer.attributed && palletId !== 'line56pallet') paintPalletizer(e, palletId, P.palletizer, lineStatus, group, nowMs)
}

function paintPalletizer(e, palletId, pl, lineStatus, group, nowMs) {
  if (!e[palletId]) return
  const st = pl.moving ? 'running' : lineStatus === 'running' ? 'idle' : lineStatus
  e[palletId] = { ...e[palletId], status: st, group: st === 'running' ? group : null,
    primary: [pl.moving ? 'Palletizing' : pl.movedAt ? `No cases for ${fmtDur(nowMs - pl.movedAt)}` : 'No cases', pl.palletsToday != null ? `${pl.palletsToday} pallets today` : null, pl.casesPerMin != null ? `${pl.casesPerMin} cases/min` : null, pl.palletComplete ? 'pallet waiting at exit' : null, pl.shared ? 'shared 5/6' : null].filter(Boolean).join(' · '),
    metrics: [{ label: 'pallets today', value: pl.palletsToday }, { label: 'cases/min', value: pl.casesPerMin }, { label: 'lifetime', value: pl.lifetimeCases }, { label: 'state', value: pl.state != null ? `${pl.state}/${pl.reason ?? '-'}` : null }].filter((m) => m.value != null) }
}

module.exports = { buildEntities, buildLines, buildReceiving, parseProduct, STALE_MS }
