/**
 * Verify all hardcoded NetSuite IDs against live NS data.
 *
 * Run in sandbox, save reference:
 *   node scripts/verifyNsReferences.js --save ns-sandbox.json
 *
 * Run in production, compare:
 *   node scripts/verifyNsReferences.js --compare ns-sandbox.json
 *
 * Run without flags to print findings only (no save, no compare).
 *
 * Exit code 1 if --compare finds critical issues; 0 otherwise.
 */
const path = require('path')
const fs   = require('fs')
const dotenv = require('dotenv')
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const core        = require('../clients/coreClient')
const itemConfig  = require('../services/mesItemConfig')
const blendParser = require('../services/blendTankProductParser')
const surgeParser = require('../services/surgeTankProductParser')

// Import tracking helper so we use the same REST-fallback logic as production
const { getItemTracking } = require('../services/nsInventoryLookup')

// ── Collect all hardcoded IDs from source maps ─────────────────────────────

function collectItemDefs() {
  const map = new Map() // id → { id, labels[], expectedName }

  function add(id, label, name) {
    if (!id) return
    const n = Number(id)
    if (!Number.isFinite(n) || n <= 0) return
    if (!map.has(n)) map.set(n, { id: n, labels: [], expectedName: name || null })
    const entry = map.get(n)
    if (!entry.labels.includes(label)) entry.labels.push(label)
    if (name && !entry.expectedName) entry.expectedName = name
  }

  for (const [silo, item] of Object.entries(itemConfig.SILO_ITEM_MAP))
    add(item.id, `SILO_ITEM_MAP.${silo}`, item.name)

  for (const [key, item] of Object.entries(itemConfig.RAW_ITEMS))
    add(item.id, `RAW_ITEMS.${key}`, item.name)

  add(itemConfig.CREAM_ITEM_CONV.id, 'CREAM_ITEM_CONV', itemConfig.CREAM_ITEM_CONV.name)
  add(itemConfig.CREAM_ITEM_ORG.id,  'CREAM_ITEM_ORG',  itemConfig.CREAM_ITEM_ORG.name)
  add(itemConfig.SKIM_ITEM_CONV.id,  'SKIM_ITEM_CONV',  itemConfig.SKIM_ITEM_CONV.name)
  add(itemConfig.SKIM_ITEM_ORG.id,   'SKIM_ITEM_ORG',   itemConfig.SKIM_ITEM_ORG.name)

  for (const [code, item] of Object.entries(itemConfig.HISTORIAN_ITEM_MAP))
    add(item.id, `HISTORIAN_ITEM_MAP.${code}`, item.name)

  for (const [idx, item] of Object.entries(itemConfig.PRODUCT_INDEX_ITEM_MAP))
    if (item.id) add(item.id, `PRODUCT_INDEX_ITEM_MAP[${idx}]`, item.name)

  // Raw FG items (blend tank WO assembly output)
  for (const [label, id] of Object.entries(blendParser.RAW_FG_ITEM_MAP))
    add(id, `RAW_FG_ITEM_MAP: "${label}"`, null)

  // Finished-goods items (surge tank WO assembly output)
  for (const [label, id] of Object.entries(surgeParser.FG_ITEM_MAP))
    add(id, `FG_ITEM_MAP: "${label}"`, null)

  // Cross-map (already covered above, but ensures no gaps if a map diverges)
  for (const [rawFgId, fgId] of Object.entries(itemConfig.RAW_FG_TO_FG_MAP)) {
    add(Number(rawFgId), 'RAW_FG_TO_FG_MAP(rawFg)', null)
    add(fgId,            'RAW_FG_TO_FG_MAP(fg)',    null)
  }

  // Lot-tracked BOM components (vitamins, citrate) that appear on blend-WO BOMs
  add(530,  'BOM_COMPONENT.530',  null)
  add(531,  'BOM_COMPONENT.531',  null)
  add(7235, 'BOM_COMPONENT.7235', null)

  return [...map.values()].sort((a, b) => a.id - b.id)
}

function collectBinDefs() {
  const map = new Map()

  function add(id, label) {
    const n = Number(id)
    if (!map.has(n)) map.set(n, { id: n, labels: [] })
    map.get(n).labels.push(label)
  }

  for (const [name, id] of Object.entries(itemConfig.SILO_BIN_MAP))
    add(id, `SILO_BIN_MAP.${name}`)
  for (const [name, id] of Object.entries(itemConfig.TANK_BIN_MAP))
    add(id, `TANK_BIN_MAP.${name}`)
  for (const [name, id] of Object.entries(itemConfig.SURGE_TANK_BIN_MAP))
    add(id, `SURGE_TANK_BIN_MAP.${name}`)

  // Unbuild cap staging bin (milkMesService.SEPARATOR_ADJ_BIN_ID)
  add(5016, 'SEPARATOR_ADJ_BIN_ID')

  return [...map.values()].sort((a, b) => a.id - b.id)
}

