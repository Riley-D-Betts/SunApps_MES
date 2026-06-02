/**
 * SANDBOX probe. Tests whether setting an explicit line `unitcost` clears the
 * "Lines cannot have a negative unit cost" rejection on an up-adjust of a
 * bin-only standard-cost item. Posts at most 1 lb; stops at first success.
 *
 * Usage: node scripts/probeAdjustUnitCost.js [itemId] [binId] [qty]
 */
const path = require('path')
require('dotenv').config({ path: path.resolve(__dirname, '../.env') })
const core = require('../clients/coreClient')

const ITEM = Number(process.argv[2] || 5403)
const BIN = Number(process.argv[3] || 4933)
const QTY = parseFloat(process.argv[4] || '1')

const NS_LOCATION_ID = 30
const NS_SUBSIDIARY_ID = 3
const NS_ADJ_ACCOUNT_ID = 476

function baseBody(extraLine) {
  const item = {
    item: ITEM,
    adjustQtyBy: QTY,
    line: 1,
    location: NS_LOCATION_ID,
    department: { id: '7' },
    inventoryDetail: {
      inventoryAssignment: { items: [{ status: 1, quantity: QTY, binnumber: { id: String(BIN) } }] },
    },
    ...extraLine,
  }
  return {
    account: NS_ADJ_ACCOUNT_ID,
    adjLocation: NS_LOCATION_ID,
    subsidiary: NS_SUBSIDIARY_ID,
    customForm: 10,
    department: 7,
    memo: 'PROBE unitcost',
    inventory: { items: [item] },
  }
}

const variants = [
  { name: 'current (no unitcost)', body: baseBody({}) },
  { name: 'unitcost: 0.58 (standard cost)', body: baseBody({ unitcost: 0.58 }) },
  { name: 'unitcost: 0', body: baseBody({ unitcost: 0 }) },
]

async function main() {
  for (const v of variants) {
    try {
      const res = await core.netsuitePost('/record/v1/inventoryAdjustment', v.body)
      console.log(`✅ SUCCESS — ${v.name}  (id ${res?.body?.id || res?.id || 'see headers'})`)
      console.log(`   body: ${JSON.stringify(v.body)}`)
      console.log('\nStopping at first success.')
      return
    } catch (err) {
      let detail = err.message
      try { detail = JSON.parse(JSON.parse(err.data?.error || err.message.replace(/^[^{]*/, '')).replace(/^HTTP \d+: /, ''))?.['o:errorDetails']?.[0]?.detail } catch {}
      console.log(`❌ ${v.name}: ${detail}`)
    }
  }
  console.log('No variant succeeded.')
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1) })
