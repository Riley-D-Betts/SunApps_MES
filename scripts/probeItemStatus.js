#!/usr/bin/env node
/**
 * Check which NS items in the MES catalogs have been deleted or made inactive.
 *
 * Usage:
 *   CORE_API_URL=https://sundev01.mes.suntado.com node scripts/probeItemStatus.js
 *
 * Exits with a list of items that are inactive or missing from NS entirely.
 */
const core = require('../clients/coreClient')

// All item IDs referenced across blendTankProductParser, surgeTankProductParser,
// mesItemConfig (RAW_ITEMS, SILO_ITEM_MAP, RAW_FG_TO_FG_MAP, etc.), and the
// lot-tracked BOM vitamins/citrate.
const CATALOG = [
  // ── Raw / blend-tank inputs ──────────────────────────────────────────────
  { id: 8333,  label: 'Raw Alexandre A2/A2 Organic 4% Whole Milk' },
  { id: 8371,  label: 'Raw Alexandre A2/A2 Organic Chocolate 4% Milk' },
  { id: 8357,  label: 'Raw DFI Holiday Nog' },
  { id: 8356,  label: "Raw DFI Marcel's Modern Pantry Heavy Cream" },
  { id: 8355,  label: "Raw DFI Marcel's Modern Pantry UHT Half & Half" },
  { id: 8354,  label: 'Raw DFI Marcels 0% Milk' },
  { id: 8340,  label: 'Raw DFI Marcels 1% Milk' },
  { id: 8918,  label: 'Raw DFI Marcels Chocolate 1% Milk' },
  { id: 8339,  label: 'Raw DFI Marcels 2% Milk' },
  { id: 8353,  label: 'Raw DFI Marcels 3.25% Milk' },
  { id: 8350,  label: 'Raw ESL Half & Half' },
  { id: 8349,  label: 'Raw ESL Heavy Whip Cream' },
  { id: 8335,  label: 'Raw Horizon Organic 2% Milk' },
  { id: 8348,  label: 'Raw Horizon Organic 3.25% Whole Milk' },
  { id: 8812,  label: 'Raw Horizon Organic Half & Half' },
  { id: 8347,  label: 'Raw Kirkland 1% Organic Milk' },
  { id: 8346,  label: 'Raw Kirkland 2% Organic Lac Free Milk' },
  { id: 8344,  label: 'Raw Kirkland 2% Organic Milk' },
  { id: 8343,  label: 'Raw Kirkland Chocolate 2% Organic Milk - Aseptic' },
  { id: 8342,  label: 'Raw Kirkland Organic Whole Milk' },
  { id: 8815,  label: 'Raw Aldi 2% Organic Milk' },
  { id: 8816,  label: 'Raw Aldi 3.25% Organic Whole Milk' },
  { id: 8817,  label: 'Raw Aldi 3.25% Organic Whole Milk w/ DHA' },
  { id: 8364,  label: 'Raw American Farmer Whole Milk' },
  { id: 8363,  label: 'Raw Barista Frappe Mix' },
  { id: 8336,  label: 'Raw Kinera Chocolate' },
  { id: 8334,  label: 'Raw Kinera Strawberry' },
  { id: 8352,  label: 'Raw DG Half & Half' },
  { id: 8351,  label: 'Raw DG Heavy Cream' },
  { id: 8341,  label: 'Raw Organic Milk 0% Lac Free' },
  // In RAW_FG_TO_FG_MAP but not in the parser catalog:
  { id: 8362,  label: 'Raw Conventional Milk 1%' },
  { id: 8361,  label: 'Raw Conventional Milk 2%' },
  { id: 8360,  label: 'Raw Conventional Milk 3.25%' },
  { id: 8359,  label: 'Raw Conventional Milk 3.5%' },
  { id: 8358,  label: 'Raw Conventional Whole Milk 3.25% (No Vitamins)' },

  // ── Separator / bulk raw inputs ──────────────────────────────────────────
  { id: 5417,  label: 'Raw Conventional Milk (bulk)' },
  { id: 5404,  label: 'Raw Organic Milk (bulk)' },
  { id: 5403,  label: 'Raw Organic A2 Milk' },
  { id: 5406,  label: 'Raw Organic Grade A (A2/A2) Milk' },

  // ── Conventional post-separator ──────────────────────────────────────────
  { id: 8163,  label: 'Raw Conventional 0% - Skim' },
  { id: 5415,  label: 'Raw Conventional 1%' },
  { id: 5412,  label: 'Raw Conventional 2%' },
  { id: 5413,  label: 'Raw Conventional 3.25%' },
  { id: 5416,  label: 'Raw Conventional 3.5%' },
  { id: 5480,  label: 'Raw Conventional Cream' },
  { id: 5405,  label: 'Raw Conventional UF Milk' },

  // ── Organic post-separator ───────────────────────────────────────────────
  { id: 5482,  label: 'Raw Organic 0%' },
  { id: 5409,  label: 'Raw Organic 1%' },
  { id: 5410,  label: 'Raw Organic 2%' },
  { id: 5411,  label: 'Raw Organic 3.25%' },
  { id: 5401,  label: 'Raw Organic 3.5%' },
  { id: 5483,  label: 'Raw Organic Cream' },
  { id: 5402,  label: 'Raw Organic UF Milk' },

  // ── A2 post-separator ────────────────────────────────────────────────────
  { id: 5484,  label: 'Raw Organic A2 0%' },
  { id: 8366,  label: 'Raw Organic A2 1%' },
  { id: 8367,  label: 'Raw Organic A2 2%' },
  { id: 8368,  label: 'Raw Organic A2 3.25%' },
  { id: 8369,  label: 'Raw Organic A2 3.5%' },
  { id: 8370,  label: 'Raw Organic A2 4%' },
  { id: 8365,  label: 'Raw Organic A2 Cream' },

  // ── FG / surge-tank outputs ──────────────────────────────────────────────
  { id: 3278,  label: 'Alexandre A2/A2 Organic 4% Whole Milk (FG)' },
  { id: 4899,  label: 'Alexandre A2/A2 Organic Chocolate 4% Milk (FG)' },
  { id: 5510,  label: 'American Farmer Whole Milk (FG)' },
  { id: 5314,  label: 'Barista Frappe Mix (FG)' },
  { id: 3395,  label: 'DFI Holiday Nog (FG)' },
  { id: 3493,  label: "DFI Marcel's Modern Pantry Heavy Cream (FG)" },
  { id: 2940,  label: "DFI Marcel's Modern Pantry UHT Half & Half (FG)" },
  { id: 3222,  label: 'DFI Marcels 0% Milk (FG)' },
  { id: 3228,  label: 'DFI Marcels 1% Milk (FG)' },
  { id: 8271,  label: 'DFI Marcels Chocolate 1% Milk (FG)' },
  { id: 4012,  label: 'DFI Marcels 2% Milk (FG)' },
  { id: 3236,  label: 'DFI Marcels 3.25% Milk (FG)' },
  { id: 2889,  label: 'DG Half & Half (FG)' },
  { id: 2790,  label: 'DG Heavy Cream (FG)' },
  { id: 3900,  label: 'ESL Half & Half (FG)' },
  { id: 3905,  label: 'ESL Heavy Whip Cream (FG)' },
  { id: 5911,  label: 'Horizon Organic 2% Milk (FG)' },
  { id: 5907,  label: 'Horizon Organic 3.25% Whole Milk (FG)' },
  { id: 7477,  label: 'Horizon Organic Half & Half (FG)' },
  { id: 5317,  label: 'Kinera Chocolate (FG)' },
  { id: 5003,  label: 'Kinera Strawberry (FG)' },
  { id: 4495,  label: 'Kirkland 1% Organic Milk (FG)' },
  { id: 4501,  label: 'Kirkland 2% Organic Lac Free Milk (FG)' },
  { id: 4498,  label: 'Kirkland 2% Organic Milk (FG)' },
  { id: 4548,  label: 'Kirkland Chocolate 2% Organic Milk - Aseptic (FG)' },
  { id: 6420,  label: 'Kirkland Organic Whole Milk (FG)' },
  { id: 8401,  label: 'Aldi 2% Organic Milk (FG)' },
  { id: 8406,  label: 'Aldi 3.25% Organic Whole Milk (FG)' },
  { id: 8409,  label: 'Aldi 3.25% Organic Whole Milk w/ DHA (FG)' },
  { id: 3926,  label: 'Organic Milk 0% Lac Free (FG)' },
  // FG for conventional variants not in parser but in RAW_FG_TO_FG_MAP:
  { id: 2793,  label: 'Conventional Milk 1% (FG)' },
  { id: 3471,  label: 'Conventional Milk 2% (FG)' },
  { id: 2808,  label: 'Conventional Milk 3.25% (FG)' },
  { id: 2645,  label: 'Conventional Milk 3.5% (FG)' },
  { id: 3223,  label: 'Conventional Whole Milk 3.25% No Vitamins (FG)' },

  // ── Lot-tracked BOM components (vitamins / citrate) ──────────────────────
  { id: 530,   label: 'Vitamin premix (lot-tracked)' },
  { id: 531,   label: 'Vitamin premix (lot-tracked)' },
  { id: 7235,  label: 'Citrate (lot-tracked)' },
]

