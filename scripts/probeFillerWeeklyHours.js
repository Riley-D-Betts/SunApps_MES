#!/usr/bin/env node
/**
 * Prototype the "filler hours" weekly aggregation for Filler 1 using the
 * actively-historized mode bits (Filler_State is not reliably collected):
 *
 *   Runtime  = CI_To_Proc.RunMode == 1        (highest priority; Auto_Sanitize
 *              stays ACTIVE during production so it must NOT map to CIP)
 *   CIP      = CIP_Mode_Enable OR CIPRunning OR SIPRunning
 *   Idle     = everything else
 *   Unknown  = collection gaps (null markers)
 *
 * Window: last completed report week Mon Jul 6 .. Sun Jul 12 2026 (UTC-ish
 * plant time — probe uses America/Boise offset -06:00).
 * Cross-check: carton counters delta vs runtime -> effective CPM vs 125 set speed.
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN   = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

// plant-local week (MDT, UTC-6): pass Monday as argv[2], default 2026-07-06
const monday = process.argv[2] || '2026-07-06'
const SINCE = new Date(`${monday}T00:00:00-06:00`)
const UNTIL = new Date(SINCE.getTime() + 7 * 24 * 3600 * 1000)

const TAGS = {
  run:      'Filler1.CI_To_Proc.RunMode',
  cipMode:  'Filler1.CIP_Mode_Enable',
  cipRun:   'Filler1.CI_To_Proc.CIPRunning',
  sipRun:   'Filler1.CI_To_Proc.SIPRunning',
  sanitize: 'Filler1.Auto_Sanitize_Mode',
}
const COUNTERS = ['Filler1.L1_Carton_Count_Good', 'Filler1.L2_Carton_Count_Good', 'Filler1.Carton_Count_Total']

function ntlmGet(url) {
  return new Promise((resolve, reject) => {
    httpntlm.get({
      url, domain: DOMAIN, username: USERNAME, password: PASSWORD,
      headers: { Accept: 'application/json' },
    }, (err, res) => {
      if (err) return reject(err)
      try { resolve({ status: res.statusCode, data: JSON.parse(res.body.replace(/^﻿/, '')) }) }
      catch { resolve({ status: res.statusCode, data: null }) }
    })
  })
}

async function getPaged(url, cap = 200000) {
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

async function series(fqn) {
  const filter = `FQN eq '${fqn}' and DateTime ge ${SINCE.toISOString()} and DateTime le ${UNTIL.toISOString()}`
  const rows = await getPaged(`${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime`)
  return rows.map(r => ({ t: new Date(r.DateTime).getTime(), v: r.Value }))
}

// value of a step series at time t (last sample <= t), null if before first sample
function stepAt(s, t) {
  let v = null
  for (const p of s) { if (p.t <= t) v = p.v; else break }
  return v
}

function hours(ms) { return ms / 3600000 }

async function main() {
  console.log(`Filler1 weekly hours prototype — ${SINCE.toISOString()} .. ${UNTIL.toISOString()}\n`)

  const s = {}
  for (const [k, fqn] of Object.entries(TAGS)) {
    s[k] = await series(fqn)
    console.log(`  ${fqn}: ${s[k].length} samples`)
  }

  // merge all change timestamps into one timeline
  const stamps = new Set([SINCE.getTime(), UNTIL.getTime()])
  for (const k of Object.keys(s)) for (const p of s[k]) stamps.add(p.t)
  const times = [...stamps].sort((a, b) => a - b).filter(t => t >= SINCE.getTime() && t <= UNTIL.getTime())

  const totals = { runtime: 0, cip: 0, idle: 0, unknown: 0 }
  const segments = []
  for (let i = 0; i < times.length - 1; i++) {
    const t0 = times[i], t1 = times[i + 1]
    const mid = t0 // step values change exactly at stamps; evaluate at segment start
    const run  = stepAt(s.run, mid)
    const cipM = stepAt(s.cipMode, mid)
    const cipR = stepAt(s.cipRun, mid)
    const sipR = stepAt(s.sipRun, mid)
    const san  = stepAt(s.sanitize, mid)

    let cat
    if (run === null && cipM === null && cipR === null && sipR === null) cat = 'unknown'
    else if (Number(run) === 1) cat = 'runtime'
    else if (Number(cipM) === 1 || Number(cipR) === 1 || Number(sipR) === 1) cat = 'cip'
    else cat = 'idle'
    void san

    totals[cat] += t1 - t0
    const last = segments[segments.length - 1]
    if (last && last.cat === cat) last.end = t1
    else segments.push({ cat, start: t0, end: t1 })
  }

  console.log(`\n== weekly totals ==`)
  const weekH = hours(UNTIL - SINCE)
  let sum = 0
  for (const [k, ms] of Object.entries(totals)) {
    sum += ms
    console.log(`  ${k.padEnd(8)} ${hours(ms).toFixed(2).padStart(8)} h   ${(100 * ms / (UNTIL - SINCE)).toFixed(1)}%`)
  }
  console.log(`  ${'TOTAL'.padEnd(8)} ${hours(sum * 1).toFixed(2).padStart(8)} h   (week = ${weekH} h)`)

  console.log(`\n== merged segments (${segments.length}) ==`)
  for (const seg of segments) {
    console.log(`  ${new Date(seg.start).toISOString()}  ${seg.cat.padEnd(8)} ${hours(seg.end - seg.start).toFixed(2)} h`)
  }

  // carton counters: sum of increases (reset-aware) + effective rate
  console.log(`\n== carton counters ==`)
  for (const fqn of COUNTERS) {
    const c = await series(fqn)
    if (!c.length) { console.log(`  ${fqn}: no data`); continue }
    let produced = 0, prev = null
    for (const p of c) {
      const v = Number(p.v)
      if (p.v === null || isNaN(v)) continue
      if (prev !== null && v >= prev) produced += v - prev
      prev = v
    }
    console.log(`  ${fqn}: samples=${c.length} producedΔ=${Math.round(produced)}`)
  }
  const runtimeMin = totals.runtime / 60000
  console.log(`\n  runtime minutes = ${runtimeMin.toFixed(0)} — at 125 CPM set speed that is capacity ${Math.round(runtimeMin * 125)} cartons`)

  console.log('\nDone.')
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
