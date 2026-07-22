#!/usr/bin/env node
/**
 * Decode the Filler1.Filler_State numeric enum empirically.
 *
 * 1. StateSummary over the lookback window -> distinct state values + time-in-state.
 * 2. ProcessValues change log -> chronological state segments.
 * 3. For each distinct state, sample its longest segments and correlate:
 *      - Filler1.Main_Drive_Current_Speed (AnalogSummary avg/max, CPM)
 *      - Filler1.g_b_CIP_Active (value at segment midpoint)
 *      - Filler1.Carton_Count_Total (First/Last delta -> producing?)
 *    to infer a label (Running / CIP / Idle / ...).
 * 4. Also dump Filler1.Filler_Status StateSummary totals for reference.
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN   = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

const LOOKBACK_DAYS = 14
const STATE_TAG   = 'Filler1.Filler_State'
const STATUS_TAG  = 'Filler1.Filler_Status'
const SPEED_TAG   = 'Filler1.Main_Drive_Current_Speed'
const CIP_TAG     = 'Filler1.g_b_CIP_Active'
const COUNT_TAG   = 'Filler1.Carton_Count_Total'
const SEGMENT_SAMPLES_PER_STATE = 3

function ntlmGet(url) {
  return new Promise((resolve, reject) => {
    httpntlm.get({
      url,
      domain:   DOMAIN,
      username: USERNAME,
      password: PASSWORD,
      headers: { Accept: 'application/json' },
    }, (err, res) => {
      if (err) return reject(err)
      try {
        resolve({ status: res.statusCode, data: JSON.parse(res.body.replace(/^﻿/, '')) })
      } catch {
        resolve({ status: res.statusCode, data: null, raw: res.body?.slice(0, 300) })
      }
    })
  })
}

async function getPaged(url, cap = 200000) {
  const all = []
  let next = url
  while (next && all.length < cap) {
    const { status, data, raw } = await ntlmGet(next)
    if (status !== 200 || !data) {
      console.log(`   [warn] HTTP ${status} for ${next.slice(0, 140)}... ${raw ? 'body: ' + raw : ''}`)
      break
    }
    all.push(...(data.value || []))
    next = data['@odata.nextLink'] || null
  }
  return all
}

async function stateSummary(fqn, since, until) {
  const resolution = until.getTime() - since.getTime()   // single bucket = whole window
  const filter = `FQN eq '${fqn}' and StartDateTime ge ${since.toISOString()} and EndDateTime le ${until.toISOString()}`
  const url = `${BASE_URL}/StateSummary?$filter=${encodeURIComponent(filter)}&Resolution=${resolution}`
  return getPaged(url)
}

async function processValues(fqn, since, until, cap) {
  const filter = `FQN eq '${fqn}' and DateTime ge ${since.toISOString()} and DateTime le ${until.toISOString()}`
  const url = `${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime`
  return getPaged(url, cap)
}

async function analogSummaryOne(fqn, since, until) {
  const resolution = Math.max(until.getTime() - since.getTime(), 1000)
  const filter = `FQN eq '${fqn}' and StartDateTime ge ${since.toISOString()} and EndDateTime le ${until.toISOString()}`
  const url = `${BASE_URL}/AnalogSummary?$filter=${encodeURIComponent(filter)}&Resolution=${resolution}`
  const rows = await getPaged(url, 50)
  return rows[0] || null
}

async function valueAt(fqn, ts) {
  const filter = `FQN eq '${fqn}' and DateTime le ${ts.toISOString()}`
  const url = `${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime desc&$top=1`
  const rows = await getPaged(url, 1)
  return rows[0]?.Value ?? null
}

function hours(ms) { return (ms / 3600000).toFixed(2) }

async function main() {
  if (!BASE_URL) { console.error('HISTORIAN_BASE_URL not set'); process.exit(1) }
  const until = new Date()
  const since = new Date(until.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000)
  console.log(`Filler_State enum probe — window ${since.toISOString()} .. ${until.toISOString()} (${LOOKBACK_DAYS}d)\n`)

  // ---- 1. StateSummary totals ------------------------------------------------
  console.log(`== StateSummary: ${STATE_TAG} ==`)
  const ss = await stateSummary(STATE_TAG, since, until)
  if (!ss.length) {
    console.log('   NO ROWS — StateSummary may not support this analog tag (fall back to ProcessValues segments below)')
  } else {
    console.log(`   ${ss.length} rows; raw sample of first row:`)
    console.log('   ' + JSON.stringify(ss[0]))
    for (const r of ss) {
      const label = r.Value ?? r.State ?? r.StateValue ?? '?'
      const t = r.StateTime ?? r.TotalTime ?? r.Duration ?? null
      console.log(`   state=${JSON.stringify(label)}  timeMs=${t}  (${t != null ? hours(Number(t)) + 'h' : '?'})  pct=${r.PercentInState ?? r.Percent ?? '?'}  count=${r.StateCount ?? r.Count ?? '?'}`)
    }
  }

  // ---- 2. ProcessValues change log -> segments -------------------------------
  console.log(`\n== ProcessValues change log: ${STATE_TAG} ==`)
  const pv = await processValues(STATE_TAG, since, until)
  console.log(`   ${pv.length} raw samples`)
  const segments = []
  for (const r of pv) {
    const v = r.Value
    const t = new Date(r.DateTime).getTime()
    const last = segments[segments.length - 1]
    if (!last || last.value !== v) {
      if (last) last.end = t
      segments.push({ value: v, start: t, end: until.getTime() })
    }
  }
  console.log(`   ${segments.length} segments`)

  const byState = new Map()
  for (const s of segments) {
    const k = String(s.value)
    if (!byState.has(k)) byState.set(k, { totalMs: 0, segs: [] })
    const e = byState.get(k)
    e.totalMs += s.end - s.start
    e.segs.push(s)
  }
  console.log('   time by state (from segments):')
  for (const [k, e] of [...byState.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
    console.log(`     state=${k}  ${hours(e.totalMs)}h  segments=${e.segs.length}`)
  }

  console.log('\n   last 25 transitions:')
  for (const s of segments.slice(-25)) {
    console.log(`     ${new Date(s.start).toISOString()}  -> state ${s.value}  (${hours(s.end - s.start)}h)`)
  }

  // ---- 3. Correlate each state with speed / CIP / carton delta ---------------
  console.log('\n== Correlation per state (longest segments sampled) ==')
  for (const [k, e] of [...byState.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs)) {
    const samples = [...e.segs].sort((a, b) => (b.end - b.start) - (a.end - a.start)).slice(0, SEGMENT_SAMPLES_PER_STATE)
    console.log(`\n   state=${k}  total=${hours(e.totalMs)}h  sampling ${samples.length} longest segment(s):`)
    for (const s of samples) {
      const sStart = new Date(s.start), sEnd = new Date(Math.min(s.end, until.getTime()))
      const mid = new Date((s.start + Math.min(s.end, until.getTime())) / 2)
      let speed = null, cnt = null, cip = null
      try { speed = await analogSummaryOne(SPEED_TAG, sStart, sEnd) } catch (err) { console.log(`     speed err: ${err.message}`) }
      try { cnt = await analogSummaryOne(COUNT_TAG, sStart, sEnd) } catch (err) { console.log(`     count err: ${err.message}`) }
      try { cip = await valueAt(CIP_TAG, mid) } catch (err) { console.log(`     cip err: ${err.message}`) }
      const dur = hours(sEnd - sStart)
      const spd = speed ? `avg=${Number(speed.Average).toFixed(1)} max=${Number(speed.Maximum).toFixed(1)} CPM` : 'n/a'
      const delta = cnt && cnt.First != null && cnt.Last != null ? (Number(cnt.Last) - Number(cnt.First)) : 'n/a'
      console.log(`     ${sStart.toISOString()} (${dur}h)  speed[${spd}]  cartonsΔ=${delta}  CIP_Active@mid=${JSON.stringify(cip)}`)
    }
  }

  // ---- 4. Filler_Status reference dump ----------------------------------------
  console.log(`\n== StateSummary: ${STATUS_TAG} (reference) ==`)
  const ss2 = await stateSummary(STATUS_TAG, since, until)
  if (!ss2.length) console.log('   NO ROWS')
  else {
    console.log('   raw sample: ' + JSON.stringify(ss2[0]))
    for (const r of ss2) {
      const label = r.Value ?? r.State ?? r.StateValue ?? '?'
      const t = r.StateTime ?? r.TotalTime ?? r.Duration ?? null
      console.log(`   status=${JSON.stringify(label)}  timeMs=${t}  (${t != null ? hours(Number(t)) + 'h' : '?'})`)
    }
  }

  console.log('\nDone.')
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
