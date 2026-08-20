#!/usr/bin/env node
/**
 * SD-708: Onboarding probe for the new Line 1 filler inlet flow meter on
 * ThermaRoute route TR11 (surge tanks ST81/82 → Filler 1):
 *
 *   ThermaRoute.TR11_FT1140              — instantaneous flow
 *   ThermaRoute.TR11_FT1140.Totalizer_1  — totalized flow
 *
 * Neither tag exists in the 2026-06-10 all-tags.json snapshot, the dotted
 * `.Totalizer_1` breaks the TR11 underscore sub-tag convention
 * (TR11_PT1140_Output), and a trend legend once rendered the prefix as
 * "THermaRoute" — so nothing about the FQN strings is trusted until this
 * probe confirms them. Checks, in order:
 *
 *   1. Discovery      — live Tags entity-set search for FT1140/Totalizer FQNs
 *   2. Live check     — candidate matrix (single vs DOUBLE prefix × naming
 *                       variants) via Raw top-1: Value/OpcQuality/age verdict
 *   3. History start  — earliest ProcessValues sample + per-day counts (30 d)
 *   4. Density        — minutely AnalogSummary vs ProcessValues (the SD-655
 *                       lesson: sparse PV can mask dense 1 Hz storage)
 *   5. Totalizer form — hourly buckets over 48 h: monotonic odometer vs
 *                       per-run reset, cross-referenced against ST81/82 Sel1
 *                       latches and Filler1 RunMode transitions
 *   6. Units check    — busiest-hour totalizer delta vs trapezoid-integrated
 *                       flow (Average × duration — NOT the Integral field)
 *                       vs ST81/82 gallons drop
 *
 * KEY DISCOVERY (SD-708), from runs on 2026-08-20:
 *   1. Canonical FQNs (exact catalog strings, confirmed live/OpcQuality 192):
 *        ThermaRoute.TR11_FT1140              Analog, desc "Filler 1 inlet Flow"
 *        THermaRoute.TR11_FT1140.Totalizer_1  Analog, no desc — the "TH" typo
 *      is REAL: the totalizer's prefix is misspelled `THermaRoute` in the
 *      historian catalog. No `_Output` form, no double-prefix form, no
 *      underscore-totalizer form exists (all returned NO-DATA).
 *   2. CASE TRAP: Tags('fqn')/Raw resolves case-INsensitively (wrong-case
 *      FQN still returns the live value), but $filter=FQN eq on
 *      ProcessValues/AnalogSummary is case-SENSITIVE — wrong casing silently
 *      returns ZERO history, no error. Always use the exact strings above.
 *   3. Historized since 2026-08-18 ~20:40Z. Dense storage: ~60 samples/min
 *      (flow) and ~42/min (totalizer) via AnalogSummary; ProcessValues is
 *      deadbanded to ~nothing (10 rows in 30 d) — the SD-655 lesson applies:
 *      history reads MUST use AnalogSummary (or Raw), never ProcessValues.
 *      (PV also emits one interpolated row AT the query window start —
 *      the phantom "07-21" sample — a boundary artifact, not stored data.)
 *   4. Units: rate is per-MINUTE and the totalizer is its exact integral —
 *      busiest-hour totalizer Δ 5049.39 vs Σ(minutelyAvg×1min) 5051.70
 *      (0.05% agreement). EngUnit is unset ("None") on both tags; GPM/gal
 *      per plant convention (all sibling flows are GPM, ThermaRoute levels
 *      are _Gal). Flow peaked ~84 avg, ~62 spot during production.
 *   5. Totalizer: monotonic non-decreasing odometer across all 48 h observed
 *      (zero until first flow 08-19T18:00Z, 48,949 by 08-20T19:55Z) — no
 *      resets, matching "resettable but not configured to reset yet".
 *      Consumers must still do reset-tolerant baseline math.
 *   6. GATING WARNING for step 2: the first flow event (08-19 18:00–20:00Z,
 *      ~13,096 totalized) ran while Filler1.CI_To_Proc.RunMode=0 and BEFORE
 *      ST81's Sel1 latch picked up (23:08Z) — the meter totalizes non-
 *      production flow (flush/CIP/commissioning) too, like FT1102 does.
 *      Product accounting must gate on RunMode/Sel1, not raw totalizer Δ.
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN   = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

// Candidate matrix. Single- AND double-prefixed forms of every naming
// variant: the real ThermaRoute analogs (ST levels/gallons) only read good
// under the DOUBLE prefix, while status bits use the single prefix.
const BASES = ['TR11_FT1140', 'TR11_FT1140_Output']
const TOTALS = ['TR11_FT1140.Totalizer_1', 'TR11_FT1140_Totalizer_1']
const PREFIXES = ['ThermaRoute.', 'ThermaRoute.ThermaRoute.']
const FLOW_CANDIDATES  = PREFIXES.flatMap(p => BASES.map(b => p + b))
const TOTAL_CANDIDATES = PREFIXES.flatMap(p => TOTALS.map(b => p + b))

// Cross-reference tags (all previously validated elsewhere in the repo)
const RUNMODE_TAG = 'Filler1.CI_To_Proc.RunMode'
const SEL1_TAGS   = ['ThermaRoute.ST81_Sel1_Filling_Indicator', 'ThermaRoute.ST82_Sel1_Filling_Indicator']
const ST_GAL_TAGS = ['ThermaRoute.ThermaRoute.ST81_LT8101_Gal', 'ThermaRoute.ThermaRoute.ST82_LT8201_Gal']

const GOOD_QUALITY = 192
const STALE_MS = 24 * 60 * 60 * 1000

function ntlmGet(url) {
  return new Promise((resolve, reject) => {
    httpntlm.get({
      url, domain: DOMAIN, username: USERNAME, password: PASSWORD,
      headers: { Accept: 'application/json' },
    }, (err, res) => {
      if (err) return reject(err)
      try { resolve({ status: res.statusCode, data: JSON.parse(res.body.replace(/^﻿/, '')) }) }
      catch { resolve({ status: res.statusCode, data: null, raw: res.body?.slice(0, 200) }) }
    })
  })
}

async function getPaged(url, cap = 100000) {
  const all = []
  let next = url
  while (next && all.length < cap) {
    const { status, data } = await ntlmGet(next)
    if (status !== 200 || !data) break
    all.push(...(data.value || []))
    next = data['@odata.nextLink'] || null
  }
  return all
}

async function rawTop1(fqn) {
  const url = `${BASE_URL}/Tags('${encodeURIComponent(fqn)}')/Raw?$orderby=DateTime desc&$top=1`
  const { status, data } = await ntlmGet(url)
  if (status !== 200 || !data?.value?.length) return null
  return data.value[0]
}

async function analogSummary(fqn, since, until, resolutionMs) {
  const filter = `FQN eq '${fqn}' and StartDateTime ge ${since.toISOString()} and EndDateTime le ${until.toISOString()}`
  return getPaged(`${BASE_URL}/AnalogSummary?$filter=${encodeURIComponent(filter)}&Resolution=${resolutionMs}`, 5000)
}

function verdict(rec) {
  if (!rec) return 'NO-DATA'
  const age = Date.now() - new Date(rec.DateTime).getTime()
  const q = rec.OpcQuality
  const qs = q === GOOD_QUALITY ? 'good' : `BAD-QUALITY(${q})`
  return `${age < STALE_MS ? 'LIVE' : 'STALE'}/${qs}`
}

// ── 1. Discovery ────────────────────────────────────────────────────────────
async function discover() {
  console.log('\n=== 1. DISCOVERY — live Tags entity-set search ===')
  const found = new Map()
  for (const needle of ['FT1140', 'Totalizer']) {
    const filter = `contains(FQN,'${needle}')`
    const rows = await getPaged(`${BASE_URL}/Tags?$filter=${encodeURIComponent(filter)}&$select=FQN,Description,TagType,EngUnit`, 500)
    console.log(`\n  contains(FQN,'${needle}') → ${rows.length} tag(s)`)
    rows.forEach(t => {
      found.set(t.FQN, t)
      console.log(`    ${t.FQN.padEnd(55)} ${String(t.TagType || '').padEnd(10)} ${String(t.EngUnit || '').padEnd(10)} ${t.Description || ''}`)
    })
  }
  return found
}

// ── 2. Candidate-matrix live check ──────────────────────────────────────────
async function liveCheck(candidates, label) {
  console.log(`\n=== 2. LIVE CHECK — ${label} ===`)
  console.log(`  ${'Verdict'.padEnd(22)} ${'Value'.padEnd(14)} ${'Timestamp'.padEnd(26)} FQN`)
  const live = []
  for (const fqn of candidates) {
    try {
      const rec = await rawTop1(fqn)
      const v = verdict(rec)
      console.log(`  ${v.padEnd(22)} ${String(rec?.Value ?? '—').padEnd(14)} ${String(rec?.DateTime ?? '—').padEnd(26)} ${fqn}`)
      if (rec && v.startsWith('LIVE/good')) live.push(fqn)
    } catch (err) {
      console.log(`  ${'ERROR'.padEnd(22)} ${''.padEnd(14)} ${''.padEnd(26)} ${fqn}  (${err.message})`)
    }
  }
  return live
}

// ── 3. History start + ProcessValues density ────────────────────────────────
async function historyStart(fqn) {
  const until = new Date()
  const since30 = new Date(until.getTime() - 30 * 24 * 3600 * 1000)
  const f1 = `FQN eq '${fqn}' and DateTime ge 2026-01-01T00:00:00Z`
  const first = await getPaged(`${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(f1)}&$orderby=DateTime&$top=1`, 1)
  const f2 = `FQN eq '${fqn}' and DateTime ge ${since30.toISOString()} and DateTime le ${until.toISOString()}`
  const rows = await getPaged(`${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(f2)}&$orderby=DateTime`)
  const byDay = new Map()
  for (const r of rows) byDay.set(r.DateTime.slice(0, 10), (byDay.get(r.DateTime.slice(0, 10)) || 0) + 1)
  console.log(`\n  ${fqn}`)
  console.log(`    firstEver=${first[0]?.DateTime ?? 'NONE (nothing since 2026-01-01)'} (v=${JSON.stringify(first[0]?.Value)})`)
  console.log(`    last30d: ProcessValues samples=${rows.length}`)
  console.log(`    perDay: ${[...byDay.entries()].map(([d, n]) => `${d.slice(5)}:${n}`).join(' ') || '(none)'}`)
}

// ── 4. AnalogSummary density (last hour, minutely) ──────────────────────────
async function densityCheck(fqn) {
  const until = new Date()
  const since = new Date(until.getTime() - 3600 * 1000)
  const rows = await analogSummary(fqn, since, until, 60000)
  if (!rows.length) { console.log(`  ✗ ${fqn.padEnd(55)} no minutely buckets in the last hour`); return }
  const total = rows.reduce((s, r) => s + (r.Count || 0), 0)
  console.log(`  ✓ ${fqn.padEnd(55)} buckets=${rows.length} samples=${total} (~${Math.round(total / rows.length)}/min) first=${rows[0].First} last=${rows[rows.length - 1].Last}`)
}

// ── 5. Totalizer behavior over 48 h ─────────────────────────────────────────
async function totalizerBehavior(totalFqn) {
  console.log(`\n=== 5. TOTALIZER BEHAVIOR — ${totalFqn}, hourly over 48 h ===`)
  const until = new Date()
  const since = new Date(until.getTime() - 48 * 3600 * 1000)
  const rows = await analogSummary(totalFqn, since, until, 3600000)
  if (!rows.length) { console.log('  no hourly buckets — cannot assess'); return null }
  let resets = 0, decreases = 0, prevLast = null, changed = false
  for (const r of rows) {
    if (prevLast != null && r.First != null && r.First < prevLast - 0.001) {
      decreases++
      if (r.Minimum != null && r.Minimum < prevLast * 0.1) resets++
    }
    if (r.First !== r.Last) changed = true
    console.log(`  ${r.StartDateTime}  first=${fmt(r.First)} last=${fmt(r.Last)} min=${fmt(r.Minimum)} max=${fmt(r.Maximum)} n=${r.Count}`)
    prevLast = r.Last ?? prevLast
  }
  if (!changed) console.log('  ⚠ FROZEN REGISTER — value never changed across the entire 48 h window')
  console.log(`  verdict: ${resets ? `${resets} RESET(s) observed` : decreases ? `${decreases} decrease(s) (rollback/noise?)` : 'monotonic non-decreasing — lifetime odometer (matches "resettable but not resetting yet")'}`)

  console.log('\n  cross-reference transitions in the same window:')
  for (const fqn of [RUNMODE_TAG, ...SEL1_TAGS]) {
    const f = `FQN eq '${fqn}' and DateTime ge ${since.toISOString()}`
    const t = await getPaged(`${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(f)}&$orderby=DateTime`, 2000)
    const trans = t.filter((r, i) => i > 0 && r.Value !== t[i - 1].Value)
    console.log(`    ${fqn.padEnd(48)} rows=${t.length} transitions=${trans.length}${trans.length ? ' → ' + trans.slice(0, 6).map(r => `${r.DateTime.slice(5, 16)}=${r.Value}`).join(', ') : ''}`)
  }
  return rows
}

// ── 6. Units plausibility over the busiest hour ─────────────────────────────
async function unitsCheck(flowFqn, totalFqn, hourly) {
  console.log(`\n=== 6. UNITS PLAUSIBILITY — busiest hour ===`)
  const flowHours = await (async () => {
    const until = new Date()
    const since = new Date(until.getTime() - 48 * 3600 * 1000)
    return analogSummary(flowFqn, since, until, 3600000)
  })()
  const busiest = flowHours.filter(r => r.Average != null).sort((a, b) => b.Average - a.Average)[0]
  if (!busiest || !busiest.Average) { console.log('  no non-zero flow hour found in 48 h — run this during production'); return }
  const since = new Date(busiest.StartDateTime)
  const until = new Date(since.getTime() + 3600 * 1000)
  console.log(`  window: ${since.toISOString()} .. ${until.toISOString()} (avg flow ${fmt(busiest.Average)})`)

  // Integrate flow from minutely Averages (NOT the Integral field):
  //   per-minute rate (GPM/lpm): volume = Σ (avg × 1 min)
  //   per-hour rate (gph/lph):   volume = Σ (avg × 1/60 h)
  const mins = await analogSummary(flowFqn, since, until, 60000)
  const integratedPerMin = mins.reduce((s, r) => s + (r.Average || 0), 0)
  const integrated = integratedPerMin / 60
  const tot = hourly?.find(r => r.StartDateTime === busiest.StartDateTime)
    || (await analogSummary(totalFqn, since, until, 3600000))[0]
  const totDelta = tot && tot.Last != null && tot.First != null ? tot.Last - tot.First : null
  console.log(`  totalizer Δ over window:            ${fmt(totDelta)}`)
  console.log(`  ∫flow if rate is per-MINUTE (GPM):  ${fmt(integratedPerMin)}   (Σ minutelyAvg × 1 min)`)
  console.log(`  ∫flow if rate is per-HOUR:          ${fmt(integrated)}   (Σ minutelyAvg / 60)`)
  console.log(`  → whichever matches the totalizer Δ tells you the rate units; l/min vs GPM needs the EngUnit + a ×3.785 sanity check`)

  for (const fqn of ST_GAL_TAGS) {
    const f = `FQN eq '${fqn}' and DateTime ge ${since.toISOString()} and DateTime le ${until.toISOString()}`
    const rows = await getPaged(`${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(f)}&$orderby=DateTime`, 5000)
    if (rows.length < 2) { console.log(`  ${fqn.padEnd(48)} <2 samples in window`); continue }
    const drop = rows[0].Value - rows[rows.length - 1].Value
    console.log(`  ${fqn.padEnd(48)} start=${fmt(rows[0].Value)} end=${fmt(rows[rows.length - 1].Value)} drop=${fmt(drop)} gal`)
  }
}

function fmt(v) { return v == null ? '—' : Number(v).toFixed(2) }

async function main() {
  if (!BASE_URL || !USERNAME || !PASSWORD) {
    console.error('Missing HISTORIAN_BASE_URL / HISTORIAN_USERNAME / HISTORIAN_PASSWORD in .env')
    process.exit(1)
  }
  console.log(`TR11_FT1140 onboarding probe — ${new Date().toISOString()}`)

  const found = await discover()
  // fold any discovered FT1140/Totalizer FQNs into the candidate lists
  for (const fqn of found.keys()) {
    if (/FT1140/i.test(fqn) && !/Totalizer/i.test(fqn) && !FLOW_CANDIDATES.includes(fqn)) FLOW_CANDIDATES.push(fqn)
    if (/FT1140/i.test(fqn) && /Totalizer/i.test(fqn) && !TOTAL_CANDIDATES.includes(fqn)) TOTAL_CANDIDATES.push(fqn)
  }

  const liveFlow  = await liveCheck(FLOW_CANDIDATES, 'flow meter candidates')
  const liveTotal = await liveCheck(TOTAL_CANDIDATES, 'totalizer candidates')

  // Tags('fqn')/Raw resolves FQNs case-INsensitively, but $filter=FQN eq on
  // ProcessValues/AnalogSummary is case-SENSITIVE — a wrong-case FQN passes
  // the live check yet silently returns zero history. Collapse case-duplicate
  // survivors and prefer the exact catalog casing from discovery.
  const discovered = new Set(found.keys())
  const canon = list => {
    const seen = new Map()
    for (const fqn of list) {
      const k = fqn.toLowerCase()
      if (!seen.has(k) || (discovered.has(fqn) && !discovered.has(seen.get(k)))) seen.set(k, fqn)
    }
    return [...seen.values()].sort((a, b) => (discovered.has(b) ? 1 : 0) - (discovered.has(a) ? 1 : 0))
  }
  const flowFqns = canon(liveFlow)
  const totalFqns = canon(liveTotal)
  console.log(`\n  canonical flow FQN(s):      ${flowFqns.join(', ') || '(none)'}`)
  console.log(`  canonical totalizer FQN(s): ${totalFqns.join(', ') || '(none)'}`)

  if (!liveFlow.length && !liveTotal.length) {
    console.log('\n✗ NO live good-quality form of either tag found. Either the tags are not')
    console.log('  historized yet, or the FQN differs from every candidate above — check the')
    console.log('  discovery output and all-tags.json after `node scripts/discoverTags.js`.')
    return
  }

  console.log('\n=== 3. HISTORY START + ProcessValues DENSITY ===')
  for (const fqn of [...flowFqns, ...totalFqns]) await historyStart(fqn)

  console.log('\n=== 4. ANALOG-SUMMARY DENSITY (minutely, last hour) ===')
  for (const fqn of [...flowFqns, ...totalFqns]) await densityCheck(fqn)

  const hourly = totalFqns.length ? await totalizerBehavior(totalFqns[0]) : null
  if (flowFqns.length && totalFqns.length) await unitsCheck(flowFqns[0], totalFqns[0], hourly)

  console.log('\nDone. Fold the findings into the KEY DISCOVERY header of this script')
  console.log('and the TAGS-map comment in historian/providers/restProvider.js.')
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
