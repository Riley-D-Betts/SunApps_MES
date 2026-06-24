// Read last 48 h of BlendTank1A.BT1A_TANK_MODE (and 1B while we're here)
// and report all distinct values + a timeline of changes.
const RestProvider = require('../historian/providers/restProvider')
const provider = new RestProvider()

const TAGS = [
  'BlendTank1A.BT1A_TANK_MODE',
  'BlendTank1B.BT1B_TANK_MODE',
]

async function main() {
  const until = new Date()
  const since = new Date(until.getTime() - 48 * 60 * 60 * 1000)

  for (const tag of TAGS) {
    console.log(`\n=== ${tag} (${since.toISOString()} → ${until.toISOString()}) ===`)
    const rows = await provider._queryProcessValues(tag, since, until, { verbose: false })

    if (!rows.length) {
      console.log('  (no data)')
      continue
    }

    // Distinct values
    const valueCounts = {}
    for (const r of rows) {
      const key = `Value=${r.Value}  Text="${r.Text ?? ''}"`
      valueCounts[key] = (valueCounts[key] || 0) + 1
    }
    console.log('Distinct values:')
    for (const [k, n] of Object.entries(valueCounts)) {
      console.log(`  ${k}  (${n} samples)`)
    }

    // Timeline of changes only
    console.log('\nChange log (only rows where value differs from previous):')
    let prev = null
    for (const r of rows) {
      if (r.Value !== prev) {
        console.log(`  ${r.DateTime}  Value=${r.Value}  Text="${r.Text ?? ''}"`)
        prev = r.Value
      }
    }
    console.log(`Total samples: ${rows.length}`)
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
