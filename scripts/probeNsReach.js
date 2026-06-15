// READ-ONLY NS probes to confirm Bug G premises. No POSTs that mutate inventory.
const nsInventory = require('../services/nsInventoryLookup')
const invAdj = require('../services/inventoryAdjustmentService')

async function main() {
  for (const id of [5404, 5483, 5410, 5417]) {
    const t = await nsInventory.getItemTracking(id)
    console.log(`item ${id}: tracking=${JSON.stringify(t)}`)
  }
  console.log('')
  // Source bin on-hand of 5404 (organic) in 4931 (MSilo1)
  const oh = await invAdj.getBinQtyOnHand(5404, 4931)
  console.log(`bin 4931 on-hand of item 5404 = ${oh}`)
  const allocs = await nsInventory.findInventoryAllocations(5404, 500080.03, 4931)
  console.log(`findInventoryAllocations(5404, 500080.03, bin 4931): ${allocs.length} row(s)`)
  for (const a of allocs) console.log(`   lot ${a.lotName}(id=${a.lotId}) @bin ${a.binName}(id=${a.binId}) qty=${a.qty}`)
}
main().then(()=>process.exit(0)).catch(e=>{ console.error('PROBE FAILED:', e.message); process.exit(1) })
