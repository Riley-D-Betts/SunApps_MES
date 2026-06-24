#!/usr/bin/env node
/**
 * Pull last 2 hours of process values for key tags on Fillers 3, 4, 6
 * to see if Historian is recording job activity at all.
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN   = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

const FILLERS = [3, 4, 6]
const KEY_TAGS = ['JobRunning', 'CurrentWO', 'CurrentProd', 'ProdQty', 'BatchSize']

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

async function recentValues(fqn, since) {
  const filter = `FQN eq '${fqn}' and DateTime ge ${since.toISOString()}`
  const url = `${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime desc&$top=20`
  const { status, data } = await ntlmGet(url)
  if (status !== 200) return []
  return data?.value ?? []
}

async function main() {
  if (!BASE_URL) { console.error('HISTORIAN_BASE_URL not set'); process.exit(1) }

  const since = new Date(Date.now() - 2 * 60 * 60 * 1000)
  console.log(`\nFiller 3/4/6 Activity — last 2 hours (since ${since.toLocaleString()})`)
  console.log(`Check time: ${new Date().toLocaleString()}\n`)

  for (const n of FILLERS) {
    console.log('='.repeat(70))
    console.log(`  Filler ${n}`)
    console.log('='.repeat(70))

    for (const tag of KEY_TAGS) {
      const fqn = `Filler${n}.${tag}`
      const rows = await recentValues(fqn, since)
      if (rows.length === 0) {
        console.log(`  ${tag.padEnd(20)} — no records in last 2 hours`)
      } else {
        console.log(`  ${tag.padEnd(20)} ${rows.length} record(s):`)
        rows.forEach(r => {
          const ts  = new Date(r.DateTime).toLocaleString()
          const val = String(r.Value ?? '—')
          console.log(`    ${ts}  →  ${val}`)
        })
      }
    }
    console.log()
  }
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