function collectBomDefs() {
  return Object.entries(itemConfig.SEPARATION_BOM_MAP)
    .map(([key, id]) => ({ id: Number(id), label: `SEPARATION_BOM_MAP.${key}` }))
    .sort((a, b) => a.id - b.id)
}

// ── NS queries ─────────────────────────────────────────────────────────────

function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

function parseBool(v) {
  if (v === true  || v === 'T') return true
  if (v === false || v === 'F') return false
  return null
}

async function suiteQL(q) {
  const res = await core.netsuitePost('/query/v1/suiteql', { q })
  return res?.body?.items || res?.items || []
}

async function queryItemsExistence(defs) {
  const byId = new Map()
  for (const ch of chunk(defs.map(d => d.id), 100)) {
    const rows = await suiteQL(`SELECT id, itemid, displayname, isinactive FROM item WHERE id IN (${ch.join(',')})`)
    for (const row of rows)
      byId.set(Number(row.id), {
        displayName: row.displayname || row.itemid || null,
        isInactive:  parseBool(row.isinactive),
        type:        null,
      })
  }
  return byId
}

async function queryBins(defs) {
  const byId = new Map()
  for (const ch of chunk(defs.map(d => d.id), 100)) {
    const rows = await suiteQL(`SELECT id, binnumber, location, isinactive FROM bin WHERE id IN (${ch.join(',')})`)
    for (const row of rows)
      byId.set(Number(row.id), {
        name:       row.binnumber || null,
        locationId: row.location != null ? Number(row.location) : null,
        isInactive: parseBool(row.isinactive),
      })
  }
  return defs.map(def => ({
    id:     def.id,
    labels: def.labels,
    exists: byId.has(def.id),
    ...(byId.get(def.id) || { name: null, locationId: null, isInactive: null }),
  }))
}

async function queryBoms(defs) {
  const byId          = new Map()
  const unverifiable  = new Set()

  // NS BOM record type is 'bom' (REST) / 'bom' (SuiteQL table).
  // The assemblyUnbuild field is named 'billOfMaterials' but the record itself is 'bom'.
  try {
    const rows = await suiteQL(`SELECT id, name FROM bom WHERE id IN (${defs.map(d => d.id).join(',')})`)
    for (const row of rows) byId.set(Number(row.id), { name: row.name || null })
  } catch { /* SuiteQL not available for bom table — fall through to REST */ }

  // For any BOM not yet resolved, probe the REST API directly.
  // Distinguish 404 (confirmed missing) from other errors (unverifiable).
  const unresolved = defs.filter(d => !byId.has(d.id))
  for (const def of unresolved) {
    let confirmed = false
    try {
      const wrap = await core.netsuiteGet(`/record/v1/bom/${def.id}`)
      const body = wrap?.body || wrap
      byId.set(def.id, { name: body?.name || null })
      confirmed = true
    } catch (err) {
      const is404 = err.status === 404 || /\(404\)/.test(err.message || '')
      if (is404) confirmed = true  // confirmed absent
      // non-404 = unverifiable
    }
    if (!confirmed) unverifiable.add(def.id)
  }

  return defs.map(def => ({
    id:           def.id,
    label:        def.label,
    exists:       byId.has(def.id),
    unverifiable: unverifiable.has(def.id),
    name:         byId.get(def.id)?.name || null,
  }))
}

async function queryInfrastructure() {
  const [locRows, subRows, acctRows] = await Promise.all([
    suiteQL('SELECT id, name FROM location WHERE id = 30'),
    suiteQL('SELECT id, name FROM subsidiary WHERE id = 3'),
    suiteQL('SELECT id, acctnumber, isinactive FROM account WHERE id IN (476, 477)'),
  ])

  const loc   = locRows[0]  || null
  const sub   = subRows[0]  || null
  const accts = Object.fromEntries(acctRows.map(a => [Number(a.id), a]))

  return {
    location: {
      id: 30, label: 'NS_LOCATION_ID',
      exists: !!loc,
      name:   loc?.name || null,
    },
    subsidiary: {
      id: 3, label: 'NS_SUBSIDIARY_ID',
      exists: !!sub,
      name:   sub?.name || null,
    },
    accounts: [
      {
        id: 476, label: 'NS_ADJ_ACCOUNT_ID (Inventory Adjustment)',
        exists:     !!accts[476],
        number:     accts[476]?.acctnumber || null,
        name:       null,
        isInactive: parseBool(accts[476]?.isinactive) ?? null,
      },
      {
        id: 477, label: 'REVAL_ACCOUNT_ID (COGS: Inventory Revaluation)',
        exists:     !!accts[477],
        number:     accts[477]?.acctnumber || null,
        name:       null,
        isInactive: parseBool(accts[477]?.isinactive) ?? null,
      },
    ],
  }
}

