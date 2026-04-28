/**
 * Discovery: find Historian tags that look like blend-tank outlet flow / valve
 * indicators. We don't currently use any outlet sensors — completion qty is
 * derived from inflow (mass-balance accounting). But for the future bin-
 * transfer step (blend tank → surge tank with waste tracking) we'll want to
 * know what outlet metrics exist on each blend tank.
 *
 * Run: node scripts/discoverBlendTankOutletTags.js
 *
 * Re-uses scripts/all-tags.json if present (faster); otherwise pulls a fresh
 * tag list from the Historian via NTLM curl (mirrors discoverTags.js).
 */
const fs = require('fs')
const path = require('path')
const { execSync } = require('child_process')
const dotenv = require('dotenv')
dotenv.config({ path: path.resolve(__dirname, '..', '.env') })

const BASE = process.env.HISTORIAN_BASE_URL || 'http://10.4.9.23:32569/Historian/v2'
const DOMAIN = process.env.HISTORIAN_DOMAIN || 'MES'
const USER = process.env.HISTORIAN_USERNAME
const PASS = process.env.HISTORIAN_PASSWORD
const CACHE_FILE = path.resolve(__dirname, 'all-tags.json')

const TANK_PREFIXES = ['BlendTank1A', 'BlendTank1B', 'BlendTank2A', 'BlendTank2B']

// Pattern keywords likely to indicate flow OUT of a blend tank toward UHT.
// We match generously and let the human review what's relevant.
const OUTLET_KEYWORDS = [
  'OUT', 'OUTLET', 'OUTFLOW', 'DISCHARGE', 'DRAIN',
  'FT_', 'FT.', 'FLOW', 'FLOWRATE', 'FLOW_RATE',
  'SCL', 'SCALE', 'WEIGHT', 'WT_', 'WT.',
  'UHT', 'PASTEUR', 'ToEnt', 'Destination',
  'TOTALIZE', 'TOTALIZER', 'TOTAL',
  'VALVE', 'CV_', 'CV.',
]

function curlNtlm(url) {
  if (!USER || !PASS) {
    throw new Error('HISTORIAN_USERNAME / HISTORIAN_PASSWORD not set in env')
  }
  const cmd = `curl -s --max-time 60 --ntlm -u "${DOMAIN}\\${USER}:${PASS}" "${url}"`
  const out = execSync(cmd, { maxBuffer: 50 * 1024 * 1024, shell: 'cmd.exe' })
  const text = out.toString().trim()
  if (!text) throw new Error(`Empty response from ${url}`)
  return JSON.parse(text)
}

async function fetchAllTags() {
  if (fs.existsSync(CACHE_FILE)) {
    console.log(`Using cached tag list at ${CACHE_FILE}`)
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))
  }
  console.log('Fetching all tags from Historian (this may take a minute)...')
  const all = []
  let url = `${BASE}/Tags?$select=FQN,Description,TagType,EngUnit`
  let page = 1
  while (url) {
    process.stdout.write(`  page ${page}...`)
    const data = curlNtlm(url)
    all.push(...(data.value || []))
    process.stdout.write(` ${data.value?.length || 0} tags\n`)
    url = data['@odata.nextLink'] || null
    page++
  }
  fs.writeFileSync(CACHE_FILE, JSON.stringify(all))
  return all
}

function classify(tag) {
  const fqn = tag.FQN || ''
  const upper = fqn.toUpperCase()
  for (const prefix of TANK_PREFIXES) {
    if (!upper.includes(prefix.toUpperCase())) continue
    for (const kw of OUTLET_KEYWORDS) {
      if (upper.includes(kw.toUpperCase())) return { tank: prefix, keyword: kw }
    }
  }
  return null
}

async function main() {
  const tags = await fetchAllTags()
  console.log(`\nTotal tags: ${tags.length}`)

  const byTank = Object.fromEntries(TANK_PREFIXES.map(t => [t, []]))
  for (const tag of tags) {
    const hit = classify(tag)
    if (hit) byTank[hit.tank].push({ ...tag, _matched: hit.keyword })
  }

  for (const tank of TANK_PREFIXES) {
    const list = byTank[tank]
    console.log(`\n=== ${tank} — ${list.length} candidate(s) ===`)
    if (list.length === 0) {
      console.log('  (none — try widening keywords or check tag prefix)')
      continue
    }
    list.sort((a, b) => a.FQN.localeCompare(b.FQN))
    for (const t of list) {
      const desc = t.Description ? ` — ${t.Description}` : ''
      const unit = t.EngUnit ? ` [${t.EngUnit}]` : ''
      console.log(`  ${t.FQN} (${t.TagType || '?'}${unit})${desc}  «${t._matched}»`)
    }
  }

  console.log('\nDone. Review candidates and add the ones that look like real outlet sensors to historian-api.md.')
}

main().catch(err => {
  console.error('FAILED:', err.message)
  process.exit(1)
})
