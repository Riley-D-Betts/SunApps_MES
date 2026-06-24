#!/usr/bin/env node
/**
 * Spot-check Filler 1 production tags.
 * Fetches the most recent value + timestamp for each tag and
 * reports whether it looks live (updated in the last 24 h).
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
  // Carton counts
  { fqn: 'Filler1.L1_Carton_Count_Infeed',         group: 'Carton Counts' },
  { fqn: 'Filler1.L2_Carton_Count_Infeed',         group: 'Carton Counts' },
  { fqn: 'Filler1.Carton_Count_Total_Infeed',      group: 'Carton Counts' },
  { fqn: 'Filler1.L1_Carton_Count_Good',           group: 'Carton Counts' },
  { fqn: 'Filler1.L2_Carton_Count_Good',           group: 'Carton Counts' },
  { fqn: 'Filler1.Carton_Count_Total',             group: 'Carton Counts' },
  { fqn: 'Filler1.L1_Carton_Count_Master',         group: 'Carton Counts' },
  { fqn: 'Filler1.L2_Carton_Count_Master',         group: 'Carton Counts' },
  { fqn: 'Filler1.L1_Carton_Count_Infeed_at_Stop', group: 'Carton Counts' },
  { fqn: 'Filler1.L2_Carton_Count_Infeed_at_Stop', group: 'Carton Counts' },
  { fqn: 'Filler1.Cartons_In_Machine',             group: 'Carton Counts' },
  // Job / run control
  { fqn: 'Filler1.StartJob',             group: 'Job / Run Control' },
  { fqn: 'Filler1.Start_Button_Pressed', group: 'Job / Run Control' },
  { fqn: 'Filler1.StartPB',             group: 'Job / Run Control' },
  // Machine state & speed
  { fqn: 'Filler1.Filler_State',      group: 'Machine State & Speed' },
  { fqn: 'Filler1.Filler_Status',     group: 'Machine State & Speed' },
  { fqn: 'Filler1.Machine_Speed_Dec', group: 'Machine State & Speed' },
  { fqn: 'Filler1.Machine_Speed_Inc', group: 'Machine State & Speed' },
  // Fill volume setpoints
  { fqn: 'Filler1.Fill_Max_Volume', group: 'Fill Volume Setpoints' },
  { fqn: 'Filler1.Fill_Min_Volume', group: 'Fill Volume Setpoints' },
  { fqn: 'Filler1.Fill_HVP_Vol',   group: 'Fill Volume Setpoints' },
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
        const body = res.body.replace(/^﻿/, '')
        resolve({ status: res.statusCode, data: JSON.parse(body) })
      } catch {
        resolve({ status: res.statusCode, data: null, raw: res.body?.slice(0, 200) })
      }
    })
  })
}

async function latestValue(fqn) {
  const filter = `FQN eq '${fqn}'`
  const url = `${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime desc&$top=1`
  const { status, data } = await ntlmGet(url)
  if (status !== 200 || !data?.value?.length) return null
  return data.value[0]
}

const STALE_MS = 24 * 60 * 60 * 1000   // 24 hours

function status(rec) {
  if (!rec) return '  NO DATA '
  const age = Date.now() - new Date(rec.DateTime).getTime()
  if (age < STALE_MS) return '  LIVE     '
  return '  STALE    '
}

async function main() {
  if (!BASE_URL) { console.error('HISTORIAN_BASE_URL not set'); process.exit(1) }

  console.log(`\nFiller 1 Tag Live Check  —  ${new Date().toLocaleString()}`)
  console.log('='.repeat(90))

  let currentGroup = ''

  for (const { fqn, group } of TAGS) {
    if (group !== currentGroup) {
      currentGroup = group
      console.log(`\n  ${group}`)
      console.log('  ' + '─'.repeat(86))
      console.log(`  ${'Status'.padEnd(12)} ${'Last Value'.padEnd(16)} ${'Last Timestamp'.padEnd(28)} Tag`)
      console.log('  ' + '─'.repeat(86))
    }

    try {
      const rec = await latestValue(fqn)
      const st  = status(rec)
      const val = rec ? String(rec.Value ?? '—').padEnd(16) : '—'.padEnd(16)
      const ts  = rec ? new Date(rec.DateTime).toLocaleString().padEnd(28) : '—'.padEnd(28)
      console.log(`  ${st} ${val} ${ts} ${fqn}`)
    } catch (err) {
      console.log(`  ${'  ERROR     '} ${''.padEnd(16)} ${''.padEnd(28)} ${fqn}  (${err.message})`)
    }
  }

  console.log('\n' + '='.repeat(90))
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
