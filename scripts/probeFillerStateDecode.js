#!/usr/bin/env node
/**
 * Decode the Filler1.Filler_State enum using dense AnalogSummary data
 * (1 sample/min — ProcessValues hides this). Sweeps a week minutely and
 * cross-tabulates state value vs the mode-bit classification
 * (RunMode/CIP_Mode_Enable/CIPRunning/SIPRunning) per minute.
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL

const SINCE = new Date(process.argv[2] ? `${process.argv[2]}T00:00:00-06:00` : '2026-07-06T00:00:00-06:00')
const UNTIL = new Date(SINCE.getTime() + 7 * 24 * 3600 * 1000)

function ntlmGet(url) {
  return new Promise((resolve, reject) => {
    httpntlm.get({
      url,
      domain: process.env.HISTORIAN_DOMAIN || '',
      username: process.env.HISTORIAN_USERNAME,
      password: process.env.HISTORIAN_PASSWORD,
      headers: { Accept: 'application/json' },
    }, (err, res) => {
      if (err) return reject(err)
      try { resolve(JSON.parse(res.body.replace(/^﻿/, ''))) }
      catch { resolve(null) }
    })
  })
}

async function getPaged(url, cap = 60000) {
  const all = []
  let next = url
  while (next && all.length < cap) {
    const data = await ntlmGet(next)
    if (!data) break
    all.push(...(data.value || []))
    next = data['@odata.nextLink'] || null
  }
  return all
}

async function minutelyFirst(fqn) {
  const filter = `FQN eq '${fqn}' and StartDateTime ge ${SINCE.toISOString()} and EndDateTime le ${UNTIL.toISOString()}`
  const rows = await getPaged(`${BASE_URL}/AnalogSummary?$filter=${encodeURIComponent(filter)}&Resolution=60000`)
  const map = new Map()
  for (const r of rows) map.set(r.StartDateTime, r.First)
  return map
}

async function processSeries(fqn) {
  const filter = `FQN eq '${fqn}' and DateTime ge ${SINCE.toISOString()} and DateTime le ${UNTIL.toISOString()}`
  const rows = await getPaged(`${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime`)
  return rows.map(r => ({ t: new Date(r.DateTime).getTime(), v: r.Value }))
}

function stepAt(s, t) {
  let v = null
  for (const p of s) { if (p.t <= t) v = p.v; else break }
  return v
}

async function main() {
  console.log(`Filler_State decode — ${SINCE.toISOString()} .. ${UNTIL.toISOString()}\n`)

  const [state, status] = await Promise.all([
    minutelyFirst('Filler1.Filler_State'),
    minutelyFirst('Filler1.Filler_Status'),
  ])
  console.log(`state minutes=${state.size}  status minutes=${status.size}`)

  const [run, cipM, cipR, sipR] = await Promise.all([
    processSeries('Filler1.CI_To_Proc.RunMode'),
    processSeries('Filler1.CIP_Mode_Enable'),
    processSeries('Filler1.CI_To_Proc.CIPRunning'),
    processSeries('Filler1.CI_To_Proc.SIPRunning'),
  ])

  // cross-tab: state value × mode-bit category, minute by minute
  const crosstab = new Map()   // `state|cat` -> minutes
  const statusTab = new Map()  // `status|cat` -> minutes
  for (const [ts, sv] of state.entries()) {
    const t = new Date(ts).getTime()
    const r = stepAt(run, t), cm = stepAt(cipM, t), cr = stepAt(cipR, t), sr = stepAt(sipR, t)
    let cat
    if (r === null && cm === null && cr === null && sr === null) cat = 'unknown'
    else if (Number(r) === 1) cat = 'runtime'
    else if (Number(cm) === 1 || Number(cr) === 1 || Number(sr) === 1) cat = 'cip'
    else cat = 'idle'
    const k = `state=${sv} × ${cat}`
    crosstab.set(k, (crosstab.get(k) || 0) + 1)
    const sv2 = status.get(ts)
    const k2 = `status=${sv2} × ${cat}`
    statusTab.set(k2, (statusTab.get(k2) || 0) + 1)
  }

  console.log('\n== Filler_State × mode-bit category (minutes) ==')
  for (const [k, n] of [...crosstab.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(28)} ${n} min  (${(n / 60).toFixed(1)}h)`)
  }
  console.log('\n== Filler_Status × mode-bit category (minutes) ==')
  for (const [k, n] of [...statusTab.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${k.padEnd(28)} ${n} min  (${(n / 60).toFixed(1)}h)`)
  }
}

main().catch(e => { console.error(e); process.exit(1) })
