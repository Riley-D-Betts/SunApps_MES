const core = require('../clients/coreClient')
async function q(sql){ const r = await core.netsuitePost('/query/v1/suiteql', { q: sql }); return r?.body?.items || r?.items || [] }
async function main(){
  const ids=[5405,5402,5403,5484,8365,8366,8367,8368,5406]
  const rows=await q(`SELECT id, itemid FROM item WHERE id IN (${ids.join(',')})`)
  const byId=Object.fromEntries(rows.map(r=>[String(r.id),r.itemid]))
  for(const id of ids) console.log(`${id}: "${byId[String(id)]||'NOT FOUND'}"`)
}
main().then(()=>process.exit(0)).catch(e=>{console.error('FAILED:',e.message);process.exit(1)})
