const core = require('../clients/coreClient')
async function q(sql){ const r = await core.netsuitePost('/query/v1/suiteql', { q: sql }); return r?.body?.items || r?.items || [] }
async function main() {
  // recent assemblyUnbuild transactions
  const ub = await q(`SELECT id, tranid, trandate, memo FROM transaction WHERE type = 'AsmUnbuild' ORDER BY id DESC FETCH FIRST 6 ROWS ONLY`)
  console.log('Recent AsmUnbuild transactions:')
  for (const r of ub) console.log(`  id=${r.id} tranid=${r.tranid} date=${r.trandate} memo=${r.memo||''}`)
  // current bin 4931 balance of 5404
  const bal = await q(`SELECT quantityonhand, quantityavailable FROM inventorybalance WHERE item=5404 AND location=30 AND binnumber=4931`)
  console.log(`\nbin 4931 5404 now: ${JSON.stringify(bal)}`)
}
main().then(()=>process.exit(0)).catch(e=>{console.error('FAILED:',e.message);process.exit(1)})
