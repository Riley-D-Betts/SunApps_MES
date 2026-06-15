const core = require('../clients/coreClient')
async function q(sql){ const r = await core.netsuitePost('/query/v1/suiteql', { q: sql }); return r?.body?.items || r?.items || [] }
async function main(){
  const ids = [5404,5410,5483,5417,5480,5482,8163,5409,5411,5401,5412,5413,5415,5416]
  const rows = await q(`SELECT id, itemid, displayname FROM item WHERE id IN (${ids.join(',')})`)
  const byId = Object.fromEntries(rows.map(r=>[String(r.id), r]))
  for (const id of ids){ const r=byId[String(id)]; console.log(`${id}: itemid="${r?.itemid||'?'}"  displayname="${r?.displayname||''}"`) }
}
main().then(()=>process.exit(0)).catch(e=>{console.error('FAILED:',e.message);process.exit(1)})
