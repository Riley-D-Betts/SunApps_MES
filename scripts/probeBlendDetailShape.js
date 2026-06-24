/**
 * SANDBOX probe. Isolate the inventory-detail SHAPE for one bin-only assembly
 * component (item 5415, line 2, bin 4935) on a multi-line blend WO. V1/V2 from
 * probeBlendMultiLineIssue showed the failure is about the target line itself,
 * not the other lines — NS ignores the detail we attach. Try every plausible
 * wrapper/field shape at 1 lb; stop at first success.
 *
 * Usage: node scripts/probeBlendDetailShape.js [woId] [lineNumber] [binId]
 */
require('dotenv').config()
const core = require('../clients/coreClient')

const WO = process.argv[2] || '4813196'
const LINE = Number(process.argv[3] || 2)
const BIN = Number(process.argv[4] || 4935)
const Q = 1

const shapes = [
  ['A camelCase inventoryDetail + binnumber:{id} + inventoryStatus:{id:1}',
    { inventoryDetail: { inventoryAssignment: { items: [{ quantity: Q, binnumber: { id: BIN }, inventoryStatus: { id: 1 } }] } } }],
  ['B lowercase componentinventorydetail + binnumber:{id} + status:1',
    { componentinventorydetail: { inventoryassignment: { items: [{ quantity: Q, binnumber: { id: BIN }, status: 1 } ] } } }],
  ['C lowercase componentinventorydetail + binnumber:STRING + status:1',
    { componentinventorydetail: { inventoryassignment: { items: [{ quantity: Q, binnumber: String(BIN), status: 1 }] } } }],
  ['D lowercase componentinventorydetail + binnumber:{id} + inventoryStatus:{id:1}',
    { componentinventorydetail: { inventoryassignment: { items: [{ quantity: Q, binnumber: { id: BIN }, inventoryStatus: { id: 1 } }] } } }],
  ['E camelCase inventoryDetail + binNumber:{id} (capital N)',
    { inventoryDetail: { inventoryAssignment: { items: [{ quantity: Q, binNumber: { id: BIN }, inventoryStatus: { id: 1 } }] } } }],
  ['F lowercase componentinventorydetail + bin string + no status',
    { componentinventorydetail: { inventoryassignment: { items: [{ quantity: Q, binnumber: String(BIN) }] } } }],
]

async function tryPost(name, detail) {
  const body = { component: { items: [{ lineNumber: LINE, quantity: Q, ...detail }] } }
  try {
    const res = await core.netsuitePost(`/record/v1/workOrder/${WO}/!transform/workOrderIssue`, body)
    console.log(`\n✅ SUCCESS — ${name} (id ${res?.body?.id || res?.id || 'see headers'})`)
    console.log(`   detail: ${JSON.stringify(detail)}`)
    return true
  } catch (err) {
    let d = err.message
    try {
      const inner = JSON.parse(String(err.data?.error || err.message).replace(/^HTTP \d+: /, '').replace(/^[^{]*/, ''))
      d = inner?.['o:errorDetails']?.[0]?.detail || JSON.stringify(inner).slice(0, 160)
    } catch {}
    console.log(`❌ ${name}\n   → ${String(d).slice(0, 170)}`)
    return false
  }
}

async function main() {
  for (const [name, detail] of shapes) {
    if (await tryPost(name, detail)) return
  }
  console.log('\nNo shape succeeded.')
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
