/**
 * Probe NS for the correct issue body shape when the WO BOM has lot-tracked
 * aux components. Tries multiple field-name variants against an active
 * surge tank WO. The MES code's current camelCase inventoryDetail with
 * binnumber object fails on lines 4/5 of WO1365 (lot-tracked vitamins).
 * Manufacturing code uses lowercase componentinventorydetail / inventoryassignment
 * — try that here.
 *
 * Each variant uses a real but tiny target qty (10 lb) so that if NS DOES
 * accept it, we see an inventory-quantity error rather than a body-shape
 * error. The target item is the pinned componentItemId on ST84 (8340).
 *
 * Usage: node scripts/probeLotShape.js [variant]
 *   variants: lowercase-empty | lowercase-omit-aux | lowercase-with-lot
 */
const path = require('path')
const dotenv = require('dotenv')
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const core = require('../clients/coreClient')

const WO_ID = '4697490'  // ST84 / WO1365 / Marcels 1%
const TARGET_ITEM = 8340 // Raw DFI Marcels 1% Milk (bin-tracked assembly)
const TARGET_BIN = 1016  // BlendTank1A
const TARGET_QTY = 10    // small enough to potentially succeed if body shape is right

const variant = process.argv[2] || 'lowercase-empty'

async function findFirstLotForItem(itemId) {
  const q = `
    SELECT inv.id AS lot_id, inv.inventorynumber AS lot_name,
           bal.quantityonhand AS qty, bal.binnumber AS bin_id
    FROM inventorybalance bal
    JOIN inventorynumber inv ON inv.id = bal.inventorynumber
    WHERE bal.item = ${itemId}
      AND bal.location = 23
      AND bal.quantityonhand > 0
    ORDER BY inv.id ASC
  `
  try {
    const res = await core.netsuitePost('/query/v1/suiteql', { q })
    const items = res?.body?.items || res?.items || []
    return items[0] || null
  } catch (e) {
    console.log(`  (suiteql failed for item ${itemId}: ${e.message.slice(0, 100)})`)
    return null
  }
}

async function main() {
  console.log(`Variant: ${variant}`)
  const w = await core.netsuiteGet(`/record/v1/workOrder/${WO_ID}?expandSubResources=true`)
  const wo = w?.body || w
  const bomLines = (wo?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id), qty: c.quantity }))
  console.log('BOM:', bomLines.map(l => `line${l.line}=item${l.itemId}@${l.qty}`).join(', '))

  // Pre-fetch lots for lot-tracked aux items (530, 7235 confirmed lot, 5415/5417 bin)
  const auxLotItems = [530, 7235]
  const auxLots = {}
  for (const itemId of auxLotItems) {
    const lot = await findFirstLotForItem(itemId)
    auxLots[itemId] = lot
    console.log(`  Available lot for ${itemId}:`, lot ? `${lot.lot_name} (id=${lot.lot_id}, qty=${lot.qty})` : 'NONE')
  }

  // Per-variant body builder
  let items
  if (variant === 'lowercase-empty') {
    // All lowercase field names; non-target lines get empty inventoryassignment
    items = bomLines.map(c => {
      if (c.itemId === String(TARGET_ITEM)) {
        return {
          lineNumber: c.line,
          quantity: TARGET_QTY,
          componentinventorydetail: {
            inventoryassignment: {
              items: [{ status: 1, quantity: TARGET_QTY, binnumber: TARGET_BIN }],
            },
          },
        }
      }
      const lot = auxLots[c.itemId]
      if (lot) {
        return {
          lineNumber: c.line,
          quantity: 0,
          componentinventorydetail: {
            inventoryassignment: { items: [] },
          },
        }
      }
      return { lineNumber: c.line, quantity: 0 }
    })
  } else if (variant === 'lowercase-with-lot') {
    // Provide actual lot id at quantity 0 (token allocation) for lot lines
    items = bomLines.map(c => {
      if (c.itemId === String(TARGET_ITEM)) {
        return {
          lineNumber: c.line,
          quantity: TARGET_QTY,
          componentinventorydetail: {
            inventoryassignment: {
              items: [{ status: 1, quantity: TARGET_QTY, binnumber: TARGET_BIN }],
            },
          },
        }
      }
      const lot = auxLots[c.itemId]
      if (lot) {
        return {
          lineNumber: c.line,
          quantity: 0,
          componentinventorydetail: {
            inventoryassignment: {
              items: [{ status: 1, quantity: 0, issueinventorynumber: lot.lot_id }],
            },
          },
        }
      }
      return { lineNumber: c.line, quantity: 0 }
    })
  } else if (variant === 'lowercase-omit-aux') {
    // Only include target line; omit all others entirely
    items = [{
      lineNumber: bomLines.find(l => l.itemId === String(TARGET_ITEM)).line,
      quantity: TARGET_QTY,
      componentinventorydetail: {
        inventoryassignment: {
          items: [{ status: 1, quantity: TARGET_QTY, binnumber: TARGET_BIN }],
        },
      },
    }]
  } else if (variant === 'lot-and-bin') {
    // Target item 8340 is lot+bin tracked. Pull a real (lot, bin) pair with
    // on-hand inventory and issue against it. NS won't accept just a bin
    // ref — needs the lot id too.
    const tgtLot = await findFirstLotForItem(TARGET_ITEM)
    if (!tgtLot) {
      console.error('No lot found for target item — cannot probe lot-and-bin variant')
      process.exit(1)
    }
    console.log(`  Using lot ${tgtLot.lot_name} (id=${tgtLot.lot_id}) in bin ${tgtLot.bin_id}`)
    items = [{
      lineNumber: bomLines.find(l => l.itemId === String(TARGET_ITEM)).line,
      quantity: TARGET_QTY,
      componentinventorydetail: {
        inventoryassignment: {
          items: [{
            status: 1,
            quantity: TARGET_QTY,
            issueinventorynumber: tgtLot.lot_id,
            binnumber: tgtLot.bin_id,
          }],
        },
      },
    }]
  } else {
    console.error('Unknown variant')
    process.exit(1)
  }

  const body = { component: { items } }
  console.log()
  console.log('Body:')
  console.log(JSON.stringify(body, null, 2))
  console.log()

  try {
    const result = await core.netsuitePost(`/record/v1/workOrder/${WO_ID}/!transform/workOrderIssue`, body)
    console.log()
    console.log('=== SUCCESS ===')
    console.log(JSON.stringify(result, null, 2))
  } catch (err) {
    console.log()
    console.log('=== ERROR ===')
    console.log(`HTTP status: ${err.status}`)
    console.log('err.data:')
    console.log(JSON.stringify(err.data, null, 2))
  }
}

main().catch(err => { console.error(err); process.exit(1) })
