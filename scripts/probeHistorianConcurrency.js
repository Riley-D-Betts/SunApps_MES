#!/usr/bin/env node
/**
 * Probe: does the AVEVA Historian 500 under concurrent Raw reads?
 *
 * Hypothesis behind this probe (SD-717 triage of the `*.poll.error` storm):
 * every `*.poll.error` in the event ring is `Historian API 500 on
 * .../Tags('X')/Raw?...` with an EMPTY body, spread across unrelated,
 * known-good tags, and clustered on the cron-alignment seconds. That is the
 * signature of server-side overload, not bad FQNs — and `fillerFlowService.js`
 * already documents "the AVEVA server 500s (empty body) at 5-8 concurrent
 * requests", which is why its AnalogSummary queries run sequentially.
 *
 * RestProvider has no such limit: every status method is a flat
 * `Promise.all(fqns.map(...))`, and four jobs share one provider.
 *
 * Method: read ONE cheap, known-good tag at rising concurrency levels and
 * count non-200s per level. If the failure rate climbs with the level, the
 * server is the constraint and the fix is client-side throttling.
 *
 * LOAD BUDGET — deliberately tiny, this is safe to run against production:
 *   6 levels x 16 requests = 96 tag reads total, with a pause between levels.
 *   One normal equipmentJob tick already fires ~140 tag reads at once, every
 *   5 seconds. This whole probe is less than one tick.
 *
 * Read-only. GETs only. Touches nothing in NetSuite or the DB.
 */
const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN   = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

// A tag that appears in the live error stream, so it is definitely real and
// definitely collected — any failure here is the server, not the FQN.
const TAG = 'MSilo1_LBS.Value'

const LEVELS = [1, 2, 4, 8, 16, 32]
const REQS_PER_LEVEL = 16
const PAUSE_BETWEEN_LEVELS_MS = 2000

function ntlmGet(url) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    httpntlm.get({
      url, domain: DOMAIN, username: USERNAME, password: PASSWORD,
      headers: { Accept: 'application/json' },
    }, (err, res) => {
      const ms = Date.now() - t0
      if (err) return resolve({ ok: false, status: 'ERR', detail: err.message, ms })
      const bodyLen = res.body?.length ?? 0
      resolve({ ok: res.statusCode === 200, status: res.statusCode, bodyLen, ms })
    })
  })
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function runLevel(level) {
  const url = `${BASE_URL}/Tags('${encodeURIComponent(TAG)}')/Raw?$orderby=DateTime%20desc&$top=1`
  const results = []
  // Fire REQS_PER_LEVEL requests in waves of `level` concurrent.
  for (let sent = 0; sent < REQS_PER_LEVEL; sent += level) {
    const n = Math.min(level, REQS_PER_LEVEL - sent)
    results.push(...await Promise.all(Array.from({ length: n }, () => ntlmGet(url))))
  }
  return results
}

function summarize(level, results) {
  const ok = results.filter(r => r.ok).length
  const fails = results.filter(r => !r.ok)
  const byStatus = {}
  for (const f of fails) byStatus[f.status] = (byStatus[f.status] || 0) + 1
  const emptyBody = fails.filter(f => f.bodyLen === 0).length
  const lat = results.map(r => r.ms).sort((a, b) => a - b)
  const p50 = lat[Math.floor(lat.length / 2)]
  const failPct = ((fails.length / results.length) * 100).toFixed(0)

  console.log(
    `  concurrency ${String(level).padStart(2)} | ` +
    `ok ${String(ok).padStart(2)}/${results.length} | ` +
    `failed ${String(fails.length).padStart(2)} (${failPct.padStart(3)}%) ` +
    `${Object.keys(byStatus).length ? JSON.stringify(byStatus) : ''}` +
    `${emptyBody ? ` emptyBody=${emptyBody}` : ''} | ` +
    `p50 ${p50}ms  max ${lat[lat.length - 1]}ms`
  )
  return { level, ok, failed: fails.length, failPct: Number(failPct) }
}

async function main() {
  if (!BASE_URL || !USERNAME) {
    console.error('Missing HISTORIAN_BASE_URL / HISTORIAN_USERNAME in .env')
    process.exit(1)
  }
  console.log(`\nHistorian concurrency probe — ${BASE_URL}`)
  console.log(`tag: ${TAG}   levels: ${LEVELS.join(', ')}   ${REQS_PER_LEVEL} reads per level`)
  console.log(`total load: ${LEVELS.length * REQS_PER_LEVEL} reads (< one equipmentJob tick)\n`)

  const summary = []
  for (const level of LEVELS) {
    summary.push(summarize(level, await runLevel(level)))
    await sleep(PAUSE_BETWEEN_LEVELS_MS)
  }

  console.log('\n=== verdict ===')
  const clean = summary.filter(s => s.failed === 0).map(s => s.level)
  const dirty = summary.filter(s => s.failed > 0)
  if (!dirty.length) {
    console.log('No failures at any level right now. Either the server is idle enough to')
    console.log('absorb this, or the poll errors have another cause — re-run while the')
    console.log('plant is busy and the MES service is running.')
  } else {
    console.log(`Clean at concurrency: ${clean.join(', ') || 'none'}`)
    console.log(`Failing at: ${dirty.map(d => `${d.level} (${d.failPct}%)`).join(', ')}`)
    console.log(`\nRestProvider fires ~40-140 of these at once per poll, so the failure`)
    console.log(`rate above is the floor, not the ceiling.`)
  }
  console.log()
}

main().catch(e => { console.error(e); process.exit(1) })
