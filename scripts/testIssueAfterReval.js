/**
 * Validation: after revaluing item 8370, post a tiny (1 lb) workOrderIssue of a
 * real component into WO 4897436 and report the outcome. The weekend failures
 * tripped on 8370's missing cost basis when issuing ANY component into this WO,
 * so a clean success here (or a non-costing error) proves the reval unblocked it.
 *
 *   node scripts/testIssueAfterReval.js
 */
const core = require('../clients/coreClient')
const nsInventory = require('../services/nsInventoryLookup')

const WO = '4897436'
const COMPONENT_ITEM = '5403' // Raw Organic A2 Milk (line 4 on this WO)
const QTY = 1

async function main() {
  const binId = await nsInventory.findBinForItem(COMPONENT_ITEM, null, QTY)
  console.log(`resolved bin for ${COMPONENT_ITEM}: ${binId}`)
  if (!binId) { console.log('no bin found — cannot test'); return }

  // Production transform-endpoint shape: bin-only line on a lot-bearing WO uses
  // lowercase componentinventorydetail (see buildWoIssueBody / [[ns-wo-issue-shape]]).
  const body = {
    component: {
      items: [{
        lineNumber: 4, // 5403 is line 4 on this WO
        quantity: QTY,
        componentinventorydetail: {
          inventoryassignment: { items: [{ status: 1, quantity: QTY, binnumber: { id: binId } }] },
        },
      }],
    },
  }
  console.log('issuing 1 lb of', COMPONENT_ITEM, 'into WO', WO, '(transform endpoint) ...')
  try {
    const r = await core.netsuitePost(`/record/v1/workOrder/${WO}/!transform/workOrderIssue`, body)
    console.log('✓ SUCCESS — issue posted. status=', r?.status, 'id=', r?.id || r?.body?.id || (r?.headers?.location || ''))
    console.log('→ Revaluation cleared the costing block.')
  } catch (e) {
    const msg = String(e.message)
    const isReval = /Inventory Revaluation is no longer the first/i.test(msg)
    console.log(isReval ? '✗ STILL the revaluation error — reval did NOT unblock:' : '✗ different error (costing block likely cleared):')
    console.log('  ', msg.slice(0, 400))
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
