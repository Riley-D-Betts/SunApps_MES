// Audit (and optionally set) the WIP Account on every assembly item the MES
// builds via WIP work orders. NS rejects workOrderIssue with "Assembly item is
// missing WIP Account" when this is unset.
//
//   node scripts/auditWipAccount.js            # read-only audit
//   COMMIT=1 node scripts/auditWipAccount.js   # patch items missing wipAcct → WIP_ACCT
const core = require('../clients/coreClient')
const { RAW_FG_TO_FG_MAP } = require('../services/mesItemConfig')

const WIP_ACCT = 805 // Work in Progress (account number 12021, internal id 805)
const COMMIT = process.env.COMMIT === '1'

// Every assembly item that gets a WIP work order:
//  - blend-tank builds the raw FGs  (keys)
//  - surge-tank builds the FGs       (values)
//  - separation assemblies (built via unbuild, but assembly items nonetheless)
const SEPARATION_ASSEMBLIES = [5417, 5404, 5403, 5406]
const ids = Array.from(new Set([
  ...Object.keys(RAW_FG_TO_FG_MAP).map(Number),
  ...Object.values(RAW_FG_TO_FG_MAP).map(Number),
  ...SEPARATION_ASSEMBLIES,
])).sort((a, b) => a - b)

async function main() {
  console.log(`Checking ${ids.length} candidate assembly items. WIP acct target = ${WIP_ACCT}. COMMIT=${COMMIT}\n`)
  const missing = [], ok = [], notAssembly = [], errors = []

  for (const id of ids) {
    try {
      const r = await core.netsuiteGet(`/record/v1/assemblyItem/${id}?fields=itemId,subtype,wipAcct`)
      const b = r?.body || r
      const wip = b?.wipAcct?.id ?? b?.wipAcct?.refName ?? null
      const name = b?.itemId || `item ${id}`
      if (wip) { ok.push({ id, name, wip }); console.log(`  OK    ${id} "${name}" wipAcct=${b.wipAcct.id} (${b.wipAcct.refName || ''})`) }
      else { missing.push({ id, name }); console.log(`  MISS  ${id} "${name}" — no wipAcct`) }
    } catch (e) {
      const msg = e.message || String(e)
      if (/404|not found|NONEXISTENT|INVALID_KEY/i.test(msg)) { notAssembly.push(id); console.log(`  skip  ${id} — not an assemblyItem (${msg.slice(0,60)})`) }
      else { errors.push({ id, msg }); console.log(`  ERR   ${id} — ${msg.slice(0,100)}`) }
    }
  }

  console.log(`\nSummary: ${ok.length} already set, ${missing.length} missing, ${notAssembly.length} non-assembly/skip, ${errors.length} errors`)
  if (missing.length) console.log('Missing wipAcct:', missing.map(m => `${m.id}(${m.name})`).join(', '))

  if (COMMIT && missing.length) {
    console.log(`\n--- PATCHING ${missing.length} items → wipAcct ${WIP_ACCT} ---`)
    for (const m of missing) {
      try {
        await core.netsuitePatch(`/record/v1/assemblyItem/${m.id}`, { wipAcct: { id: WIP_ACCT } })
        const v = (await core.netsuiteGet(`/record/v1/assemblyItem/${m.id}?fields=wipAcct`))?.body?.wipAcct?.id
        console.log(`  set ${m.id} "${m.name}" → wipAcct=${v} ${String(v) === String(WIP_ACCT) ? 'OK' : 'VERIFY FAILED'}`)
      } catch (e) {
        console.log(`  FAIL ${m.id} "${m.name}" — ${(e.message || e).slice(0,120)}`)
      }
    }
  } else if (missing.length) {
    console.log('\n(read-only — re-run with COMMIT=1 to patch)')
  }
}
main().catch(e => { console.error(e); process.exit(1) })
