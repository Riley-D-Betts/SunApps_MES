#!/usr/bin/env node
/**
 * For each key Filler1 tag: find the earliest stored sample (history start)
 * and daily sample counts over the last 30 days, to map historization
 * start dates and collection gaps.
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
  'Filler1.CI_To_Proc.RunMode',
  'Filler1.CI_To_Proc.CIPRunning',
  'Filler1.CI_To_Proc.SIPRunning',
  'Filler1.CIP_Mode_Enable',
  'Filler1.CIP_Current_Phase',
  'Filler1.Auto_Sanitize_Mode',
  'Filler1.Main_Drive_Current_Speed',
  'Filler1.L1_Carton_Count_Good',
  'Filler1.L2_Carton_Count_Good',
  'Filler1.Carton_Count_Total',
  'Filler1.Filler_State',
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

async function main() {
  const until = new Date()
  const since30 = new Date(until.getTime() - 30 * 24 * 3600 * 1000)
  const epoch = new Date('2025-01-01T00:00:00Z')

  for (const fqn of TAGS) {
    // earliest sample on record (since 2025-01-01)
    const f1 = `FQN eq '${fqn}' and DateTime ge ${epoch.toISOString()}`
    const first = await getPaged(`${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(f1)}&$orderby=DateTime&$top=1`, 1)

    // last 30 days daily counts
    const f2 = `FQN eq '${fqn}' and DateTime ge ${since30.toISOString()} and DateTime le ${until.toISOString()}`
    const rows = await getPaged(`${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(f2)}&$orderby=DateTime`)
    const byDay = new Map()
    let nulls = 0
    for (const r of rows) {
      const d = r.DateTime.slice(0, 10)
      byDay.set(d, (byDay.get(d) || 0) + 1)
      if (r.Value === null) nulls++
    }
    const days = [...byDay.entries()].map(([d, n]) => `${d.slice(5)}:${n}`).join(' ')
    console.log(`${fqn}`)
    console.log(`   firstEver=${first[0]?.DateTime ?? 'NONE'} (v=${JSON.stringify(first[0]?.Value)})`)
    console.log(`   last30d: samples=${rows.length} nulls=${nulls}`)
    console.log(`   perDay: ${days || '(none)'}\n`)
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
