#!/usr/bin/env node
/**
 * Spot-check Fillers 2–6 WO/MES tags.
 * Fetches the most recent value + timestamp for each tag.
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN   = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

const TAG_NAMES = [
  'CurrentWO', 'CurrentWOState', 'CurrentProd', 'CurrentItem',
  'CurrentPctCmplt', 'CurrentSeqNo', 'JobRunning', 'BatchSize',
  'StartJob', 'EndJob', 'NextWO',
  'ProdQty', 'ProdItem', 'ProdLot', 'ProdSubLot', 'ProdBOMPos', 'ProdReasCd',
  'ConsQty', 'ConsItem', 'ConsLot', 'ConsSubLot', 'ConsBomPos', 'ConsReasCd',
  'AddProd', 'AddProdAPI', 'AddCons', 'AddConsAPI',
  'GetJobList', 'GetCurrentJobInfo', 'GetJobBom', 'GetSubLot',
  'FromEntName', 'ToEntName',
]

const FILLERS = [2, 3, 4, 5, 6]

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
        resolve({ status: res.statusCode, data: null })
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

const STALE_MS = 24 * 60 * 60 * 1000

function statusLabel(rec) {
  if (!rec) return 'NO DATA'
  const age = Date.now() - new Date(rec.DateTime).getTime()
  return age < STALE_MS ? 'LIVE' : 'STALE'
}

async function main() {
  if (!BASE_URL) { console.error('HISTORIAN_BASE_URL not set'); process.exit(1) }

  console.log(`\nFillers 2–6 Tag Live Check  —  ${new Date().toLocaleString()}`)

  for (const n of FILLERS) {
    console.log(`\n${'='.repeat(90)}`)
    console.log(`  Filler ${n}`)
    console.log('='.repeat(90))
    console.log(`  ${'Status'.padEnd(10)} ${'Last Value'.padEnd(22)} ${'Last Timestamp'.padEnd(26)} Tag`)
    console.log('  ' + '─'.repeat(86))

    for (const tag of TAG_NAMES) {
      const fqn = `Filler${n}.${tag}`
      try {
        const rec = await latestValue(fqn)
        const st  = statusLabel(rec).padEnd(10)
        const val = String(rec?.Value ?? '—').slice(0, 20).padEnd(22)
        const ts  = rec ? new Date(rec.DateTime).toLocaleString().padEnd(26) : '—'.padEnd(26)
        console.log(`  ${st} ${val} ${ts} ${tag}`)
      } catch (err) {
        console.log(`  ${'ERROR'.padEnd(10)} ${''.padEnd(22)} ${''.padEnd(26)} ${tag}  (${err.message})`)
      }
    }
  }

  console.log('\n' + '='.repeat(90))
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
