/**
 * Discovery + live values for the VG6* tags Korey listed as blend→UHT flow
 * meters (VG6A012FT, VG6A017FT, VG6B012FT, VG6B017FT, VG6B022FG, VG6A022FT).
 *
 * Our cached all-tags.json only shows these as VG6*_MP_* valve tags, not flow
 * transmitters — so this queries Historian LIVE to (a) discover every tag whose
 * FQN contains each VG6 base, and (b) pull the latest ProcessValue for the ones
 * that look like a reading (FT / GPM / PV / MON / STA / value-ish).
 *
 * Usage: node scripts/checkVg6Tags.js
 */
const path = require('path')
const dotenv = require('dotenv')
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const httpntlm = require('httpntlm')

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

// Bare bases to discover (strip Korey's FT/FG suffix — we want every variant).
const BASES = ['VG6A_012', 'VG6A_017', 'VG6A_022', 'VG6B_012', 'VG6B_017', 'VG6B_022']

function get(url) {
  return new Promise((resolve, reject) => {
    httpntlm.get({
      url,
      domain: DOMAIN,
      username: USERNAME,
      password: PASSWORD,
      headers: { 'Accept': 'application/json' },
    }, (err, res) => {
      if (err) return reject(err)
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}: ${res.body?.slice(0, 300)}`))
      try {
        resolve(JSON.parse(res.body.replace(/^﻿/, '')))
      } catch (e) {
        reject(new Error(`Invalid JSON: ${res.body?.slice(0, 300)}`))
      }
    })
  })
}

async function discoverTags(base) {
  const filter = encodeURIComponent(`contains(FQN,'${base}')`)
  const url = `${BASE_URL}/Tags?$filter=${filter}&$select=FQN,Description,EngUnit,TagType&$top=200`
  const data = await get(url)
  return data.value || []
}

async function getCurrentValue(fqn) {
  const filter = encodeURIComponent(`FQN eq '${fqn}'`)
  const url = `${BASE_URL}/ProcessValues?$filter=${filter}&$orderby=DateTime%20desc&$top=1`
  const data = await get(url)
  return data.value?.[0] || null
}

async function main() {
  for (const base of BASES) {
    console.log(`\n=== ${base}* ===`)
    let tags
    try {
      tags = await discoverTags(base)
    } catch (e) {
      console.log(`  discover ERROR — ${e.message}`)
      continue
    }
    if (!tags.length) {
      console.log('  (no tags found)')
      continue
    }
    tags.sort((a, b) => a.FQN.localeCompare(b.FQN))
    for (const t of tags) {
      let valStr = ''
      try {
        const pv = await getCurrentValue(t.FQN)
        valStr = pv ? `  →  ${pv.Value} (${t.EngUnit || t.TagType}) @ ${pv.DateTime}` : '  →  NO DATA'
      } catch (e) {
        valStr = `  →  ERR ${e.message}`
      }
      const desc = t.Description ? ` — ${t.Description}` : ''
      console.log(`  ${t.FQN} [${t.TagType}]${desc}${valStr}`)
    }
  }
  console.log('\nDone.')
}

main().catch(err => console.error('Fatal:', err))
