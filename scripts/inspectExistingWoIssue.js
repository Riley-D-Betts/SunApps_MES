/**
 * Find any successful workOrderIssue record in NS and dump its structure.
 * Manufacturing creates these regularly (createBatchWorkOrderIssue,
 * createWorkOrderIssueSimple), so an example should exist in the sandbox.
 *
 * Goal: see what custbody fields are populated, what `item.items[]` looks
 * like (presence of `line`, `orderLine`, etc.), and whether
 * `custbody_woi_line` is required (i.e., not null on existing records).
 *
 * Usage: node scripts/inspectExistingWoIssue.js
 */
const core = require('../clients/coreClient')

async function main() {
  // 1. Find recent WorkOrderIssue records via SuiteQL
  console.log('=== Looking for recent workOrderIssue transactions ===')
  const sql = `
    SELECT TOP 5 id, tranid, trandate, createddate
    FROM transaction
    WHERE type = 'WorkOrdIssue'
    ORDER BY createddate DESC
  `
  const ql = await core.suiteQL(sql)
  const rows = ql?.body?.items || ql?.items || []
  console.log(`Found ${rows.length} record(s):`)
  for (const r of rows) console.log(`  id=${r.id} tranid=${r.tranid} date=${r.createddate}`)

  if (rows.length === 0) {
    console.log('No workOrderIssue records found via SuiteQL. Trying transactionType field instead...')
    const sql2 = `SELECT TOP 5 id, tranid, createddate FROM transaction WHERE type IN ('WorkOrdIss','WrkOrdIss','WorkOrderIssue') ORDER BY createddate DESC`
    const ql2 = await core.suiteQL(sql2)
    console.log(JSON.stringify(ql2?.body || ql2, null, 2).slice(0, 1500))
    return
  }

  // 2. Fetch the most recent one with full sub-resources
  const id = rows[0].id
  console.log(`\n=== Fetching workOrderIssue ${id} ===`)
  const wrap = await core.netsuiteGet(`/record/v1/workOrderIssue/${id}?expandSubResources=true`)
  const woi = wrap?.body || wrap

  console.log('Top-level fields:', Object.keys(woi).filter(k => !k.startsWith('_') && k !== 'links').join(', '))
  console.log('')
  console.log('Custbody fields:')
  for (const k of Object.keys(woi)) {
    if (k.startsWith('custbody_')) {
      const v = woi[k]
      console.log(`  ${k}:`, typeof v === 'object' ? JSON.stringify(v).slice(0, 100) : v)
    }
  }
  console.log('')
  console.log('Transaction reference:', JSON.stringify(woi.transaction))
  console.log('Item sublist (first item):')
  const firstItem = woi.item?.items?.[0]
  if (firstItem) {
    console.log(JSON.stringify(firstItem, null, 2))
  } else {
    console.log('  (no item.items found)')
  }

  require('fs').writeFileSync('./woi-example.json', JSON.stringify(wrap, null, 2))
  console.log(`\nFull JSON saved to ./woi-example.json`)
}

main().catch(err => { console.error(err); process.exitCode = 1 })
