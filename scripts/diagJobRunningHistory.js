// Pull historical samples for JobRunning + CurrentWOState across all 4 tanks
// via the paginated ProcessValues endpoint, which actually returns history.
const RestProvider = require('../historian/providers/restProvider')
const provider = new RestProvider()

const tanks = ['BlendTank1A', 'BlendTank1B', 'BlendTank2A', 'BlendTank2B']

function summarize(records, label) {
  if (records.length === 0) {
    console.log(`  ${label.padEnd(20)} (no records)`)
    return
  }
  // Detect transitions
  const transitions = []
  for (let i = 1; i < records.length; i++) {
    const prev = records[i - 1]
    const curr = records[i]
    if (String(prev.Value) !== String(curr.Value) || String(prev.Text) !== String(curr.Text)) {
      transitions.push({ at: curr.DateTime, from: { v: prev.Value, t: prev.Text }, to: { v: curr.Value, t: curr.Text } })
    }
  }
  const first = records[0]
  const last = records[records.length - 1]
  const uniqueText = new Set(records.map(r => r.Text))
  console.log(`  ${label.padEnd(20)} ${records.length} records, ${transitions.length} transitions, ${uniqueText.size} unique value(s): ${[...uniqueText].slice(0, 5).map(t => `"${t}"`).join(', ')}`)
  console.log(`    First @ ${first.DateTime}: Value=${first.Value} Text="${first.Text}"`)
  console.log(`    Last  @ ${last.DateTime}: Value=${last.Value} Text="${last.Text}"`)
  for (const t of transitions.slice(-10)) {
    console.log(`      ${t.at}: Value ${t.from.v}→${t.to.v} | Text "${t.from.t}"→"${t.to.t}"`)
  }
}

async function main() {
  const hours = 24
  const since = new Date(Date.now() - hours * 3600_000)
  const until = new Date()
  console.log(`=== Historical samples ${since.toISOString()} → ${until.toISOString()} ===\n`)
  for (const tank of tanks) {
    console.log(`--- ${tank} ---`)
    for (const suffix of ['.JobRunning', '.CurrentWOState', '.NOTE_STRING']) {
      const fqn = `${tank}${suffix}`
      try {
        const records = await provider._queryProcessValues(fqn, since, until, { maxRecords: 5000, verbose: false })
        summarize(records, suffix)
      } catch (err) {
        console.log(`  ${suffix.padEnd(20)} ERROR: ${err.message}`)
      }
    }
    console.log('')
  }
}

main().catch(err => {
  console.error('Diag failed:', err)
  process.exit(1)
})
