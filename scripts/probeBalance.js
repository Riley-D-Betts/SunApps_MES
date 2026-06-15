const core = require('../clients/coreClient')
async function q(sql){ const r = await core.netsuitePost('/query/v1/suiteql', { q: sql }); return r?.body?.items || r?.items || [] }
async function main() {
  const rows = await q(`
    SELECT bal.binnumber, bin.binnumber AS bin_name, inv.inventorynumber AS lot,
           bal.quantityonhand, bal.quantityavailable
    FROM inventorybalance bal
    LEFT JOIN bin bin ON bin.id = bal.binnumber
    LEFT JOIN inventorynumber inv ON inv.id = bal.inventorynumber
    WHERE bal.item = 5404 AND bal.location = 30 AND bal.binnumber = 4931
  `)
  console.log(`5404 @ bin 4931, loc 30: ${rows.length} balance row(s)`)
  for (const r of rows) console.log(JSON.stringify(r))
  console.log('\n--- all bins for 5404 @ loc 30 ---')
  const all = await q(`
    SELECT bal.binnumber, bin.binnumber AS bin_name, bal.quantityonhand, bal.quantityavailable
    FROM inventorybalance bal LEFT JOIN bin bin ON bin.id = bal.binnumber
    WHERE bal.item = 5404 AND bal.location = 30
  `)
  for (const r of all) console.log(JSON.stringify(r))
}
main().then(()=>process.exit(0)).catch(e=>{console.error('FAILED:',e.message);process.exit(1)})
