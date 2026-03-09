/**
 * Test batch detection with a wider time window to catch real historical batches.
 */
const RestProvider = require('../historian/providers/restProvider')

async function main() {
  const provider = new RestProvider()

  // Look back 24 hours to catch the batches we know exist
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  console.log(`Looking for batches since ${since.toISOString()}...\n`)

  const batches = await provider.getSeparatorBatches(since)
  console.log(`Found ${batches.length} batch(es)\n`)

  for (const batch of batches) {
    console.log('─'.repeat(60))
    console.log(`  Batch ID:     ${batch.batchId}`)
    console.log(`  Work Order:   ${batch.workOrder}`)
    console.log(`  Source Silo:  ${batch.sourceSilo}`)
    console.log(`  Destination:  ${batch.destinationEntity}`)
    console.log(`  Input Vol:    ${batch.inputVolume}`)
    console.log(`  Cream Total:  ${batch.creamVolume}`)
    console.log(`  Skim Total:   ${batch.skimVolume}`)
    console.log(`  Batch End:    ${batch.batchEnd.toISOString()}`)
    console.log(`  Prod Item:    ${batch.prodItem}`)
    console.log(`  Prod Qty:     ${batch.prodQty}`)
    console.log(`  Cons Item:    ${batch.consItem}`)
    console.log(`  Cons Qty:     ${batch.consQty}`)
  }
}

main().catch(console.error)
