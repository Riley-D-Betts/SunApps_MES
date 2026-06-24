/**
 * Watch BlendTank{1A,1B,2A,2B}.CurrentWOState over time and log every
 * transition. Run during a known CIP window to discover what CurrentWOState
 * emits during cleaning (we've only sampled "Running" and "Complete" so far).
 *
 * Usage: node scripts/monitorWOState.js [intervalSec]
 *   intervalSec defaults to 30
 */
const path = require('path')
const dotenv = require('dotenv')
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const httpntlm = require('httpntlm')

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

const INTERVAL_SEC = parseInt(process.argv[2] || '30', 10)
const TANKS = ['BlendTank1A', 'BlendTank1B', 'BlendTank2A', 'BlendTank2B']

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
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`))
      try {
        resolve(JSON.parse(res.body.replace(/^﻿/, '')))
      } catch (e) {
        reject(new Error(`Invalid JSON: ${res.body?.slice(0, 200)}`))
      }
    })
  })
}

async function readWOState(tank) {
  const fqn = `${tank}.CurrentWOState`
  const filter = encodeURIComponent(`FQN eq '${fqn}'`)
  const url = `${BASE_URL}/ProcessValues?$filter=${filter}&$orderby=DateTime%20desc&$top=1`
  const data = await get(url)
  return data.value?.[0]?.Text ?? null
}

async function readNoteString(tank) {
  const fqn = `${tank}.NOTE_STRING`
  const filter = encodeURIComponent(`FQN eq '${fqn}'`)
  const url = `${BASE_URL}/ProcessValues?$filter=${filter}&$orderby=DateTime%20desc&$top=1`
  const data = await get(url)
  return data.value?.[0]?.Text ?? null
}

const observed = new Set()
const last = {}

async function tick() {
  const ts = new Date().toISOString()
  for (const tank of TANKS) {
    try {
      const state = await readWOState(tank)
      observed.add(state)
      if (state !== last[tank]) {
        const note = await readNoteString(tank)
        console.log(`[${ts}] ${tank}: ${last[tank] ?? '(initial)'} → ${state}  (NOTE_STRING="${note ?? ''}")`)
        last[tank] = state
      }
    } catch (e) {
      console.log(`[${ts}] ${tank}: ERROR ${e.message}`)
    }
  }
}

async function main() {
  console.log(`Monitoring CurrentWOState for ${TANKS.join(', ')} every ${INTERVAL_SEC}s. Ctrl-C to stop.\n`)
  await tick()
  setInterval(async () => {
    await tick()
    console.log(`  [observed values so far: ${[...observed].map(s => `"${s}"`).join(', ')}]`)
  }, INTERVAL_SEC * 1000)
}

main().catch(err => console.error('Fatal:', err))
