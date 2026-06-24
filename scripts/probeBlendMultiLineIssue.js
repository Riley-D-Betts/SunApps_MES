/**
 * SANDBOX probe. A blend WO has MANY component lines; the workOrderIssue
 * transform pre-populates ALL of them at default qty and demands inventory
 * detail for every tracked line, so issuing one line while omitting the rest
 * fails with "configure the inventory detail in line N". This probes which
 * body shape lets us issue ONE component (1 lb of item 5415 from bin 4935)
 * while neutralizing the others.
 *
 * Usage: node scripts/probeBlendMultiLineIssue.js [woId] [targetItemId] [binId]
 */
require('dotenv').config()
const core = require('../clients/coreClient')

const WO = process.argv[2] || '4813196'
const TARGET_ITEM = String(process.argv[3] || '5415')
const BIN = Number(process.argv[4] || 4935)
const QTY = 1

function detailFor(qty) {
  return { inventoryDetail: { inventoryAssignment: { items: [{ quantity: qty, binnumber: { id: BIN }, inventoryStatus: { id: 1 } }] } } }
}

async function getLines() {
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${WO}?expandSubResources=true`)
  return ((wrap?.body || wrap)?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id) }))
}

async function tryPost(name, body) {
  try {
    const res = await core.netsuitePost(`/record/v1/workOrder/${WO}/!transform/workOrderIssue`, body)
    console.log(`\n✅ SUCCESS — ${name} (id ${res?.body?.id || res?.id || 'see headers'})`)
    console.log(`   body: ${JSON.stringify(body)}`)
    return true
  } catch (err) {
    let detail = err.message
    try {
      const inner = JSON.parse(String(err.data?.error || err.message).replace(/^HTTP \d+: /, '').replace(/^[^{]*/, ''))
      detail = inner?.['o:errorDetails']?.[0]?.detail || JSON.stringify(inner).slice(0, 200)
    } catch {}
    console.log(`❌ ${name}\n   → ${String(detail).slice(0, 200)}`)
    return false
  }
}

async function main() {
  const lines = await getLines()
  const firstTarget = lines.find(l => l.itemId === TARGET_ITEM)
  if (!firstTarget) { console.log(`item ${TARGET_ITEM} not on WO`); return }
  console.log(`Target item ${TARGET_ITEM} is on line ${firstTarget.line}. Lines: ${lines.map(l => `${l.line}:${l.itemId}`).join(', ')}`)

  // Variant 1 (control, current code): only the target line, addressed by lineNumber.
  if (await tryPost('V1 only target line (lineNumber)', {
    component: { items: [{ lineNumber: firstTarget.line, quantity: QTY, ...detailFor(QTY) }] },
  })) return

  // Variant 2: ALL lines via lineNumber — target gets qty+detail, others qty 0.
  if (await tryPost('V2 all lines via lineNumber, others qty:0', {
    component: { items: lines.map(l => l.line === firstTarget.line
      ? { lineNumber: l.line, quantity: QTY, ...detailFor(QTY) }
      : { lineNumber: l.line, quantity: 0 }) },
  })) return

  // Variant 3: ALL lines via `line` field — target gets qty+detail, others qty 0.
  if (await tryPost('V3 all lines via line, others qty:0', {
    component: { items: lines.map(l => l.line === firstTarget.line
      ? { line: l.line, quantity: QTY, ...detailFor(QTY) }
      : { line: l.line, quantity: 0 }) },
  })) return

  // Variant 4: only target line addressed by `line` field.
  if (await tryPost('V4 only target line (line field)', {
    component: { items: [{ line: firstTarget.line, quantity: QTY, ...detailFor(QTY) }] },
  })) return

  console.log('\nNo variant succeeded.')
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
