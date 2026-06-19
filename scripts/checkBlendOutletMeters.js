/**
 * Quick check: are the blend-tank outlet flow meters (BT*100FT) actively
 * logging in Historian? Pulls the latest ProcessValue for each.
 *
 * Usage: node scripts/checkBlendOutletMeters.js
 */
const path = require('path')
const dotenv = require('dotenv')
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const httpntlm = require('httpntlm')

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

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

async function getCurrentValue(fqn) {
  const filter = encodeURIComponent(`FQN eq '${fqn}'`)
  const url = `${BASE_URL}/ProcessValues?$filter=${filter}&$orderby=DateTime%20desc&$top=1`
  const data = await get(url)
  return data.value?.[0] || null
}

async function main() {
  const meters = [
    'BlendTank1A.BT1A_100FT_SCL_GPM',
    'BlendTank1A.BT1B_100FT_SCL_GPM',
    'BlendTank2B.BT2A_100FT_SCL_GPM',
    'BlendTank2B.BT2B_100FT_SCL_GPM',
    'BlendTank2B.BTCA_100FT_SCL_GPM',
  ]

  console.log('\n=== Blend-tank outlet flow meters (SCL_GPM) — latest logged value ===')
  for (const fqn of meters) {
    try {
      const pv = await getCurrentValue(fqn)
      if (!pv) {
        console.log(`  ${fqn}: NO DATA`)
      } else {
        console.log(`  ${fqn}: ${pv.Value} GPM  (Quality=${pv.Quality ?? '?'}, Time=${pv.DateTime})`)
      }
    } catch (e) {
      console.log(`  ${fqn}: ERROR — ${e.message}`)
    }
  }
  console.log('\nDone.')
}

main().catch(err => console.error('Fatal:', err))