// ── Build snapshot ─────────────────────────────────────────────────────────

async function buildSnapshot() {
  const itemDefs = collectItemDefs()
  const binDefs  = collectBinDefs()
  const bomDefs  = collectBomDefs()

  console.log(`Querying NS: ${itemDefs.length} unique items, ${binDefs.length} bins, ${bomDefs.length} BOMs …`)

  // Existence + display name (batch SuiteQL)
  const [itemRowsById, bins, boms, infrastructure] = await Promise.all([
    queryItemsExistence(itemDefs),
    queryBins(binDefs),
    queryBoms(bomDefs),
    queryInfrastructure(),
  ])

  // Tracking (lot / bin) via REST — reuses the same subtypes-fallback logic as
  // production so the results are authoritative, not guesses from SuiteQL columns
  const existingItemIds = itemDefs.filter(d => itemRowsById.has(d.id)).map(d => d.id)
  console.log(`Fetching item tracking for ${existingItemIds.length} items via REST …`)

  const trackingById = new Map()
  // Process in serial to avoid hammering NS with 60+ simultaneous REST calls
  for (const id of existingItemIds) {
    try {
      const t = await getItemTracking(id)
      trackingById.set(id, { isLot: t.isLot, useBins: t.useBins })
    } catch {
      trackingById.set(id, { isLot: null, useBins: null })
    }
  }

  const items = itemDefs.map(def => {
    const row     = itemRowsById.get(def.id) || null
    const tracking = trackingById.get(def.id) || null
    return {
      id:           def.id,
      labels:       def.labels,
      expectedName: def.expectedName,
      exists:       !!row,
      displayName:  row?.displayName  ?? null,
      isInactive:   row?.isInactive   ?? null,
      type:         row?.type         ?? null,
      isLot:        tracking?.isLot   ?? null,
      useBins:      tracking?.useBins ?? null,
    }
  })

  return {
    capturedAt: new Date().toISOString(),
    items,
    bins,
    boms,
    infrastructure,
  }
}

// ── Print snapshot ─────────────────────────────────────────────────────────

