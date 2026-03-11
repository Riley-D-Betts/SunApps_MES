#!/usr/bin/env node
/**
 * Query Filler1 carton counts since Monday 12:00 AM.
 *
 * Walks the historical time series for L1/L2_Carton_Count_Good,
 * detects counter resets, and sums the peak value before each reset
 * plus the current in-progress count.
 *
 * Usage:  node scripts/fillerCartonCount.js
 */

const path = require('path')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

const LINES = [
  { fqn: 'Filler1.L1_Carton_Count_Good', label: 'Line 1' },
  { fqn: 'Filler1.L2_Carton_Count_Good', label: 'Line 2' },
]

function ntlmGet(url) {
  return new Promise((resolve, reject) => {
    httpntlm.get({
      url,
      domain: DOMAIN,
      username: USERNAME,
      password: PASSWORD,
      headers: { 'Accept': 'application/json' },
    }, (err, res) => {
      if (err) return reject(err)
      if (res.statusCode !== 200) {
        return reject(new Error(`Historian API ${res.statusCode}: ${res.body?.slice(0, 300)}`))
      }
      try {
        const body = res.body.replace(/^\uFEFF/, '')
        resolve(JSON.parse(body))
      } catch (e) {
        reject(new Error(`Invalid JSON: ${res.body?.slice(0, 300)}`))
      }
    })
  })
}

/**
 * Fetch ALL ProcessValues for a tag in a time range, handling pagination.
 */
async function getAllProcessValues(fqn, since, until) {
  const allValues = []
  let filter = `FQN eq '${fqn}'`
  if (since) filter += ` and DateTime ge ${since.toISOString()}`
  if (until) filter += ` and DateTime le ${until.toISOString()}`

  let url = `${BASE_URL}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime`
  while (url) {
    const data = await ntlmGet(url)
    if (data.value) allValues.push(...data.value)
    // OData pagination via $skiptoken or @odata.nextLink
    url = data['@odata.nextLink'] || null
  }
  return allValues
}

/**
 * Walk the time series and sum up carton counts across resets.
 * A "reset" is when the value drops significantly from the previous reading.
 * The value just before the drop is the completed batch count.
 */
function sumAcrossResets(values) {
  if (values.length === 0) return { total: 0, batches: [] }

  const batches = []
  let prevVal = values[0].Value ?? 0

  for (let i = 1; i < values.length; i++) {
    const curVal = values[i].Value ?? 0

    // Detect reset: current value drops well below previous
    if (curVal < prevVal * 0.5 && prevVal > 10) {
      batches.push({
        count: prevVal,
        endTime: values[i - 1].DateTime,
      })
    }

    prevVal = curVal
  }

  // Current in-progress run (last value in the series)
  const currentVal = values[values.length - 1].Value ?? 0

  const completedTotal = batches.reduce((sum, b) => sum + b.count, 0)
  const total = completedTotal + currentVal

  return { total, completedTotal, currentVal, batches }
}

function getMondayMidnight() {
  const now = new Date()
  const day = now.getDay()
  const diff = day === 0 ? 6 : day - 1
  const monday = new Date(now)
  monday.setDate(now.getDate() - diff)
  monday.setHours(0, 0, 0, 0)
  return monday
}

async function main() {
  if (!BASE_URL) {
    console.error('HISTORIAN_BASE_URL not set in .env')
    process.exit(1)
  }

  const mondayMidnight = getMondayMidnight()
  const now = new Date()

  console.log(`\nFiller1 Carton Counts Since Monday`)
  console.log(`Since: ${mondayMidnight.toLocaleString()}`)
  console.log(`Now:   ${now.toLocaleString()}`)
  console.log('─'.repeat(55))

  let grandTotal = 0

  for (const { fqn, label } of LINES) {
    try {
      console.log(`\n  ${label} (${fqn})`)

      const values = await getAllProcessValues(fqn, mondayMidnight, now)
      console.log(`    ${values.length} data points retrieved`)

      if (values.length === 0) {
        console.log(`    — no data`)
        continue
      }

      const result = sumAcrossResets(values)

      if (result.batches.length > 0) {
        console.log(`    Completed batches:`)
        result.batches.forEach((b, i) => {
          const time = new Date(b.endTime).toLocaleString()
          console.log(`      #${i + 1}  ${b.count.toLocaleString().padStart(8)} cartons  (ended ${time})`)
        })
      }
      console.log(`    In-progress:    ${result.currentVal.toLocaleString().padStart(8)} cartons`)
      console.log(`    ${label} total: ${result.total.toLocaleString().padStart(8)} cartons`)

      grandTotal += result.total
    } catch (err) {
      console.log(`    — error: ${err.message}`)
    }
  }

  console.log('\n' + '─'.repeat(55))
  console.log(`  Grand Total:   ${grandTotal.toLocaleString().padStart(10)} cartons`)
  console.log('')
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
