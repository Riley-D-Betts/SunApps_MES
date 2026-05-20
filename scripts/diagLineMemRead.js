// Sanity-check: the live getMilkLineStatus call now returns memRequestedBy etc.
const RestProvider = require('../historian/providers/restProvider')
const provider = new RestProvider()

async function main() {
  const lines = await provider.getMilkLineStatus()
  for (const l of lines) {
    console.log(`${l.line}: requestedBy="${l.requestedBy}" memRequestedBy="${l.memRequestedBy}" siloName="${l.siloName}" memSiloName="${l.memSiloName}" productName="${l.productName}" memProductName="${l.memProductName}" tot=${l.totalizerLbs} memTot=${l.memTotalizerLbs} active=${l.active}`)
  }
}

main().catch(err => { console.error(err); process.exit(1) })