function printSnapshot(snap) {
  const missingItems  = snap.items.filter(i => !i.exists)
  const inactiveItems = snap.items.filter(i => i.exists && i.isInactive)
  const okItems       = snap.items.filter(i => i.exists && !i.isInactive)

  console.log('\n── ITEMS ────────────────────────────────────────────────────────────────')
  console.log(`  ${snap.items.length} total  |  ${okItems.length} OK  |  ${missingItems.length} missing  |  ${inactiveItems.length} inactive`)

  if (missingItems.length) {
    console.log('\n  MISSING:')
    for (const i of missingItems)
      console.log(`    [${i.id}]  ${i.expectedName || '(no expected name)'}  →  ${i.labels.join(', ')}`)
  }
  if (inactiveItems.length) {
    console.log('\n  INACTIVE:')
    for (const i of inactiveItems)
      console.log(`    [${i.id}]  ${i.displayName}  →  ${i.labels.join(', ')}`)
  }
  if (okItems.length) {
    console.log('\n  OK:')
    for (const i of okItems)
      console.log(`    [${String(i.id).padStart(5)}]  lot=${String(i.isLot).padEnd(5)}  bins=${String(i.useBins).padEnd(5)}  ${i.displayName || '(unnamed)'}`)
  }

  const missingBins   = snap.bins.filter(b => !b.exists)
  const inactiveBins  = snap.bins.filter(b => b.exists && b.isInactive)
  const wrongLocBins  = snap.bins.filter(b => b.exists && !b.isInactive && b.locationId !== 30)
  const okBins        = snap.bins.filter(b => b.exists && !b.isInactive && b.locationId === 30)

  console.log('\n── BINS ─────────────────────────────────────────────────────────────────')
  console.log(`  ${snap.bins.length} total  |  ${okBins.length} OK  |  ${missingBins.length} missing  |  ${inactiveBins.length} inactive  |  ${wrongLocBins.length} wrong-location`)
  if (missingBins.length) {
    console.log('\n  MISSING:')
    for (const b of missingBins) console.log(`    [${b.id}]  ${b.labels.join(', ')}`)
  }
  if (wrongLocBins.length) {
    console.log('\n  WRONG LOCATION (expected 30):')
    for (const b of wrongLocBins) console.log(`    [${b.id}]  loc=${b.locationId}  ${b.name}  →  ${b.labels.join(', ')}`)
  }
  for (const b of okBins)
    console.log(`    [${String(b.id).padStart(5)}]  loc=${b.locationId}  ${b.name}  →  ${b.labels.join(', ')}`)

  const missingBoms       = snap.boms.filter(b => !b.exists && !b.unverifiable)
  const unverifiableBoms  = snap.boms.filter(b => b.unverifiable)
  const okBoms            = snap.boms.filter(b => b.exists)
  console.log('\n── BOMs ─────────────────────────────────────────────────────────────────')
  console.log(`  ${snap.boms.length} total  |  ${okBoms.length} OK  |  ${missingBoms.length} missing  |  ${unverifiableBoms.length} unverifiable`)
  if (unverifiableBoms.length)
    console.log(`  (unverifiable = NS record type not determined; IDs may differ by env)`)
  if (missingBoms.length) {
    console.log('\n  MISSING:')
    for (const b of missingBoms) console.log(`    [${b.id}]  ${b.label}`)
  }
  if (unverifiableBoms.length) {
    console.log('\n  UNVERIFIABLE:')
    for (const b of unverifiableBoms) console.log(`    [${b.id}]  ${b.label}`)
  }
  for (const b of okBoms)
    console.log(`    [${String(b.id).padStart(5)}]  ${b.name || '(unnamed)'}  →  ${b.label}`)

  const infra = snap.infrastructure
  console.log('\n── INFRASTRUCTURE ───────────────────────────────────────────────────────')
  console.log(`  Location   30: ${infra.location.exists  ? `OK — ${infra.location.name}`  : 'MISSING'}`)
  console.log(`  Subsidiary  3: ${infra.subsidiary.exists ? `OK — ${infra.subsidiary.name}` : 'MISSING'}`)
  for (const a of infra.accounts) {
    const status = !a.exists ? 'MISSING' : a.isInactive ? 'INACTIVE' : `OK — ${a.number} ${a.name}`
    console.log(`  Account  ${a.id}: ${status}  (${a.label})`)
  }
}

// ── Compare snapshots ──────────────────────────────────────────────────────

