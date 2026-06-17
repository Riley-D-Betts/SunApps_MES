#!/usr/bin/env node
/**
 * Probe surge-tank OUTFLOW signals for ST81-84.
 *
 * Goal: determine which surge tanks are currently being EMPTIED by a filler
 * (vs. just filling), so we can detect concurrent fill+drain that makes the
 * level-rise arrival calc under-count. Reads the candidate outflow tags found
 * in the tag catalog and prints latest value + age for each.
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN   = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

const TANKS = ['ST81', 'ST82', 'ST83', 'ST84']

// Per-tank suffixes to probe. {N} = tank number 1..4
const SUFFIXES = [
  // Levels (double-prefixed path for the real readings)
  { key: 'MainLevel%',   fqn: 'ThermaRoute.ThermaRoute.{TID}_LT8{N}01' },
  { key: 'MainGal',      fqn: 'ThermaRoute.ThermaRoute.{TID}_LT8{N}01_Gal' },
  { key: 'BalanceLvl',   fqn: 'ThermaRoute.{TID}_LT8{N}66_Status' },
  // Outlet pump (balance tank → fillers) and agitator
  { key: 'OutletPump UP8{N}66', fqn: 'ThermaRoute.{TID}_UP8{N}66_Status' },
  { key: 'Agitator AG8{N}00',   fqn: 'ThermaRoute.{TID}_AG8{N}00_Status' },
  { key: 'LowLvlSwitch LSL',    fqn: 'ThermaRoute.{TID}_LSL8{N}74' },
  // Section filling indicators — candidate "feeding filler/line N" signal
  { key: 'Sec1_Filling', fqn: 'ThermaRoute.{TID}_Sec1_Filling_Indicator' },
  { key: 'Sec2_Filling', fqn: 'ThermaRoute.{TID}_Sec2_Filling_Indicator' },
  { key: 'Sec3_Filling', fqn: 'ThermaRoute.{TID}_Sec3_Filling_Indicator' },
  { key: 'Sec4_Filling', fqn: 'ThermaRoute.{TID}_Sec4_Filling_Indicator' },
  { key: 'Sec5_Filling', fqn: 'ThermaRoute.{TID}_Sec5_Filling_Indicator' },
  // Select filling indicators
  { key: 'Sel1_Filling', fqn: 'ThermaRoute.{TID}_Sel1_Filling_Indicator' },
  { key: 'Sel2_Filling', fqn: 'ThermaRoute.{TID}_Sel2_Filling_Indicator' },
  { key: 'Sel3_Filling', fqn: 'ThermaRoute.{TID}_Sel3_Filling_Indicator' },
  { key: 'Sel4_Filling', fqn: 'ThermaRoute.{TID}_Sel4_Filling_Indicator' },
  { key: 'Sel5_Filling', fqn: 'ThermaRoute.{TID}_Sel5_Filling_Indicator' },
  // Destination routing
  { key: 'Dest1_Primary',   fqn: 'ThermaRoute.{TID}_Dest1_Primary_Indicator' },
  { key: 'Dest1_Secondary', fqn: 'ThermaRoute.{TID}_Dest1_Secondary_Indicator' },
  // Flush states (NOT product outflow — exclude these)
  { key: 'FillerFlush1', fqn: 'ThermaRoute.{TID}_FillerFlush1_Indicator' },
  { key: 'TankFlush1',   fqn: 'ThermaRoute.{TID}_TankFlush1_Indicator' },
  { key: 'LineFlush',    fqn: 'ThermaRoute.{TID}_LineFlush_Indicator' },
  // Context
  { key: 'State',       fqn: 'ThermaRoute.{TID}_State' },
  { key: 'ProductDesc', fqn: 'ThermaRoute.{TID}_ProductDesc' },
  { key: 'Connected',   fqn: 'ThermaRoute.{TID}_Connected' },
  { key: 'FillingOK',   fqn: 'ThermaRoute.{TID}_FillingOK' },
  { key: 'TankEmpty',   fqn: 'ThermaRoute.{TID}_TankEmpty_Indicator' },
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

async function latest(fqn) {
  const filter = `FQN eq '${fqn}'`
  const url = `${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime desc&$top=1`
  const { status, data } = await ntlmGet(url)
  if (status !== 200 || !data?.value?.length) return null
  return data.value[0]
}

function ageStr(rec) {
  if (!rec) return '—'
  const min = (Date.now() - new Date(rec.DateTime).getTime()) / 60000
  if (min < 60) return `${min.toFixed(0)}m ago`
  if (min < 1440) return `${(min / 60).toFixed(1)}h ago`
  return `${(min / 1440).toFixed(1)}d ago`
}

async function main() {
  if (!BASE_URL) { console.error('HISTORIAN_BASE_URL not set'); process.exit(1) }
  console.log(`\nSurge Tank Outflow Probe — ${new Date().toLocaleString()}\n`)

  for (let i = 0; i < TANKS.length; i++) {
    const tid = TANKS[i]
    const n = i + 1
    console.log('='.repeat(78))
    console.log(`  ${tid}`)
    console.log('='.repeat(78))
    for (const s of SUFFIXES) {
      const fqn = s.fqn.replace(/\{TID\}/g, tid).replace(/\{N\}/g, n)
      try {
        const rec = await latest(fqn)
        const v = rec ? String(rec.Text ?? rec.Value ?? '—') : 'NO DATA'
        const key = s.key.replace(/\{N\}/g, n)
        console.log(`  ${key.padEnd(22)} ${v.padEnd(24)} ${ageStr(rec).padEnd(10)} ${fqn}`)
      } catch (err) {
        console.log(`  ${s.key.padEnd(22)} ERROR: ${err.message}`)
      }
    }
    console.log()
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
