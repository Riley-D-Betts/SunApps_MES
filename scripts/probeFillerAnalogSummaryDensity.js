#!/usr/bin/env node
/**
 * KEY DISCOVERY (SD-655): ProcessValues returns only sparse rows for many
 * Filler1 analog tags, but AnalogSummary exposes the full underlying storage
 * (1 Hz for the carton master counters). This probe checks which tags have
 * dense storage via minutely AnalogSummary — including tags that looked
 * "dead" through ProcessValues (Filler_State, speed, good-counts).
 *
 * Windows: a recent production window and one inside the apparent
 * 7/3-7/13 "collection gap" to see whether that gap was real.
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL

const TAGS = [
  'Filler1.Filler_State',
  'Filler1.Filler_Status',
  'Filler1.Main_Drive_Current_Speed',
  'Filler1.g_i_Current_Machine_Speed',
  'Filler1.L1_Carton_Count_Master',
  'Filler1.L2_Carton_Count_Master',
  'Filler1.L1_Carton_Count_Good',
  'Filler1.L2_Carton_Count_Good',
  'Filler1.Carton_Count_Total',
  'Filler1.CIP_Current_Phase',
]

const WINDOWS = [
  ['recent prod', new Date('2026-07-14T06:00:00Z'), new Date('2026-07-14T07:00:00Z')],
  ['inside 7/3-7/13 PV-gap', new Date('2026-07-08T09:00:00Z'), new Date('2026-07-08T10:00:00Z')],
]

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

async function minutely(fqn, since, until) {
  const filter = `FQN eq '${fqn}' and StartDateTime ge ${since.toISOString()} and EndDateTime le ${until.toISOString()}`
  let url = `${BASE_URL}/AnalogSummary?$filter=${encodeURIComponent(filter)}&Resolution=60000`
  const all = []
  while (url && all.length < 3000) {
    const data = await ntlmGet(url)
    if (!data) break
    all.push(...(data.value || []))
    url = data['@odata.nextLink'] || null
  }
  return all
}

async function main() {
  for (const [label, since, until] of WINDOWS) {
    console.log(`\n===== window: ${label} (${since.toISOString()} .. ${until.toISOString()}) =====`)
    for (const fqn of TAGS) {
      const rows = await minutely(fqn, since, until)
      if (!rows.length) { console.log(`✗ ${fqn.padEnd(40)} no buckets`); continue }
      const counts = rows.map(r => r.Count)
      const totalCount = counts.reduce((s, c) => s + c, 0)
      const first = rows[0], last = rows[rows.length - 1]
      const delta = last.Last != null && first.First != null ? last.Last - first.First : null
      const mins = rows.map(r => r.Minimum).filter(v => v != null && !isNaN(v))
      const maxs = rows.map(r => r.Maximum).filter(v => v != null && !isNaN(v))
      console.log(`✓ ${fqn.padEnd(40)} buckets=${rows.length} samples=${totalCount} (~${Math.round(totalCount / rows.length)}/min)  first=${first.First} last=${last.Last} Δ=${delta}  min=${mins.length ? Math.min(...mins) : '—'} max=${maxs.length ? Math.max(...maxs) : '—'}`)
    }
  }
}

main().catch(e => { console.error(e); process.exit(1) })
