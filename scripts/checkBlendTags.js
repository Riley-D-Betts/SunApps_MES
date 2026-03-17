/**
 * Quick diagnostic: check MUtilState and RMS tags for all blend tanks
 * to find a reliable "in production" vs "CIP" signal.
 *
 * Usage: node scripts/checkBlendTags.js
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
        const body = res.body.replace(/^\uFEFF/, '')
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

async function main() {
  const tanks = ['BT1A', 'BT1B', 'BT2A', 'BT2B']

  console.log('\n=== MUtilState (Machine Utilization State) ===')
  for (const tank of tanks) {
    const fqn = `Proc_Proc1_${tank}_IO.UCO.MUtilState`
    try {
      const pv = await getCurrentValue(fqn)
      console.log(`  ${tank}: Value=${pv?.Value ?? 'null'}, Text="${pv?.Text ?? ''}", Time=${pv?.DateTime ?? '?'}`)
    } catch (e) {
      console.log(`  ${tank}: ERROR — ${e.message}`)
    }
  }

  console.log('\n=== RMS (Recipe Management System) ===')
  const rmsSuffixes = ['CurrentRecipeName', 'CurrentRecipeID', 'CurrentRecipeItem']
  for (const tank of tanks) {
    console.log(`  --- ${tank} ---`)
    for (const suffix of rmsSuffixes) {
      const fqn = `Proc_Proc1_${tank}_RMS.${suffix}`
      try {
        const pv = await getCurrentValue(fqn)
        console.log(`    ${suffix}: Value=${pv?.Value ?? 'null'}, Text="${pv?.Text ?? ''}", Time=${pv?.DateTime ?? '?'}`)
      } catch (e) {
        console.log(`    ${suffix}: ERROR — ${e.message}`)
      }
    }
  }

  console.log('\n=== NOTE_STRING (for reference) ===')
  const btNames = ['BlendTank1A', 'BlendTank1B', 'BlendTank2A', 'BlendTank2B']
  for (const bt of btNames) {
    const fqn = `${bt}.NOTE_STRING`
    try {
      const pv = await getCurrentValue(fqn)
      console.log(`  ${bt}: Text="${pv?.Text ?? ''}", Time=${pv?.DateTime ?? '?'}`)
    } catch (e) {
      console.log(`  ${bt}: ERROR — ${e.message}`)
    }
  }

  console.log('\n=== Additional candidates ===')
  // Check a few more potential production mode indicators
  const extras = [
    'Proc_Proc1_BT1B_IO.UCO.ProdS',        // Production state?
    'Proc_Proc1_BT1A_IO.UCO.ProdS',
    'Proc_Proc1_BT1B_IO.UCO.CleanS',        // CIP/clean state?
    'Proc_Proc1_BT1A_IO.UCO.CleanS',
    'Proc_Proc1_BT1B_IO.UCO.AssetModeS',    // Asset mode?
    'Proc_Proc1_BT1A_IO.UCO.AssetModeS',
  ]
  for (const fqn of extras) {
    try {
      const pv = await getCurrentValue(fqn)
      console.log(`  ${fqn}: Value=${pv?.Value ?? 'null'}, Text="${pv?.Text ?? ''}", Time=${pv?.DateTime ?? '?'}`)
    } catch (e) {
      console.log(`  ${fqn}: no data`)
    }
  }

  console.log('\nDone.')
}

main().catch(err => console.error('Fatal:', err))
