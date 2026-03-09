/**
 * Test batch detection using XFR TransferComplete triggers.
 * Run: node scripts/testBatchDetection.js
 */
const RestProvider = require('../historian/providers/restProvider')

async function main() {
  const provider = new RestProvider()

  // Look back 36 hours to catch known batches
  const since = new Date(Date.now() - 36 * 60 * 60 * 1000)
  console.log(`Looking for batches since ${since.toISOString()}...\n`)

  const batches = await provider.getSeparatorBatches(since)
  console.log(`Found ${batches.length} batch(es)\n`)

  for (const batch of batches) {
    console.log('─'.repeat(60))
    console.log(`  Batch ID:      ${batch.batchId}`)
    console.log(`  Work Order:    ${batch.workOrder}`)
    console.log(`  Source Silo:   ${batch.sourceSilo}`)
    console.log(`  Destination:   ${batch.destinationEntity}`)
    console.log(`  Input Volume:  ${batch.inputVolume}`)
    console.log(`  Cream Volume:  ${batch.creamVolume}`)
    console.log(`  Skim Volume:   ${batch.skimVolume}`)
    const waste = batch.inputVolume - batch.creamVolume - batch.skimVolume
    const wastePct = batch.inputVolume > 0 ? (waste / batch.inputVolume * 100).toFixed(2) : 'N/A'
    console.log(`  Waste:         ${waste.toFixed(2)} (${wastePct}%)`)
    console.log(`  Batch End:     ${batch.batchEnd.toISOString()}`)
    console.log(`  XFR Item ID:   ${batch.xfrItemId}`)
    console.log(`  XFR Unit:      ${batch.xfrUnit}`)
    console.log(`  Prod Item:     ${batch.prodItem}`)
    console.log(`  Prod Qty:      ${batch.prodQty}`)
    console.log(`  Prod Lot:      ${batch.prodLot}`)
    console.log(`  Cons Item:     ${batch.consItem}`)
    console.log(`  Cons Qty:      ${batch.consQty}`)
    console.log(`  Cons Lot:      ${batch.consLot}`)
  }

  console.log('\n=== Bulk Milk Flow Test ===')
  const r1 = await provider.getBulkMilkFlowData(new Date())
  console.log(`First call (seed): ${r1.length} reading(s)`)
  const r2 = await provider.getBulkMilkFlowData(new Date())
  console.log(`Second call:       ${r2.length} reading(s)`)
}

main().catch(console.error)