function compareSnapshots(ref, live) {
  const issues   = []  // things that would break the service
  const warnings = []  // informational differences

  // Items
  for (const liveItem of live.items) {
    const refItem = ref.items.find(i => i.id === liveItem.id)
    if (!refItem) continue // newly-added item, nothing to compare against

    const label = `[${liveItem.id}] ${liveItem.displayName || liveItem.expectedName || ''} (${liveItem.labels[0]})`

    if (refItem.exists && !liveItem.exists) {
      issues.push(`ITEM ${label}: present in sandbox but MISSING in production`)
      continue
    }
    if (!liveItem.exists) continue

    if (!refItem.isInactive && liveItem.isInactive)
      issues.push(`ITEM ${label}: INACTIVE in production (was active in sandbox)`)

    if (refItem.isLot !== null && liveItem.isLot !== null && refItem.isLot !== liveItem.isLot)
      issues.push(`ITEM ${label}: lot-tracking changed — sandbox=${refItem.isLot}  prod=${liveItem.isLot}`)

    if (refItem.useBins !== null && liveItem.useBins !== null && refItem.useBins !== liveItem.useBins)
      issues.push(`ITEM ${label}: bin-tracking changed — sandbox=${refItem.useBins}  prod=${liveItem.useBins}`)

    if (refItem.type && liveItem.type && refItem.type !== liveItem.type)
      issues.push(`ITEM ${label}: item type changed — sandbox=${refItem.type}  prod=${liveItem.type}`)

    if (refItem.displayName && liveItem.displayName && refItem.displayName !== liveItem.displayName)
      warnings.push(`ITEM ${label}: name changed — sandbox="${refItem.displayName}"  prod="${liveItem.displayName}"`)
  }

  // Items in reference that disappeared from the code maps
  for (const refItem of ref.items) {
    if (!live.items.find(i => i.id === refItem.id))
      warnings.push(`ITEM [${refItem.id}] ${refItem.displayName || ''}: in reference but not in current code maps (removed?)`)
  }

  // Bins
  for (const liveBin of live.bins) {
    const refBin = ref.bins.find(b => b.id === liveBin.id)
    if (!refBin) continue

    const label = `[${liveBin.id}] ${liveBin.name || liveBin.labels[0]}`

    if (refBin.exists && !liveBin.exists) {
      issues.push(`BIN ${label}: present in sandbox but MISSING in production`)
      continue
    }
    if (!liveBin.exists) continue

    if (!refBin.isInactive && liveBin.isInactive)
      issues.push(`BIN ${label}: INACTIVE in production`)

    if (refBin.locationId && liveBin.locationId && refBin.locationId !== liveBin.locationId)
      issues.push(`BIN ${label}: location changed — sandbox=${refBin.locationId}  prod=${liveBin.locationId}`)

    if (refBin.name && liveBin.name && refBin.name !== liveBin.name)
      warnings.push(`BIN ${label}: name changed — sandbox="${refBin.name}"  prod="${liveBin.name}"`)
  }

  // BOMs — skip if either side couldn't be verified (different IDs per env is expected)
  for (const liveBom of live.boms) {
    const refBom = ref.boms.find(b => b.id === liveBom.id)
    if (!refBom || refBom.unverifiable || liveBom.unverifiable) continue

    if (refBom.exists && !liveBom.exists)
      issues.push(`BOM [${liveBom.id}] ${liveBom.label}: present in sandbox but MISSING in production`)
  }

  // Infrastructure
  const refInfra  = ref.infrastructure  || {}
  const liveInfra = live.infrastructure || {}

  if (refInfra.location?.exists && !liveInfra.location?.exists)
    issues.push('LOCATION 30: missing in production')
  if (refInfra.subsidiary?.exists && !liveInfra.subsidiary?.exists)
    issues.push('SUBSIDIARY 3: missing in production')

  for (const liveAcct of liveInfra.accounts || []) {
    const refAcct = (refInfra.accounts || []).find(a => a.id === liveAcct.id)
    if (!refAcct) continue
    if (refAcct.exists && !liveAcct.exists)
      issues.push(`ACCOUNT ${liveAcct.id} (${liveAcct.label}): missing in production`)
    if (!refAcct.isInactive && liveAcct.isInactive)
      issues.push(`ACCOUNT ${liveAcct.id} (${liveAcct.label}): INACTIVE in production`)
  }

  return { issues, warnings }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const args        = process.argv.slice(2)
  const saveIdx     = args.indexOf('--save')
  const compareIdx  = args.indexOf('--compare')
  const saveFile    = saveIdx    >= 0 ? args[saveIdx    + 1] : null
  const compareFile = compareIdx >= 0 ? args[compareIdx + 1] : null

  if (saveFile && compareFile) {
    console.error('Use --save OR --compare, not both.')
    process.exit(1)
  }
  if ((saveIdx >= 0 && !saveFile) || (compareIdx >= 0 && !compareFile)) {
    console.error('--save and --compare each require a filename argument.')
    process.exit(1)
  }

  const snap = await buildSnapshot()
  printSnapshot(snap)

  if (saveFile) {
    fs.writeFileSync(saveFile, JSON.stringify(snap, null, 2))
    console.log(`\nReference written to: ${saveFile}`)
  }

  if (compareFile) {
    if (!fs.existsSync(compareFile)) {
      console.error(`Reference file not found: ${compareFile}`)
      process.exit(1)
    }
    const ref = JSON.parse(fs.readFileSync(compareFile, 'utf8'))
    const { issues, warnings } = compareSnapshots(ref, snap)

    console.log('\n── COMPARISON ───────────────────────────────────────────────────────────')
    console.log(`  Reference: ${ref.capturedAt}`)
    console.log(`  Live:      ${snap.capturedAt}`)

    if (!issues.length && !warnings.length) {
      console.log('\n  All checks passed — production matches sandbox reference.')
    } else {
      if (issues.length) {
        console.log(`\n  ISSUES (${issues.length}) — must resolve before go-live:`)
        for (const msg of issues) console.log(`    ✗  ${msg}`)
      }
      if (warnings.length) {
        console.log(`\n  WARNINGS (${warnings.length}) — informational:`)
        for (const msg of warnings) console.log(`    ~  ${msg}`)
      }
    }

    if (issues.length) process.exit(1)
  }
}

main().catch(err => {
  console.error('Fatal:', err.message)
  if (err.stack) console.error(err.stack)
  process.exit(1)
})
