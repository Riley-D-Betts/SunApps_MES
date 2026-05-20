// Probe candidate "active/running" tags across all four blend tanks so we can
// see what SCADA actually writes vs. what we currently read.
const restProviderModule = require('../historian/providers/restProvider')
// File exports the class; instantiate.
const RestProvider = restProviderModule
const provider = new RestProvider()

const tanks = ['BlendTank1A', 'BlendTank1B', 'BlendTank2A', 'BlendTank2B']
const suffixes = [
  '.CurrentWOState',
  '.CurrentWO',
  '.JobRunning',
  '.NOTE_STRING',
  '.FromEntName',
  '.ToEntName',
  '.CurrentItem',
  '.CurrentPctCmplt',
  '.CurrentProd',
  '.CurrentSeqNo',
]

async function main() {
  console.log('=== Blend tank state tags (current values) ===\n')
  for (const tank of tanks) {
    console.log(`--- ${tank} ---`)
    for (const suffix of suffixes) {
      const fqn = `${tank}${suffix}`
      try {
        const v = await provider._getCurrentValue(fqn, { verbose: false })
        const text = v?.Text ?? ''
        const num = v?.Value ?? ''
        const quality = v?.OpcQuality ?? '?'
        console.log(`  ${suffix.padEnd(20)} Text="${text}" Value=${num} OpcQuality=${quality}`)
      } catch (err) {
        console.log(`  ${suffix.padEnd(20)} ERROR: ${err.message}`)
      }
    }
    console.log('')
  }

  console.log('=== Line MEM vs live tags (ML1-4, CL1-2) ===\n')
  const lines = ['ML1', 'ML2', 'ML3', 'ML4', 'CL1', 'CL2']
  const lineSuffixes = [
    '.REQUESTEDBY',
    '.MEMREQUESTEDBY',
    '.STAT_ACTIVE',
    '.STAT_INHIBITED',
    '.STAT_TARGETCOMPLETE',
    '.STAT_FLUSHING',
    '.MODESTRING',
    '.BATCHTOTALIZER',
    '.MEMBATCHTOTALIZER',
    '.CURRENTSILONAME',
    '.MEMSILONAME',
    '.CURRENTSILOPRODUCTNAME',
    '.MEMSILOPRODUCTNAME',
  ]
  for (const line of lines) {
    console.log(`--- ${line} ---`)
    for (const suffix of lineSuffixes) {
      const fqn = `${line}${suffix}`
      try {
        const v = await provider._getCurrentValue(fqn, { verbose: false })
        const text = v?.Text ?? ''
        const num = v?.Value ?? ''
        const quality = v?.OpcQuality ?? '?'
        console.log(`  ${suffix.padEnd(28)} Text="${text}" Value=${num} OpcQuality=${quality}`)
      } catch (err) {
        console.log(`  ${suffix.padEnd(28)} ERROR: ${err.message}`)
      }
    }
    console.log('')
  }
}

main().catch(err => {
  console.error('Diag failed:', err)
  process.exit(1)
})
