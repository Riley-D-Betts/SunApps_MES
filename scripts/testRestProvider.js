/**
 * Quick smoke test for the RestProvider against the live Historian.
 * Run: node scripts/testRestProvider.js
 */
const RestProvider = require('../historian/providers/restProvider')

async function main() {
  const provider = new RestProvider()

  console.log('=== Testing RestProvider against live Historian ===\n')

  // 1. Test _getCurrentValue
  console.log('1. Reading Separator.CreamFatAct (current value)...')
  try {
    const val = await provider._getCurrentValue('Separator.CreamFatAct')
    console.log('   ', val)
  } catch (e) {
    console.error('   FAIL:', e.message)
  }

  // 2. Test _getCurrentValues (multiple tags)
  console.log('\n2. Reading multiple silo levels...')
  try {
    const vals = await provider._getCurrentValues([
      'MSILO1.GALLONS', 'MSILO2.GALLONS', 'MSILO3.GALLONS',
      'CSILO1.GALLONS', 'CSILO2.GALLONS',
    ])
    for (const [fqn, pv] of Object.entries(vals)) {
      console.log(`   ${fqn}: ${pv?.Value ?? 'null'} (quality: ${pv?.OpcQuality})`)
    }
  } catch (e) {
    console.error('   FAIL:', e.message)
  }

  // 3. Test separator state
  console.log('\n3. Reading ColdMilkSeparator1 state...')
  try {
    const vals = await provider._getCurrentValues([
      'ColdMilkSeparator1.CurrentWO',
      'ColdMilkSeparator1.JobRunning',
      'ColdMilkSeparator1.FromEntName',
      'ColdMilkSeparator1.ProdQty',
      'ColdMilkSeparator1.ConsQty',
    ])
    for (const [fqn, pv] of Object.entries(vals)) {
      console.log(`   ${fqn}: ${pv?.Text ?? pv?.Value ?? 'null'}`)
    }
  } catch (e) {
    console.error('   FAIL:', e.message)
  }

  // 4. Test flow totals
  console.log('\n4. Reading flow totals...')
  try {
    const vals = await provider._getCurrentValues([
      'Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized',
      'Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized',
    ])
    for (const [fqn, pv] of Object.entries(vals)) {
      console.log(`   ${fqn}: ${pv?.Value ?? 'null'}`)
    }
  } catch (e) {
    console.error('   FAIL:', e.message)
  }

  // 5. Test getSeparatorBatches
  console.log('\n5. getSeparatorBatches (last 1 hour)...')
  try {
    const since = new Date(Date.now() - 60 * 60 * 1000)
    const batches = await provider.getSeparatorBatches(since)
    console.log(`   Found ${batches.length} batch(es)`)
    batches.forEach(b => console.log('  ', JSON.stringify(b, null, 2)))
  } catch (e) {
    console.error('   FAIL:', e.message)
  }

  // 6. Test getBulkMilkFlowData (first call seeds baseline)
  console.log('\n6. getBulkMilkFlowData (first call = seed)...')
  try {
    const r1 = await provider.getBulkMilkFlowData(new Date())
    console.log(`   First call returned ${r1.length} reading(s) (expected 0 — seeding)`)

    // Second call with same totals should also return 0 (no change)
    const r2 = await provider.getBulkMilkFlowData(new Date())
    console.log(`   Second call returned ${r2.length} reading(s) (expected 0 — no change)`)
  } catch (e) {
    console.error('   FAIL:', e.message)
  }

  console.log('\n=== Done ===')
}

main().catch(console.error)
