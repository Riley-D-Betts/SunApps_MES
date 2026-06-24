#!/usr/bin/env node
/**
 * For each of the 33 WO tags on Fillers 2–6, find the last time
 * the value actually changed (i.e. differs from the current value).
 * Walks back through Historian history in pages until a change is found
 * or we hit the lookback limit.
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
  'AddCons', 'AddConsAPI', 'AddProd', 'AddProdAPI', 'BatchSize',
  'ConsBomPos', 'ConsItem', 'ConsLot', 'ConsQty', 'ConsReasCd', 'ConsSubLot',
  'CurrentItem', 'CurrentPctCmplt', 'CurrentProd', 'CurrentSeqNo',
  'CurrentWO', 'CurrentWOState', 'EndJob', 'FromEntName',
  'GetCurrentJobInfo', 'GetJobBom', 'GetJobList', 'GetSubLot',
  'JobRunning', 'NextWO', 'ProdBOMPos', 'ProdItem', 'ProdLot',
  'ProdQty', 'ProdReasCd', 'ProdSubLot', 'StartJob', 'ToEntName',
]

const FILLERS = [2, 3, 4, 5, 6]
// How far back to search
const LOOKBACK_DAYS = 90

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

// Fetch up to `top` most-recent values for a tag since a cutoff date
async function fetchRecent(fqn, since, top = 500) {
  const filter = `FQN eq '${fqn}' and DateTime ge ${since.toISOString()}`
  const url = `${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime desc&$top=${top}`
  const { status, data } = await ntlmGet(url)
  if (status !== 200 || !data?.value) return []
  return data.value
}

async function findLastChange(fqn, since) {
  const records = await fetchRecent(fqn, since, 500)
  if (records.length === 0) return { lastChange: null, currentValue: null, totalRecords: 0, neverChanged: false }

  const currentValue = records[0].Value
  const currentTs    = records[0].DateTime

  // Walk from newest → oldest, find first record where value differs
  for (let i = 1; i < records.length; i++) {
    if (records[i].Value !== currentValue) {
      return {
        lastChange:    records[i - 1].DateTime,  // last record before the change point
        changedFrom:   records[i].Value,
        changedTo:     currentValue,
        currentValue,
        currentTs,
        totalRecords:  records.length,
        neverChanged:  false,
      }
    }
  }

  // All 500 records had the same value — never changed in our window
  return {
    lastChange:   null,
    currentValue,
    currentTs,
    totalRecords: records.length,
    neverChanged: true,
  }
}

function fmt(val) {
  if (val === null || val === undefined) return '—'
  return String(val).slice(0, 24)
}

async function main() {
  if (!BASE_URL) { console.error('HISTORIAN_BASE_URL not set'); process.exit(1) }

  const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  console.log(`\nLast value change — Fillers 2–6  (lookback: ${LOOKBACK_DAYS} days, since ${since.toLocaleDateString()})`)
  console.log(`Run at: ${new Date().toLocaleString()}\n`)

  // Collect all results then print a summary
  const results = []

  for (const n of FILLERS) {
    for (const tag of TAG_NAMES) {
      const fqn = `Filler${n}.${tag}`
      process.stdout.write(`  checking ${fqn} ...          \r`)
      try {
        const r = await findLastChange(fqn, since)
        results.push({ fqn, n, tag, ...r })
      } catch (err) {
        results.push({ fqn, n, tag, error: err.message })
      }
    }
  }

  // ── Tags that DID change ──────────────────────────────────────────────────
  const changed = results.filter(r => r.lastChange)
  // ── Tags that never changed in window ────────────────────────────────────
  const flat    = results.filter(r => r.neverChanged)
  // ── Tags with no data ────────────────────────────────────────────────────
  const noData  = results.filter(r => !r.error && r.totalRecords === 0)
  // ── Errors ───────────────────────────────────────────────────────────────
  const errors  = results.filter(r => r.error)

  console.log('\n' + '='.repeat(90))
  if (changed.length > 0) {
    console.log(`\n  TAGS THAT CHANGED  (${changed.length})`)
    console.log('  ' + '─'.repeat(86))
    console.log(`  ${'Tag'.padEnd(36)} ${'Last Change'.padEnd(24)} ${'From'.padEnd(14)} ${'To'.padEnd(14)}`)
    console.log('  ' + '─'.repeat(86))
    for (const r of changed) {
      const ts = new Date(r.lastChange).toLocaleString().padEnd(24)
      console.log(`  ${r.fqn.padEnd(36)} ${ts} ${fmt(r.changedFrom).padEnd(14)} ${fmt(r.changedTo).padEnd(14)}`)
    }
  }

  console.log(`\n  FLAT / NEVER CHANGED in ${LOOKBACK_DAYS}-day window  (${flat.length})`)
  console.log('  ' + '─'.repeat(86))
  console.log(`  ${'Tag'.padEnd(36)} ${'Records'.padEnd(10)} ${'Current Value'.padEnd(20)} Since (approx)`)
  console.log('  ' + '─'.repeat(86))
  for (const r of flat) {
    const since = r.currentTs ? new Date(r.currentTs).toLocaleString() : '—'
    console.log(`  ${r.fqn.padEnd(36)} ${String(r.totalRecords).padEnd(10)} ${fmt(r.currentValue).padEnd(20)} ${since}`)
  }

  if (noData.length > 0) {
    console.log(`\n  NO DATA in window  (${noData.length})`)
    noData.forEach(r => console.log(`    ${r.fqn}`))
  }

  if (errors.length > 0) {
    console.log(`\n  ERRORS  (${errors.length})`)
    errors.forEach(r => console.log(`    ${r.fqn}: ${r.error}`))
  }

  console.log('\n' + '='.repeat(90))
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
