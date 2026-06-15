/**
 * For a given WO id, dump its BOM lines and each line's NS tracking class,
 * then show what anyLotTracked() decides. Confirms the blend "configure
 * inventory detail in line N" wrapper-mismatch root cause.
 */
const core = require('../clients/coreClient')
const nsInventory = require('../services/nsInventoryLookup')

const WO = process.argv[2]

async function main() {
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${WO}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const lines = (wo?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id), refName: c.item?.refName, qty: c.quantity }))
  console.log(`WO ${WO} status=${wo?.status?.refName || wo?.status} isWip=${wo?.isWip}`)
  console.log(`BOM lines:`)
  for (const l of lines) {
    const t = await nsInventory.getItemTracking(l.itemId)
    console.log(`  line ${l.line}: item ${l.itemId} (${l.refName}) qty=${l.qty}  tracking=${JSON.stringify(t)}`)
  }
  const any = await nsInventory.anyLotTracked(lines)
  console.log(`\nanyLotTracked => ${any}`)
}
main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
