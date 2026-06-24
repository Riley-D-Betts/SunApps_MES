/**
 * Reconcile the 20 "present in sandbox but MISSING in production" items flagged
 * by verifyNsReferences --compare. For each one, search live (prod) NetSuite by
 * NAME and report whether it already exists under a DIFFERENT internal id
 * (→ remap the code) or is genuinely absent (→ create it in prod).
 *
 * Read-only. Run with local .env pointed at prod:
 *   node scripts/reconcileMissingNsItems.js
 */
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
const core = require('../clients/coreClient')

// id, expected code name, code reference, and whether it's a lot-tracked
// "(Batch)" twin (Group A) or a non-lot raw input (Group B).
const TARGETS = [
  // ── Group B: RAW_ITEMS (non-lot raw inputs) ─────────────────────────────
  { id: 5401, name: 'Raw Organic 3.5%',     ref: 'RAW_ITEMS.ORG_3_5',     twin: false },
  { id: 8366, name: 'Raw Organic A2 1%',    ref: 'RAW_ITEMS.ORG_A2_1',    twin: false },
  { id: 8367, name: 'Raw Organic A2 2%',    ref: 'RAW_ITEMS.ORG_A2_2',    twin: false },
  { id: 8368, name: 'Raw Organic A2 3.25%', ref: 'RAW_ITEMS.ORG_A2_3_25', twin: false },
  { id: 8369, name: 'Raw Organic A2 3.5%',  ref: 'RAW_ITEMS.ORG_A2_3_5',  twin: false },
  { id: 8370, name: 'Raw Organic A2 4%',    ref: 'RAW_ITEMS.ORG_A2_4',    twin: false },
  // ── Group A: RAW_FG_ITEM_MAP lot-tracked twins ("<source> (Batch)") ─────
  { id: 8928, name: 'Raw Organic A2 4%',    ref: 'RAW_FG_ITEM_MAP "Raw organic A2 4%"',    twin: true },
  { id: 8929, name: 'Raw Conventional Milk 1%',    ref: 'RAW_FG_ITEM_MAP "Raw conventional 1%"',    twin: true },
  { id: 8930, name: 'Raw Conventional Milk 2%',    ref: 'RAW_FG_ITEM_MAP "Raw conventional 2%"',    twin: true },
  { id: 8931, name: 'Raw Conventional Milk 3.25%', ref: 'RAW_FG_ITEM_MAP "Raw conventional 3.25%"', twin: true },
  { id: 8932, name: 'Raw Conventional Milk 3.5%',  ref: 'RAW_FG_ITEM_MAP "Raw conventional 3.5%"',  twin: true },
  { id: 8933, name: 'Raw Organic 1%',       ref: 'RAW_FG_ITEM_MAP "Raw organic 1%"',       twin: true },
  { id: 8934, name: 'Raw Organic 2%',       ref: 'RAW_FG_ITEM_MAP "Raw organic 2%"',       twin: true },
  { id: 8935, name: 'Raw Organic 3.25%',    ref: 'RAW_FG_ITEM_MAP "Raw organic 3.25%"',    twin: true },
  { id: 8936, name: 'Raw Organic 3.5%',     ref: 'RAW_FG_ITEM_MAP "Raw organic 3.5%"',     twin: true },
  { id: 8937, name: 'Raw Organic A2 1%',    ref: 'RAW_FG_ITEM_MAP "Raw organic A2 1%"',    twin: true },
  { id: 8938, name: 'Raw Organic A2 2%',    ref: 'RAW_FG_ITEM_MAP "Raw organic A2 2%"',    twin: true },
  { id: 8939, name: 'Raw Organic A2 3.25%', ref: 'RAW_FG_ITEM_MAP "Raw organic A2 3.25%"', twin: true },
  { id: 8940, name: 'Raw Organic A2 3.5%',  ref: 'RAW_FG_ITEM_MAP "Raw organic A2 3.5%"',  twin: true },
  // ── RAW_FG_TO_FG_MAP raw input ──────────────────────────────────────────
  { id: 8812, name: 'Raw Horizon Organic Half & Half', ref: 'RAW_FG_TO_FG_MAP key (→7477)', twin: false },
]

async function suiteQL(q) {
  const res = await core.netsuitePost('/query/v1/suiteql', { q })
  return res?.body?.items || res?.items || []
}

// Normalize a name for fuzzy equality: lowercase, drop "(batch)", "milk",
// punctuation/spaces — keep digits and dots (fat percentages).
const norm = s => String(s || '')
  .toLowerCase()
  .replace(/\(batch\)/g, '')
  .replace(/milk/g, '')
  .replace(/[^a-z0-9.]/g, '')

async function main() {
  console.log(`Reconciling ${TARGETS.length} missing items against live NS (CORE_API_URL=${process.env.CORE_API_URL})\n`)

  // Pull every "Raw…" item from prod once; match in JS (names contain "%",
  // which is a LIKE wildcard, so we avoid LIKE on the full name).
  const rows = await suiteQL(`SELECT id, itemid, displayname, isinactive FROM item WHERE UPPER(itemid) LIKE 'RAW%'`)
  console.log(`Fetched ${rows.length} prod items with itemid starting "Raw".\n`)

  const prod = rows.map(r => ({
    id: Number(r.id),
    itemId: r.itemid || '',
    displayName: r.displayname || '',
    inactive: r.isinactive === 'T' || r.isinactive === true,
    isTwin: /\(batch\)/i.test(r.itemid || ''),
  }))

  const remap = [], create = [], ambiguous = []

  for (const t of TARGETS) {
    const want = norm(t.name)
    // candidate = same normalized base AND same twin-ness (twin has "(Batch)")
    let cands = prod.filter(p => norm(p.itemId) === want && p.isTwin === t.twin)
    if (!cands.length) // relax twin-ness if nothing matched exactly
      cands = prod.filter(p => norm(p.itemId) === want)

    const tag = t.twin ? 'twin' : 'raw '
    if (cands.length === 1) {
      const c = cands[0]
      remap.push({ t, c })
      console.log(`  REMAP  [${t.id}] ${tag} "${t.name}"  →  prod id ${c.id} "${c.itemId}"${c.inactive ? ' (INACTIVE!)' : ''}`)
    } else if (cands.length > 1) {
      ambiguous.push({ t, cands })
      console.log(`  AMBIG  [${t.id}] ${tag} "${t.name}"  →  ${cands.map(c => `${c.id} "${c.itemId}"`).join(' | ')}`)
    } else {
      create.push(t)
      console.log(`  CREATE [${t.id}] ${tag} "${t.name}"  →  no prod match`)
    }
  }

  console.log(`\n── SUMMARY ──────────────────────────────────────────────`)
  console.log(`  REMAP (exists in prod, different id): ${remap.length}`)
  console.log(`  CREATE (absent in prod):              ${create.length}`)
  console.log(`  AMBIGUOUS (manual review):            ${ambiguous.length}`)
  if (remap.length) {
    console.log(`\n  Suggested code remaps:`)
    for (const { t, c } of remap) console.log(`    ${t.ref}: ${t.id} → ${c.id}`)
  }
  if (create.length) {
    console.log(`\n  Must create in prod NS:`)
    for (const t of create) console.log(`    [${t.id}] ${t.twin ? '(lot-tracked twin) ' : ''}${t.name}  — ${t.ref}`)
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
