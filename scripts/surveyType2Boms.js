/**
 * Survey the type-2 standardized milks (the non-lot items RAW_FG_ITEM_MAP points
 * at) ahead of creating their lot-tracked batch twins. For each: tracking, cost,
 * and whether it has a master BOM + its component recipe (which the new lot
 * item's BOM will copy — "raw blend components" basis).
 */
const core = require('../clients/coreClient')
const ns = require('../services/nsInventoryLookup')

async function sql(q) {
  const r = await core.netsuitePost('/query/v1/suiteql', { q })
  return r?.items || r?.body?.items || []
}

// type-2 standardized entries from blendTankProductParser.RAW_FG_ITEM_MAP
const TYPE2 = [
  [8163, 'Raw conventional 0% (skim)'], [5415, 'Raw conventional 1%'], [5412, 'Raw conventional 2%'],
  [5413, 'Raw conventional 3.25%'], [5416, 'Raw conventional 3.5%'], [5480, 'Raw conventional cream (40%)'],
  [5482, 'Raw organic 0% (skim)'], [5409, 'Raw organic 1%'], [5410, 'Raw organic 2%'],
  [5411, 'Raw organic 3.25%'], [5401, 'Raw organic 3.5%'], [5483, 'Raw organic cream (40%)'],
  [5484, 'Raw organic A2 0% (skim)'], [8366, 'Raw organic A2 1%'], [8367, 'Raw organic A2 2%'],
  [8368, 'Raw organic A2 3.25%'], [8369, 'Raw organic A2 3.5%'], [8370, 'Raw organic A2 4%'],
  [8365, 'Raw organic A2 cream (40%)'],
]

async function masterBom(itemId) {
  try {
    const wrap = await core.netsuiteGet(`/record/v1/assemblyItem/${itemId}?expandSubResources=true`)
    const item = wrap?.body || wrap
    const bomRows = item?.billOfMaterials?.items || []
    if (!bomRows.length) return null
    const chosen = bomRows.find(r => r.masterDefault || r.bomDefault) || bomRows[0]
    const bomId = chosen?.billOfMaterials?.id
    let revId = chosen?.currentRevision?.id
    if (!revId && bomId) {
      const rev = (await sql(`SELECT id FROM bomrevision WHERE billofmaterials = ${bomId} ORDER BY id DESC`))[0]
      revId = rev?.id
    }
    if (!revId) return { bomId, revId: null, comps: [] }
    const comps = await sql(`SELECT item, quantity FROM bomrevisioncomponent WHERE bomrevision = ${revId}`)
    return { bomId, revId, comps }
  } catch (e) {
    return { error: e.message.slice(0, 100) }
  }
}

async function main() {
  let withBom = 0, without = 0
  for (const [id, label] of TYPE2) {
    const t = await ns.getItemTracking(id).catch(() => ({}))
    const bom = await masterBom(id)
    let bomStr
    if (!bom) { bomStr = 'NO MASTER BOM'; without++ }
    else if (bom.error) { bomStr = `err: ${bom.error}` }
    else {
      withBom++
      bomStr = `bom ${bom.bomId} rev ${bom.revId}: ` + (bom.comps.map(c => `${c.item}×${c.quantity}`).join(' + ') || '(no comps)')
    }
    console.log(`${String(id).padEnd(5)} ${label.padEnd(28)} lot=${t.isLot} cost=${t.cost}  ${bomStr}`)
  }
  console.log(`\n${withBom} have a master BOM, ${without} do not.`)
}
main().catch(e => { console.error('FAILED:', e.message); process.exit(1) })
