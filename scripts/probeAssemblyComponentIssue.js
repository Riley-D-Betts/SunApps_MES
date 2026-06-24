/**
 * SANDBOX probe. Item 5415 (assemblyitem, bin-only) workOrderIssue on WO
 * 4813136 keeps failing with "Please configure the inventory detail in line 1".
 * That's NS silently ignoring the inventory-detail wrapper. Tries each body
 * shape at 1 lb against the live transform endpoint; stops at first success.
 *
 * Usage: node scripts/probeAssemblyComponentIssue.js [woId] [itemId] [binId] [line] [qty]
 */
require('dotenv').config()
const core = require('../clients/coreClient')

const WO = process.argv[2] || '4813136'
const ITEM = Number(process.argv[3] || 5415)
const BIN = Number(process.argv[4] || 4935)
const LINE = Number(process.argv[5] || 1)
const QTY = parseFloat(process.argv[6] || '1')

function comp(detail) {
  // Mirror the real buildWoIssueBody entry: lineNumber + quantity + detail, no `item`.
  return { component: { items: [{ lineNumber: LINE, quantity: QTY, ...detail }] } }
}

const variants = [
  {
    name: 'A camelCase inventoryDetail + inventoryStatus:{id:1} (current buildComponentDetail)',
    body: comp({ inventoryDetail: { inventoryAssignment: { items: [{ quantity: QTY, binnumber: { id: BIN }, inventoryStatus: { id: 1 } }] } } }),
  },
  {
    name: 'B lowercase componentinventorydetail + binnumber:{id} + status:1',
    body: comp({ componentinventorydetail: { inventoryassignment: { items: [{ quantity: QTY, binnumber: { id: BIN }, status: 1 }] } } }),
  },
  {
    name: 'C lowercase componentinventorydetail + binnumber:{id} + inventoryStatus:{id:1}',
    body: comp({ componentinventorydetail: { inventoryassignment: { items: [{ quantity: QTY, binnumber: { id: BIN }, inventoryStatus: { id: 1 } }] } } }),
  },
  {
    name: 'D camelCase inventoryDetail + binNumber:{id} (capital N) + inventoryStatus:{id:1}',
    body: comp({ inventoryDetail: { inventoryAssignment: { items: [{ quantity: QTY, binNumber: { id: BIN }, inventoryStatus: { id: 1 } }] } } }),
  },
]

async function main() {
  for (const v of variants) {
    try {
      const res = await core.netsuitePost(`/record/v1/workOrder/${WO}/!transform/workOrderIssue`, v.body)
      console.log(`✅ SUCCESS — ${v.name}  (id ${res?.body?.id || res?.id || 'see headers'})`)
      console.log(`   body: ${JSON.stringify(v.body)}`)
      console.log('\nStopping at first success.')
      return
    } catch (err) {
      let detail = err.message
      try {
        const inner = JSON.parse(String(err.data?.error || err.message).replace(/^HTTP \d+: /, '').replace(/^[^{]*/, ''))
        detail = inner?.['o:errorDetails']?.[0]?.detail || JSON.stringify(inner).slice(0, 200)
      } catch {}
      console.log(`❌ ${v.name}\n   → ${String(detail).slice(0, 220)}`)
    }
  }
  console.log('\nNo variant succeeded.')
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
