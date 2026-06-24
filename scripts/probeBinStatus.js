/**
 * READ-ONLY diagnostic. No inventory is moved.
 *
 * For a given WO, find its line-2 component item, then dump every
 * inventorybalance row for that item in bin 4933 — including inventorystatus,
 * quantityonhand, and quantityavailable. Confirms whether the on-hand stock is
 * under inventory status id 1 (what buildAssignmentItems issues against) or a
 * different status that our assignment can't match.
 *
 * Usage: node scripts/probeBinStatus.js [woId] [binId]
 */
const path = require('path')
const dotenv = require('dotenv')
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const core = require('../clients/coreClient')

const WO_ID = process.argv[2] || '4812435'
const BIN_ID = process.argv[3] || '4933'

async function main() {
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${WO_ID}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const bom = (wo?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id), qty: c.quantity }))
  console.log('BOM:', bom.map(l => `line${l.line}=item${l.itemId}@${l.qty}`).join(', '))
  const target = bom.find(l => l.line === 2) || bom[0]
  if (!target) { console.error('No BOM line found'); process.exit(1) }
  const itemId = target.itemId
  console.log(`\nTarget item (line ${target.line}): ${itemId}\n`)

  const q = `
    SELECT bal.inventorystatus AS status_id,
           st.name             AS status_name,
           bal.binnumber       AS bin_id,
           bal.inventorynumber AS lot_id,
           bal.quantityonhand    AS on_hand,
           bal.quantityavailable AS available
    FROM inventorybalance bal
    LEFT JOIN inventorystatus st ON st.id = bal.inventorystatus
    WHERE bal.item = ${Number(itemId)}
      AND bal.binnumber = ${Number(BIN_ID)}
      AND bal.location = 30
  `
  const res = await core.netsuitePost('/query/v1/suiteql', { q })
  const rows = res?.body?.items || res?.items || []
  console.log(`inventorybalance rows for item ${itemId} in bin ${BIN_ID}:`)
  if (rows.length === 0) { console.log('  (none)') }
  for (const r of rows) {
    console.log(`  status=${r.status_id} (${r.status_name}) lot=${r.lot_id ?? '-'} onHand=${r.on_hand} available=${r.available}`)
  }
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1) })
