#!/usr/bin/env node
/**
 * Check which Filler1 state/mode candidate tags are actually historized.
 * For each: recent sample count, distinct values, change points over the
 * last 7 days. Goal: pick the tag set that lets us classify each hour of
 * the week as Running / CIP / Idle / Other for the Machine Efficiency page.
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
  // run / production
  'Filler1.CI_To_Proc.RunMode',
  'Filler1.g_b_RUN_Mode_Enable',
  'Filler1.b_Run_Request',
  'Filler1.b_Run_Permissive',
  'Filler1.Main_Drive_Current_Speed',
  // CIP / SIP / sanitize
  'Filler1.CI_To_Proc.CIPRunning',
  'Filler1.CI_To_Proc.SIPRunning',
  'Filler1.g_b_CIP_Mode',
  'Filler1.CIP_Mode_Enable',
  'Filler1.g_b_SIP_Mode',
  'Filler1.g_b_CIP_SIP_Mode',
  'Filler1.CIP_Current_Phase',
  'Filler1.Auto_Sanitize_Mode',
  'Filler1.g_i_Mode_Status',
  // legacy state enums (verify the 7/3-7/13 gap)
  'Filler1.Filler_State',
  'Filler1.Filler_Status',
  // fault
  'Filler1.b_Main_Drive_Fault',
]

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
        resolve({ status: res.statusCode, data: null })
      }
    })
  })
}

async function getPaged(url, cap = 100000) {
  const all = []
  let next = url
  while (next && all.length < cap) {
    const { status, data } = await ntlmGet(next)
    if (status !== 200 || !data) return { error: `HTTP ${status}`, all }
    all.push(...(data.value || []))
    next = data['@odata.nextLink'] || null
  }
  return { all }
}

async function main() {
  if (!BASE_URL) { console.error('HISTORIAN_BASE_URL not set'); process.exit(1) }
  const until = new Date()
  const since = new Date(until.getTime() - LOOKBACK_DAYS * 24 * 3600 * 1000)
  console.log(`Filler1 mode-bit probe — ${since.toISOString()} .. ${until.toISOString()}\n`)

  for (const fqn of CANDIDATES) {
    const filter = `FQN eq '${fqn}' and DateTime ge ${since.toISOString()} and DateTime le ${until.toISOString()}`
    const url = `${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime`
    const { error, all } = await getPaged(url)
    if (error) { console.log(`✗ ${fqn} — ${error}\n`); continue }
    if (!all.length) { console.log(`✗ ${fqn} — 0 samples in window\n`); continue }

    const values = all.map(r => r.Value)
    const distinct = new Map()
    for (const v of values) distinct.set(String(v), (distinct.get(String(v)) || 0) + 1)
    const changes = []
    for (let i = 1; i < all.length; i++) {
      if (all[i].Value !== all[i - 1].Value) changes.push({ at: all[i].DateTime, from: all[i - 1].Value, to: all[i].Value })
    }
    console.log(`✓ ${fqn}`)
    console.log(`   samples=${all.length}  first=${all[0].DateTime}  last=${all[all.length - 1].DateTime}  current=${JSON.stringify(all[all.length - 1].Value)}`)
    if (distinct.size <= 12) {
      console.log(`   valueCounts=${JSON.stringify(Object.fromEntries(distinct))}  changes=${changes.length}`)
      for (const c of changes.slice(-10)) console.log(`     ${c.at}  ${JSON.stringify(c.from)} -> ${JSON.stringify(c.to)}`)
    } else {
      const nums = values.map(Number).filter(n => !isNaN(n))
      console.log(`   distinct=${distinct.size}  min=${Math.min(...nums)}  max=${Math.max(...nums)}  changes=${changes.length}`)
    }
    console.log()
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
