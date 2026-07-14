#!/usr/bin/env node
/**
 * Probe historization density of every plausible carton-count source on
 * Filler1 (counters + cap photo eye) over the last 7 days, to find one
 * dense enough for throughput/rate math.
 *
 * SUPERSEDED CONCLUSION: this probe reads ProcessValues, which hides dense
 * cyclic storage for analog tags. The counters ARE stored (~1 Hz) and are
 * readable via AnalogSummary — see probeFillerAnalogSummaryDensity.js.
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN   = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

const LOOKBACK_DAYS = 7

const CANDIDATES = [
  // photo eye (discrete — would need every transition stored to count caps)
  'Filler1.g_b_Cap_Detect_Eye',
  'Filler1.g_b_Track_Sensor',
  // PLC-side counters
  'Filler1.g_i_Good_Carton_Count',
  'Filler1.g_i_Good_Carton_Count_Master',
  'Filler1.g_i_Infeed_Carton_Count',
  'Filler1.i_L1_Count_Temp',
  'Filler1.i_L2_Count_Temp',
  'Filler1.One_Shot_Carton_Count',
  'Filler1.Carton_Count_Master',
  // known-sparse reference counters
  'Filler1.Carton_Count_Total',
  'Filler1.L1_Carton_Count_Good',
]

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

async function getPaged(url, cap = 150000) {
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

async function main() {
  const until = new Date()
  const since = new Date(until.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000)
  console.log(`Filler1 count-tag density probe — ${since.toISOString()} .. ${until.toISOString()}\n`)

  for (const fqn of CANDIDATES) {
    const filter = `FQN eq '${fqn}' and DateTime ge ${since.toISOString()} and DateTime le ${until.toISOString()}`
    const rows = await getPaged(`${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime`)
    if (!rows.length) { console.log(`✗ ${fqn} — no rows\n`); continue }

    const nums = rows.map(r => Number(r.Value)).filter(n => !isNaN(n))
    const nulls = rows.filter(r => r.Value === null).length
    let increases = 0, resets = 0, delta = 0, prev = null
    for (const r of rows) {
      const v = Number(r.Value)
      if (r.Value === null || isNaN(v)) { prev = null; continue }
      if (prev !== null) {
        if (v > prev) { increases++; delta += v - prev }
        else if (v < prev) resets++
      }
      prev = v
    }
    const perDay = Math.round(rows.length / LOOKBACK_DAYS)
    console.log(`✓ ${fqn}`)
    console.log(`   samples=${rows.length} (~${perDay}/day)  nulls=${nulls}  min=${nums.length ? Math.min(...nums) : '—'}  max=${nums.length ? Math.max(...nums) : '—'}`)
    console.log(`   increases=${increases}  resets=${resets}  summedΔ=${Math.round(delta)}`)
    console.log(`   first=${rows[0].DateTime}  last=${rows[rows.length - 1].DateTime}\n`)
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
