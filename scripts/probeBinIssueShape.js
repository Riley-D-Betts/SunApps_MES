/**
 * SANDBOX probe. Tries bin-only workOrderIssue assignment shapes at a tiny
 * quantity against a real WO to find which one NS actually credits. Stops at
 * the first SUCCESS so at most 1 lb of inventory moves. Read NS URL first to
 * confirm sandbox before running against anything real.
 *
 * Usage: node scripts/probeBinIssueShape.js [woId] [itemId] [binId] [qty]
 */
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
const core = require('../clients/coreClient')

const WO_ID = process.argv[2] || '4812435'
const ITEM = process.argv[3] || '5403'
const BIN = process.argv[4] || '4933'
const QTY = parseFloat(process.argv[5] || '1')

function variants(line) {
  return [
    {
      name: 'A: lowercase componentinventorydetail + binnumber string + status',
      entry: { lineNumber: line, quantity: QTY, componentinventorydetail: { inventoryassignment: { items: [{ status: 1, quantity: QTY, binnumber: String(BIN) }] } } },
    },
    {
      name: 'B: lowercase + binnumber {id} + inventoryStatus {id}',
      entry: { lineNumber: line, quantity: QTY, componentinventorydetail: { inventoryassignment: { items: [{ quantity: QTY, binnumber: { id: Number(BIN) }, inventoryStatus: { id: 1 } }] } } },
    },
    {
      name: 'C: camelCase inventoryDetail + binnumber {id} + inventoryStatus {id}',
      entry: { lineNumber: line, quantity: QTY, inventoryDetail: { inventoryAssignment: { items: [{ quantity: QTY, binnumber: { id: Number(BIN) }, inventoryStatus: { id: 1 } }] } } },
    },
    {
      name: 'D: no inventory detail (let NS auto-place)',
      entry: { lineNumber: line, quantity: QTY },
    },
  ]
}

async function main() {
  const w = await core.netsuiteGet(`/record/v1/workOrder/${WO_ID}?expandSubResources=true`)
  const wo = w?.body || w
  const url = wo?.item?.items?.[0]?.item?.links?.[0]?.href || ''
  console.log(`NS host: ${url.split('/services')[0] || '(unknown)'}`)
  if (!/sb\d|sandbox|-sb/.test(url)) { console.error('NOT a sandbox URL — aborting.'); process.exit(1) }
  const bom = (wo?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id) }))
  const target = bom.find(l => l.itemId === String(ITEM))
  if (!target) { console.error(`item ${ITEM} not on WO ${WO_ID}`); process.exit(1) }
  console.log(`Probing WO ${WO_ID} line ${target.line} item ${ITEM} bin ${BIN} @ ${QTY} lb\n`)

  for (const v of variants(target.line)) {
    const body = { component: { items: [v.entry] } }
    try {
      const res = await core.netsuitePost(`/record/v1/workOrder/${WO_ID}/!transform/workOrderIssue`, body)
      console.log(`✅ SUCCESS — ${v.name}`)
      console.log(`   issueId: ${res?.body?.id || res?.id || '(see headers)'}`)
      console.log(`   body: ${JSON.stringify(body)}`)
      console.log('\nStopping at first success.')
      return
    } catch (err) {
      const detail = (() => { try { return JSON.parse(JSON.parse(err.data?.error || err.message.replace(/^[^{]*/, '')).replace(/^HTTP \d+: /, ''))?.['o:errorDetails']?.[0]?.detail } catch { return null } })()
      console.log(`❌ ${v.name}`)
      console.log(`   ${detail || (err.message || '').slice(0, 240)}\n`)
    }
  }
  console.log('No variant succeeded.')
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1) })
