/**
 * Probe NetSuite's "insufficient inventory" error path.
 *
 * Issues a workOrderIssue with a deliberately-too-large quantity against a
 * real sandbox WO/bin so we can capture the exact NS error shape. The
 * inventory back-up adjustment service (still TBD) needs to recognize this
 * specific error so it can fire a compensating IA upward before retrying.
 *
 * Usage:
 *   node scripts/probeInventoryShortage.js [woId] [itemId] [binId] [quantity]
 *
 * Defaults pull from the first active MesSurgeTankBatch — its pinned
 * componentItemId/componentBinId — and overspend by 999_999_999 lb so the
 * issue is guaranteed to fail even if the bin has plenty on hand.
 *
 * Safe to run repeatedly: failure means no inventory moved.
 */
const path = require('path')
const dotenv = require('dotenv')
dotenv.config({ path: path.resolve(__dirname, '../.env') })

const core = require('../clients/coreClient')
const { sequelize } = require('../config')
const db = require('../models')

const HUGE_QTY = 999_999_999

async function main() {
  const argv = process.argv.slice(2)
  let [woId, itemId, binId, qty] = argv
  qty = qty ? parseFloat(qty) : HUGE_QTY

  if (!woId || !itemId || !binId) {
    console.log('No target specified — picking from first active MesSurgeTankBatch.')
    await sequelize.sync()
    const row = await db.MesSurgeTankBatch.findOne({ where: { status: 'active' }, order: [['detectedAt', 'DESC']] })
    if (!row) {
      console.error('No active surge tank batch to target. Pass woId/itemId/binId/qty as CLI args.')
      process.exit(1)
    }
    woId = row.nsWorkOrderId
    itemId = row.componentItemId
    binId = row.componentBinId
    console.log(`  Target: WO ${woId} (${row.nsWorkOrderNumber}) on ${row.tankId} -> component item ${itemId} from bin ${binId}`)
  }

  if (!woId || !itemId || !binId) {
    console.error('Could not resolve a target — pass all four CLI args.')
    process.exit(1)
  }

  console.log()
  console.log('=== Probe parameters ===')
  console.log(`  woId:    ${woId}`)
  console.log(`  itemId:  ${itemId}`)
  console.log(`  binId:   ${binId}`)
  console.log(`  qty:     ${qty.toLocaleString()} lb`)
  console.log()

  // Fetch the WO's BOM so we can set every non-target line to qty 0 (the
  // canonical issue body shape from blendTankMesService.buildWoIssueBody).
  console.log(`Fetching WO ${woId} BOM...`)
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${woId}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const bomLines = (wo?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id) }))
  console.log(`  BOM: ${bomLines.map(l => `line${l.line}=item${l.itemId}`).join(', ') || '(empty)'}`)

  const target = bomLines.find(l => l.itemId === String(itemId))
  if (!target) {
    console.error(`  Item ${itemId} not on WO ${woId} BOM — cannot probe with this target.`)
    process.exit(1)
  }

  // Variant: only include the target line in the items array. NS may then
  // leave other lines unchanged (vs. our normal pattern which zeros them
  // out). Lets us reach the inventory-quantity validation without tripping
  // a "configure inventoryDetail on line N" error from auxiliary items.
  const variant = process.env.PROBE_VARIANT || 'target-only'
  let body
  if (variant === 'zero-others') {
    body = {
      component: {
        items: bomLines.map(c => c.itemId === String(itemId)
          ? {
              lineNumber: c.line,
              quantity: qty,
              inventoryDetail: {
                inventoryAssignment: {
                  items: [{
                    quantity: qty,
                    binnumber: { id: Number(binId) },
                    inventoryStatus: { id: 1 },
                  }],
                },
              },
            }
          : { lineNumber: c.line, quantity: 0 }),
      },
    }
  } else if (variant === 'zero-with-detail') {
    // Force every non-target line to qty=0 AND include an empty
    // inventoryDetail so NS doesn't try to auto-populate from BOM defaults.
    body = {
      component: {
        items: bomLines.map(c => c.itemId === String(itemId)
          ? {
              lineNumber: c.line,
              quantity: qty,
              inventoryDetail: {
                inventoryAssignment: {
                  items: [{
                    quantity: qty,
                    binnumber: { id: Number(binId) },
                    inventoryStatus: { id: 1 },
                  }],
                },
              },
            }
          : {
              lineNumber: c.line,
              quantity: 0,
              inventoryDetail: { inventoryAssignment: { items: [] } },
            }),
      },
    }
  } else {
    // target-only: omit non-target lines entirely
    body = {
      component: {
        items: [{
          lineNumber: target.line,
          quantity: qty,
          inventoryDetail: {
            inventoryAssignment: {
              items: [{
                quantity: qty,
                binnumber: { id: Number(binId) },
                inventoryStatus: { id: 1 },
              }],
            },
          },
        }],
      },
    }
  }
  console.log(`Variant: ${variant}`)

  console.log()
  console.log('Issue body:')
  console.log(JSON.stringify(body, null, 2))
  console.log()
  console.log('Posting...')

  try {
    const result = await core.netsuitePost(`/record/v1/workOrder/${woId}/!transform/workOrderIssue`, body)
    console.log()
    console.log('=== UNEXPECTED SUCCESS ===')
    console.log('NS accepted the issue — quantity was small enough or bin had unexpected stock.')
    console.log(JSON.stringify(result, null, 2))
  } catch (err) {
    console.log()
    console.log('=== ERROR RESPONSE (this is what we want) ===')
    console.log(`HTTP status: ${err.status}`)
    console.log(`Message: ${err.message}`)
    console.log()
    console.log('err.data:')
    console.log(JSON.stringify(err.data, null, 2))
  } finally {
    try { await sequelize.close() } catch {}
  }
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
