#!/usr/bin/env node
/**
 * Live check on CasePacker 5/6 count tags and all Pack/Pallet IO tags.
 * Shows latest value, timestamp, and last time the value actually changed.
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
  { group: 'Case Packer 5 & 6 — Machine Counters',  fqn: 'CasePacker5_CaseCounts' },
  { group: 'Case Packer 5 & 6 — Machine Counters',  fqn: 'CasePacker5_LifeTimeCounts' },
  { group: 'Case Packer 5 & 6 — Machine Counters',  fqn: 'CasePacker6_CaseCounts' },
  { group: 'Case Packer 5 & 6 — Machine Counters',  fqn: 'CasePacker6_LifeTimeCounts' },

  { group: 'Palletizer Line 1', fqn: 'Pack_Pack1_Pall1_IO.Pallet_Complete' },
  { group: 'Palletizer Line 1', fqn: 'Pack_Pack1_Pall1_IO.PalletCases' },
  { group: 'Palletizer Line 1', fqn: 'Pack_Pack1_Pall1_IO.PalletCasesPrev' },
  { group: 'Palletizer Line 1', fqn: 'Pack_Pack1_Pall1_ERP.SendPalletComplete' },
  { group: 'Palletizer Line 1', fqn: 'Pack_Pack1_Pall1_IO.UCO.Mcounts#.1' },
  { group: 'Palletizer Line 1', fqn: 'Pack_Pack1_Pall1_IO.UCO.Mcounts#.2' },

  { group: 'Palletizer Line 2', fqn: 'Pack_Pack2_Pall2_IO.Pallet_Complete' },
  { group: 'Palletizer Line 2', fqn: 'Pack_Pack2_Pall2_IO.PalletCases' },
  { group: 'Palletizer Line 2', fqn: 'Pack_Pack2_Pall2_IO.PalletCasesPrev' },
  { group: 'Palletizer Line 2', fqn: 'Pack_Pack2_Pall2_ERP.SendPalletComplete' },
  { group: 'Palletizer Line 2', fqn: 'Pack_Pack2_Pall2_IO.UCO.Mcounts#.1' },
  { group: 'Palletizer Line 2', fqn: 'Pack_Pack2_Pall2_IO.UCO.Mcounts#.2' },

  { group: 'Palletizer Line 3', fqn: 'Pack_Pack3_Pall3_IO.Pallet_Complete' },
  { group: 'Palletizer Line 3', fqn: 'Pack_Pack3_Pall3_IO.PalletCases' },
  { group: 'Palletizer Line 3', fqn: 'Pack_Pack3_Pall3_IO.PalletCasesPrev' },
  { group: 'Palletizer Line 3', fqn: 'Pack_Pack3_Pall3_ERP.SendPalletComplete' },
  { group: 'Palletizer Line 3', fqn: 'Pack_Pack3_Pall3_IO.UCO.Mcounts#.1' },
  { group: 'Palletizer Line 3', fqn: 'Pack_Pack3_Pall3_IO.UCO.Mcounts#.2' },

  { group: 'Palletizer Line 4', fqn: 'Pack_Pack4_Pall4_IO.Pallet_Complete' },
  { group: 'Palletizer Line 4', fqn: 'Pack_Pack4_Pall4_IO.PalletCases' },
  { group: 'Palletizer Line 4', fqn: 'Pack_Pack4_Pall4_IO.PalletCasesPrev' },
  { group: 'Palletizer Line 4', fqn: 'Pack_Pack4_Pall4_ERP.SendPalletComplete' },
  { group: 'Palletizer Line 4', fqn: 'Pack_Pack4_Pall4_IO.UCO.Mcounts#.1' },
  { group: 'Palletizer Line 4', fqn: 'Pack_Pack4_Pall4_IO.UCO.Mcounts#.2' },

  { group: 'Palletizer Line 5', fqn: 'Pack_Pack5_Pall5_IO.Pallet_Complete' },
  { group: 'Palletizer Line 5', fqn: 'Pack_Pack5_Pall5_IO.PalletCases' },
  { group: 'Palletizer Line 5', fqn: 'Pack_Pack5_Pall5_IO.PalletCasesPrev' },
  { group: 'Palletizer Line 5', fqn: 'Pack_Pack5_Pall5_ERP.SendPalletComplete' },
  { group: 'Palletizer Line 5', fqn: 'Pack_Pack5_Pall5_IO.UCO.Mcounts#.1' },
  { group: 'Palletizer Line 5', fqn: 'Pack_Pack5_Pall5_IO.UCO.Mcounts#.2' },

  { group: 'Palletizer Line 6', fqn: 'Pack_Pack6_Pall6_IO.Pallet_Complete' },
  { group: 'Palletizer Line 6', fqn: 'Pack_Pack6_Pall6_IO.PalletCases' },
  { group: 'Palletizer Line 6', fqn: 'Pack_Pack6_Pall6_IO.PalletCasesPrev' },
  { group: 'Palletizer Line 6', fqn: 'Pack_Pack6_Pall6_IO.UCO.Mcounts#.1' },
  { group: 'Palletizer Line 6', fqn: 'Pack_Pack6_Pall6_IO.UCO.Mcounts#.2' },

  { group: 'Case Packer Line 1', fqn: 'Pack_Pack1_CsPckr1_IO.UCO.Mcounts#.1' },
  { group: 'Case Packer Line 1', fqn: 'Pack_Pack1_CsPckr1_IO.UCO.Mcounts#.2' },
  { group: 'Case Packer Line 2', fqn: 'Pack_Pack2_CsPckr2_IO.UCO.Mcounts#.1' },
  { group: 'Case Packer Line 2', fqn: 'Pack_Pack2_CsPckr2_IO.UCO.Mcounts#.2' },
  { group: 'Case Packer Line 3', fqn: 'Pack_Pack3_CsPckr3_IO.UCO.Mcounts#.1' },
  { group: 'Case Packer Line 3', fqn: 'Pack_Pack3_CsPckr3_IO.UCO.Mcounts#.2' },
  { group: 'Case Packer Line 4', fqn: 'Pack_Pack4_CsPckr4_IO.UCO.Mcounts#.1' },
  { group: 'Case Packer Line 4', fqn: 'Pack_Pack4_CsPckr4_IO.UCO.Mcounts#.2' },
  { group: 'Case Packer Line 5', fqn: 'Pack_Pack5_CsPckr5_IO.UCO.Mcounts#.1' },
  { group: 'Case Packer Line 5', fqn: 'Pack_Pack5_CsPckr5_IO.UCO.Mcounts#.2' },
  { group: 'Case Packer Line 6', fqn: 'Pack_Pack6_CsPckr6_IO.UCO.Mcounts#.1' },
  { group: 'Case Packer Line 6', fqn: 'Pack_Pack6_CsPckr6_IO.UCO.Mcounts#.2' },

  { group: 'Filler 1 — Bad Carton at Discharge', fqn: 'Filler1.L1_Bad_Carton_At_Discharge' },
  { group: 'Filler 1 — Bad Carton at Discharge', fqn: 'Filler1.L2_Bad_Carton_At_Discharge' },
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
        resolve({ status: res.statusCode, data: JSON.parse(res.body.replace(/^﻿/, '')) })
      } catch {
        resolve({ status: res.statusCode, data: null })
      }
    })
  })
}

async function fetchRecent(fqn, top = 200) {
  const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000)
  const filter = `FQN eq '${fqn}' and DateTime ge ${since.toISOString()}`
  const url = `${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime desc&$top=${top}`
  const { status, data } = await ntlmGet(url)
  if (status !== 200 || !data?.value) return []
  return data.value
}

const STALE_MS = 24 * 60 * 60 * 1000

async function main() {
  if (!BASE_URL) { console.error('HISTORIAN_BASE_URL not set'); process.exit(1) }

  console.log(`\nCase Packer & Palletizer Tag Check  —  ${new Date().toLocaleString()}`)
  console.log('='.repeat(92))

  let currentGroup = ''

  for (const { group, fqn } of TAGS) {
    if (group !== currentGroup) {
      currentGroup = group
      console.log(`\n  ${group}`)
      console.log('  ' + '─'.repeat(88))
      console.log(`  ${'Status'.padEnd(10)} ${'Value'.padEnd(14)} ${'Last Recorded'.padEnd(26)} ${'Last Changed'.padEnd(26)} Tag`)
      console.log('  ' + '─'.repeat(88))
    }

    try {
      const records = await fetchRecent(fqn)

      if (records.length === 0) {
        console.log(`  ${'NO DATA'.padEnd(10)} ${'—'.padEnd(14)} ${'—'.padEnd(26)} ${'—'.padEnd(26)} ${fqn}`)
        continue
      }

      const latest     = records[0]
      const latestVal  = latest.Value
      const latestTs   = new Date(latest.DateTime)
      const age        = Date.now() - latestTs.getTime()
      const liveStatus = age < STALE_MS ? 'LIVE' : 'STALE'

      // Find last change
      let lastChangeTs = null
      let changedFrom  = null
      for (let i = 1; i < records.length; i++) {
        if (records[i].Value !== latestVal) {
          lastChangeTs = new Date(records[i - 1].DateTime)
          changedFrom  = records[i].Value
          break
        }
      }

      const valStr      = String(latestVal ?? '—').slice(0, 12).padEnd(14)
      const recordedStr = latestTs.toLocaleString().padEnd(26)
      const changedStr  = lastChangeTs
        ? lastChangeTs.toLocaleString().padEnd(26)
        : (records.length >= 200 ? '>90d ago'.padEnd(26) : 'never changed'.padEnd(26))
      const tagShort    = fqn.split('.').pop() ?? fqn

      // Flag if actively changing (last change within 24h)
      const activeFlag = lastChangeTs && (Date.now() - lastChangeTs.getTime()) < STALE_MS ? ' ◄ CHANGING' : ''

      console.log(`  ${liveStatus.padEnd(10)} ${valStr} ${recordedStr} ${changedStr} ${tagShort}${activeFlag}`)
    } catch (err) {
      console.log(`  ${'ERROR'.padEnd(10)} ${''.padEnd(14)} ${''.padEnd(26)} ${''.padEnd(26)} ${fqn} (${err.message})`)
    }
  }

  console.log('\n' + '='.repeat(92))
}

main().catch(err => { console.error('Fatal:', err); process.exit(1) })
