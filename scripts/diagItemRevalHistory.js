/**
 * Inspect the NetSuite transaction history behind the "Inventory Revaluation is
 * no longer the first transaction in the item's history" error.
 *
 * For the failing blend WO we:
 *   1. fetch its BOM to learn the component item(s) being issued
 *   2. for the assembly item (8370) AND each component item, list every NS
 *      transaction touching that item ordered by date — so we can see where the
 *      Inventory Revaluation sits and what (if anything) predates it.
 *
 * Read-only. Uses Core API SuiteQL.
 */
const core = require('../clients/coreClient')

const WO = process.argv[2] || '4897436'
const ASSEMBLY_ITEM = '8370'

function rows(res) {
  return res?.items || res?.body?.items || res?.data?.items || []
}

async function sql(q) {
  // Use the proven REST path; the core.suiteQL() helper route is mis-wired.
  return core.netsuitePost('/query/v1/suiteql', { q })
}

async function itemInfo(itemId) {
  try {
    const r = await sql(
      `SELECT id, itemid, itemtype FROM item WHERE id = ${itemId}`
    )
    return rows(r)[0] || null
  } catch (e) {
    return { error: e.message.slice(0, 200) }
  }
}

async function history(itemId) {
  // Distinct transactions touching this item, earliest first.
  const q = `
    SELECT t.id, t.tranid, t.trandate, t.type, t.recordtype, t.posting
    FROM transaction t
    JOIN transactionline tl ON tl.transaction = t.id
    WHERE tl.item = ${itemId}
    GROUP BY t.id, t.tranid, t.trandate, t.type, t.recordtype, t.posting
    ORDER BY t.trandate ASC, t.id ASC`
  const r = await sql(q)
  return rows(r)
}

async function main() {
  console.log(`\n=== WO ${WO} BOM ===`)
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${WO}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const comps = (wo?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id), name: c.item?.refName }))
  for (const c of comps) console.log(`  line ${c.line}: item ${c.itemId} ${c.name || ''}`)

  const itemIds = new Set([ASSEMBLY_ITEM, ...comps.map(c => c.itemId)])
  for (const itemId of itemIds) {
    const info = await itemInfo(itemId)
    console.log(`\n=== item ${itemId} ${info ? JSON.stringify(info) : ''} — transaction history (earliest first) ===`)
    try {
      const h = await history(itemId)
      if (!h.length) { console.log('  (no transactions)'); continue }
      for (const row of h) {
        console.log(`  ${row.trandate}  type=${row.type}  recordtype=${row.recordtype}  posting=${row.posting}  id=${row.id}  tranid=${row.tranid}`)
      }
      const first = h[0]
      console.log(`  --> EARLIEST: type=${first.type} recordtype=${first.recordtype} date=${first.trandate} id=${first.id}`)
    } catch (e) {
      console.log(`  query failed: ${e.message}`)
    }
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
