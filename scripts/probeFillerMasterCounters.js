#!/usr/bin/env node
/**
 * Evaluate the lifetime cumulative carton counters (Carton_Count_Master,
 * L1/L2_Carton_Count_Master) as a throughput source: dump every sample over
 * the last 30 days to see storage cadence, monotonicity, and staleness, and
 * compute the Jul 6-12 report-week delta for cross-checking against NetSuite
 * (Line 1 = 31,539 cases that week).
 *
 * SUPERSEDED CONCLUSION: ProcessValues shows only ~monthly rows for these
 * tags, but that is a retrieval artifact — the counters are stored at ~1 Hz
 * and fully readable via AnalogSummary. See
 * probeFillerAnalogSummaryDensity.js and services/fillerHoursService.js.
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN   = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

const TAGS = [
  'Filler1.Carton_Count_Master',
  'Filler1.L1_Carton_Count_Master',
  'Filler1.L2_Carton_Count_Master',
]

const DAYS = 30
const WEEK_SINCE = new Date('2026-07-06T00:00:00-06:00')
const WEEK_UNTIL = new Date('2026-07-13T00:00:00-06:00')

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

async function fetchRange(fqn, since, until) {
  const filter = `FQN eq '${fqn}' and DateTime ge ${since.toISOString()} and DateTime le ${until.toISOString()}`
  return getPaged(`${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime`)
}

async function main() {
  const until = new Date()
  const since = new Date(until.getTime() - DAYS * 24 * 3600 * 1000)

  for (const fqn of TAGS) {
    console.log(`\n== ${fqn} — all samples, last ${DAYS}d ==`)
    const rows = await fetchRange(fqn, since, until)
    let prev = null, decreases = 0
    for (const r of rows) {
      const v = Number(r.Value)
      const d = prev !== null && !isNaN(v) ? v - prev : null
      if (d !== null && d < 0) decreases++
      console.log(`   ${r.DateTime}  ${r.Value === null ? 'null' : v}${d !== null ? `   Δ=${d}` : ''}`)
      if (!isNaN(v) && r.Value !== null) prev = v
    }
    console.log(`   (${rows.length} samples, ${decreases} decreases)`)

    // report-week delta: boundary value at week start vs last value before week end
    const wk = await fetchRange(fqn, WEEK_SINCE, WEEK_UNTIL)
    const nums = wk.filter(r => r.Value !== null && !isNaN(Number(r.Value)))
    if (nums.length >= 2) {
      const first = nums[0], last = nums[nums.length - 1]
      console.log(`   Jul 6-12 week: ${first.DateTime} (${first.Value}) .. ${last.DateTime} (${last.Value})  Δ=${Number(last.Value) - Number(first.Value)}`)
    } else {
      console.log(`   Jul 6-12 week: insufficient non-null samples (${nums.length})`)
    }
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