;(async () => {
  console.log(`CORE_API_URL = ${process.env.CORE_API_URL || '(default localhost:4000)'}`)
  console.log(`Checking ${CATALOG.length} items against NS...\n`)

  const idList = CATALOG.map(i => i.id).join(',')
  const q = `SELECT id, displayname, isinactive FROM item WHERE id IN (${idList}) ORDER BY id`

  let rows
  try {
    const res = await core.netsuitePost('/query/v1/suiteql', { q })
    rows = res?.body?.items || res?.items || []
  } catch (err) {
    console.error(`SuiteQL failed: ${err.message.slice(0, 500)}`)
    process.exit(1)
  }

  // Index NS results by id
  const found = new Map()
  for (const r of rows) {
    found.set(Number(r.id), { displayname: r.displayname, inactive: r.isinactive === 'T' || r.isinactive === true })
  }

  const deleted  = []
  const inactive = []
  const ok       = []

  for (const item of CATALOG) {
    const r = found.get(item.id)
    if (!r) {
      deleted.push(item)
    } else if (r.inactive) {
      inactive.push({ ...item, nsName: r.displayname })
    } else {
      ok.push({ ...item, nsName: r.displayname })
    }
  }

  if (deleted.length === 0 && inactive.length === 0) {
    console.log(`All ${CATALOG.length} items are active in NS. Nothing to recreate.`)
    return
  }

  if (deleted.length > 0) {
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`DELETED (${deleted.length}) — not found in NS at all:`)
    console.log(`${'═'.repeat(60)}`)
    for (const i of deleted) {
      console.log(`  ${String(i.id).padEnd(6)}  ${i.label}`)
    }
  }

  if (inactive.length > 0) {
    console.log(`\n${'═'.repeat(60)}`)
    console.log(`INACTIVE (${inactive.length}) — exist but isinactive=T:`)
    console.log(`${'═'.repeat(60)}`)
    for (const i of inactive) {
      console.log(`  ${String(i.id).padEnd(6)}  ${i.nsName || i.label}`)
    }
  }

  console.log(`\n${'─'.repeat(60)}`)
  console.log(`Summary: ${deleted.length} deleted, ${inactive.length} inactive, ${ok.length} active`)
})().catch(err => {
  console.error('Probe failed:', err.message)
  process.exit(1)
})
