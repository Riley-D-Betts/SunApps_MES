#!/usr/bin/env node
/**
 * Two questions answered here:
 *  1) For each filler (1-5): what does FromEntName say (which surge tank is it
 *     drawing from), and is its product tank level moving? = who is pulling now.
 *  2) For ST83/ST84: do the Sec/Sel filling indicators ever transition to 1
 *     (live pulse) or do they latch? Print only changes over the last 24h.
 */
const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const B = process.env.HISTORIAN_BASE_URL
const D = process.env.HISTORIAN_DOMAIN || ''
const U = process.env.HISTORIAN_USERNAME
const P = process.env.HISTORIAN_PASSWORD

function get(u) {
  return new Promise((res, rej) => httpntlm.get(
    { url: u, domain: D, username: U, password: P, headers: { Accept: 'application/json' } },
    (e, r) => e ? rej(e) : (() => { try { res(JSON.parse(r.body.replace(/^﻿/, ''))) } catch { res({}) } })()))
}
async function tr(fqn, hours = 24, top = 400) {
  const since = new Date(Date.now() - hours * 3600 * 1000).toISOString()
  const f = `FQN eq '${fqn}' and DateTime ge ${since}`
  const u = `${B}/ProcessValues?$filter=${encodeURIComponent(f)}&$orderby=DateTime desc&$top=${top}`
  const d = await get(u)
  return (d.value || []).map(r => ({ t: r.DateTime, txt: r.Text, v: r.Value }))
}
function changesOf(rows) {
  const out = []; let prev = null
  for (const r of rows.slice().reverse()) {
    const cur = r.txt ?? r.v
    if (String(cur) !== String(prev)) { out.push(`${new Date(r.t).toLocaleString()}=${cur}`); prev = cur }
  }
  return out
}

async function main() {
  console.log(`\n=== Filler FromEntName + product-tank level (latest) ===`)
  for (let n = 1; n <= 5; n++) {
    const from = await tr(`Filler${n}.FromEntName`, 24, 1)
    const lvl = await tr(`Filler${n}.g_i_Tank_Level`, 24, 1)
    const state = await tr(`Filler${n}.Filler_State`, 24, 1)
    const f = from[0], l = lvl[0], s = state[0]
    console.log(`  Filler${n}: From=${f ? (f.txt ?? f.v) : 'NO DATA'}  TankLevel=${l ? (l.txt ?? l.v) : '-'}  State=${s ? (s.txt ?? s.v) : '-'}  (From age ${f ? ((Date.now() - new Date(f.t)) / 60000).toFixed(0) + 'm' : '-'})`)
  }

  for (const tid of ['ST83', 'ST84']) {
    console.log(`\n=== ${tid} Sec/Sel transitions (last 24h, changes only) ===`)
    for (const kind of ['Sec', 'Sel']) {
      for (let i = 1; i <= 5; i++) {
        const c = changesOf(await tr(`ThermaRoute.${tid}_${kind}${i}_Filling_Indicator`))
        if (c.some(x => x.endsWith('=1'))) console.log(`  ${kind}${i}: ${c.join('  ')}`)
      }
    }
  }
}
main().catch(e => { console.error('Fatal:', e); process.exit(1) })
