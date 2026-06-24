/**
 * Round 2 diagnostic: probe Sallocation, CurrentWOState, and other state
 * candidates for blend-tank CIP/production detection.
 *
 * Usage: node scripts/checkBlendTags2.js
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
        const body = res.body.replace(/^﻿/, '')
        resolve(JSON.parse(body))
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

async function probe(fqn) {
  try {
    const pv = await getCurrentValue(fqn)
    return pv ? `Value=${pv.Value ?? 'null'}, Text="${pv.Text ?? ''}", Time=${pv.DateTime}` : 'no data'
  } catch (e) {
    return `ERROR: ${e.message}`
  }
}

async function main() {
  const ioTanks = ['BT1A', 'BT1B', 'BT2A', 'BT2B']
  const btTanks = ['BlendTank1A', 'BlendTank1B', 'BlendTank2A', 'BlendTank2B']

  console.log('\n=== Sallocation (1=Idle, 2=Prod, 3-5=Custom) ===')
  for (const t of ioTanks) {
    console.log(`  ${t}: ${await probe(`Proc_Proc1_${t}_IO.UCO.Sallocation`)}`)
  }

  console.log('\n=== Mallocation (Machine Allocation from OEM) ===')
  for (const t of ioTanks) {
    console.log(`  ${t}: ${await probe(`Proc_Proc1_${t}_IO.UCO.Mallocation`)}`)
  }

  console.log('\n=== CurrentWOState (string) ===')
  for (const t of btTanks) {
    console.log(`  ${t}: ${await probe(`${t}.CurrentWOState`)}`)
  }

  console.log('\n=== UCO.UnitStartedS / UnitStartingS / UnitStoppedS ===')
  for (const t of ioTanks) {
    console.log(`  --- ${t} ---`)
    console.log(`    UnitStartedS:  ${await probe(`Proc_Proc1_${t}_IO.AUC.UnitStartedS`)}`)
    console.log(`    UnitStartingS: ${await probe(`Proc_Proc1_${t}_IO.AUC.UnitStartingS`)}`)
    console.log(`    UnitStoppedS:  ${await probe(`Proc_Proc1_${t}_IO.AUC.UnitStoppedS`)}`)
  }

  console.log('\n=== MUtilReasonCd (Machine Util State Reason Code) ===')
  for (const t of ioTanks) {
    console.log(`  ${t}: ${await probe(`Proc_Proc1_${t}_IO.UCO.MUtilReasonCd`)}`)
  }

  console.log('\nDone.')
}

main().catch(err => console.error('Fatal:', err))
