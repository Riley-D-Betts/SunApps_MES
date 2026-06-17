#!/usr/bin/env node
/**
 * Time-series correlation: for a surge tank, pull level gallons alongside the
 * Sec / Sel / UP outflow indicators over a window, so we can see which tag goes
 * high exactly when the level is FALLING (= being emptied by a filler).
 */
const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN   = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

const TID = process.argv[2] || 'ST83'
const N = TID.slice(-1)
const HOURS = Number(process.argv[3] || 12)

const TAGS = {
  Gal:  `ThermaRoute.ThermaRoute.${TID}_LT8${N}01_Gal`,
  UP:   `ThermaRoute.${TID}_UP8${N}66_Status`,
  Sec1: `ThermaRoute.${TID}_Sec1_Filling_Indicator`,
  Sec2: `ThermaRoute.${TID}_Sec2_Filling_Indicator`,
  Sec3: `ThermaRoute.${TID}_Sec3_Filling_Indicator`,
  Sec4: `ThermaRoute.${TID}_Sec4_Filling_Indicator`,
  Sec5: `ThermaRoute.${TID}_Sec5_Filling_Indicator`,
  Sel1: `ThermaRoute.${TID}_Sel1_Filling_Indicator`,
  Sel2: `ThermaRoute.${TID}_Sel2_Filling_Indicator`,
  Sel3: `ThermaRoute.${TID}_Sel3_Filling_Indicator`,
  Sel4: `ThermaRoute.${TID}_Sel4_Filling_Indicator`,
  Sel5: `ThermaRoute.${TID}_Sel5_Filling_Indicator`,
}

function ntlmGet(url) {
  return new Promise((resolve, reject) => {
    httpntlm.get({ url, domain: DOMAIN, username: USERNAME, password: PASSWORD,
      headers: { Accept: 'application/json' } }, (err, res) => {
      if (err) return reject(err)
      try { resolve({ status: res.statusCode, data: JSON.parse(res.body.replace(/^﻿/, '')) }) }
      catch { resolve({ status: res.statusCode, data: null }) }
    })
  })
}

async function series(fqn, since) {
  const filter = `FQN eq '${fqn}' and DateTime ge ${since.toISOString()}`
  const url = `${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime desc&$top=300`
  const { status, data } = await ntlmGet(url)
  if (status !== 200) return []
  return (data?.value ?? []).map(r => ({ t: new Date(r.DateTime).getTime(), v: Number(r.Value) }))
}

// nearest value at-or-before time t
function at(arr, t) {
  let best = null
  for (const r of arr) if (r.t <= t && (!best || r.t > best.t)) best = r
  return best ? best.v : null
}

async function main() {
  const since = new Date(Date.now() - HOURS * 3600 * 1000)
  const data = {}
  for (const [k, fqn] of Object.entries(TAGS)) data[k] = await series(fqn, since)

  // Sample the Gal track (the one that moves continuously) as the timeline
  const galTrack = (data.Gal || []).slice().sort((a, b) => a.t - b.t)
  console.log(`\n${TID} outflow correlation — last ${HOURS}h (${galTrack.length} level samples)\n`)
  console.log(`  ${'time'.padEnd(20)} ${'Gal'.padEnd(9)} ${'dGal'.padEnd(8)} UP  Sec(1-5)  Sel(1-5)`)
  let prev = null
  for (const g of galTrack) {
    const ts = new Date(g.t).toLocaleString()
    const d = prev == null ? 0 : g.v - prev
    prev = g.v
    const sec = [1,2,3,4,5].map(i => at(data[`Sec${i}`], g.t) ?? '-').join('')
    const sel = [1,2,3,4,5].map(i => at(data[`Sel${i}`], g.t) ?? '-').join('')
    const up = at(data.UP, g.t) ?? '-'
    const flag = d < -5 ? ' <-- DRAINING' : (d > 5 ? ' (filling)' : '')
    console.log(`  ${ts.padEnd(20)} ${g.v.toFixed(0).padEnd(9)} ${d.toFixed(0).padEnd(8)} ${String(up).padEnd(3)} ${sec.padEnd(9)} ${sel}${flag}`)
  }
}
main().catch(e => { console.error('Fatal:', e); process.exit(1) })
