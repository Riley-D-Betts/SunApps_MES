/**
 * Verify assembly unbuilds posted to the RIGHT BINS and RIGHT ITEMS.
 *
 * For each completed separation unbuild in the window we have two sides:
 *   INTENDED  — reconstructed from MesSeparationBatch.destinations JSON, which
 *               stores the resolved source/cream/skim item ids + bin ids the
 *               unbuild was built from (see milkMesService.processSeparationBatch).
 *   ACTUAL    — pulled from the NS sandbox by nsTransactionId: the assembly line
 *               (item + bin consumed) and each component line (item + bin produced),
 *               with the bin each line's inventory detail actually landed in.
 *
 * We diff item id and bin id per leg and flag any mismatch. NS access is via the
 * Core API proxy (clients/coreClient → CORE_API_URL); if it's down the NS side is
 * skipped and we still print the intended side + config sanity checks.
 *
 * Usage:  node scripts/verifyUnbuildBinsItems.js [days] [limit]
 */
const { Op } = require('sequelize')
const { sequelize } = require('../config')
const db = require('../models')
const core = require('../clients/coreClient')
const itemConfig = require('../services/mesItemConfig')

const DAYS = Number(process.argv[2]) || 14
const LIMIT = Number(process.argv[3]) || 25
const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000)

// Reverse bin map: NS bin id → silo/tank name, so an actual bin id reads in plain English.
const BIN_TO_NAME = {}
for (const [name, id] of Object.entries({ ...itemConfig.SILO_BIN_MAP, ...itemConfig.TANK_BIN_MAP, ...itemConfig.SURGE_TANK_BIN_MAP })) {
  BIN_TO_NAME[id] = name
}
const binName = id => BIN_TO_NAME[Number(id)] || (id == null ? '-' : `bin#${id}`)

// The locally-activated gateway throws transient 401s while its NS token
// refreshes, recovering within a second or two. Retry on 401 with backoff.
async function nsQuery(q, attempts = 4) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await core.netsuitePost('/query/v1/suiteql', { q })
      return res?.body?.items || res?.items || []
    } catch (err) {
      lastErr = err
      if (!/HTTP 401|\(401\)/.test(err.message)) throw err
      await new Promise(r => setTimeout(r, 1500 * (i + 1)))
    }
  }
  throw lastErr
}

async function nsReachable() {
  try {
    // NS SuiteQL has no `dual`; query a real table with a row cap instead.
    // Use the proven REST path (/query/v1/suiteql) — the /suiteql helper route
    // is not what the gateway accepts (matches nsInventoryLookup usage).
    await nsQuery('SELECT id FROM transaction FETCH FIRST 1 ROWS ONLY')
    return true
  } catch (err) {
    console.warn(`\n[!] NS Core API not reachable (${err.message.slice(0, 120)}).`)
    console.warn('    NS-actual side will be skipped. Start the Core API (localhost:4000) and re-run for the full diff.\n')
    return false
  }
}

/**
 * Pull the actual posted lines for an assemblyUnbuild from NS sandbox: every
 * transaction line's item + quantity, and the bin each line's inventory detail
 * landed in. Negative line quantity = assembly consumed; positive = component produced.
 */
async function fetchNsUnbuild(txnId) {
  const q = `
    SELECT
      tl.id              AS line_id,
      tl.item            AS item_id,
      i.itemid           AS item_name,
      tl.quantity        AS qty,
      ia.bin             AS bin_id,
      b.binnumber        AS bin_name,
      ia.quantity        AS assign_qty
    FROM transactionline tl
    LEFT JOIN item i               ON i.id = tl.item
    LEFT JOIN inventoryassignment ia ON ia.transaction = tl.transaction AND ia.transactionline = tl.id
    LEFT JOIN bin b                ON b.id = ia.bin
    WHERE tl.transaction = ${Number(txnId)}
      AND tl.item IS NOT NULL
    ORDER BY tl.quantity ASC, tl.id
  `
  return nsQuery(q)
}

function parseIntended(row) {
  let d = {}
  try { d = JSON.parse(row.destinations || '{}') } catch { /* leave empty */ }
  const resolved = d.resolved || []
  const cream = resolved.find(r => r.kind === 'cream')
  const skim = resolved.find(r => r.kind === 'skim' && r.silo && r.silo !== row.sourceSilo)
  return {
    source: { itemId: d.source?.nsItemId ?? null, binId: d.source?.binId ?? null, silo: d.source?.silo || row.sourceSilo },
    cream: cream ? { itemId: cream.item?.id ?? null, binId: cream.binId ?? null, silo: cream.silo } : null,
    skim: skim ? { itemId: skim.item?.id ?? null, binId: skim.binId ?? null, silo: skim.silo } : null,
  }
}

function mark(ok) { return ok ? 'OK ' : 'XX ' }

async function main() {
  await sequelize.authenticate()
  console.log(`Verifying assembly unbuild bins/items since ${since.toISOString()} (${DAYS}d, up to ${LIMIT})`)

  const rows = await db.MesSeparationBatch.findAll({
    where: {
      status: 'completed',
      nsTransactionId: { [Op.ne]: null },
      createdAt: { [Op.gte]: since },
    },
    order: [['createdAt', 'DESC']],
    limit: LIMIT,
    raw: true,
  })
  console.log(`Found ${rows.length} completed unbuilds with an NS transaction id.\n`)
  if (!rows.length) {
    const any = await db.MesSeparationBatch.count({ where: { createdAt: { [Op.gte]: since } } })
    console.log(`(${any} separation batches in window total — none reached status=completed with a txn id.)`)
    await sequelize.close()
    return
  }

  const liveNs = await nsReachable()
  const problems = []

  for (const row of rows) {
    const intended = parseIntended(row)
    console.log('='.repeat(80))
    console.log(`Batch ${row.batchId}  src=${row.sourceSilo}  NS txn=${row.nsTransactionId}  (${row.createdAt.toISOString().slice(0, 16)})`)
    console.log(`  INTENDED  assembly: item ${intended.source.itemId} @ ${binName(intended.source.binId)} (${intended.source.binId})`)
    console.log(`            cream   : ${intended.cream ? `item ${intended.cream.itemId} @ ${binName(intended.cream.binId)} (${intended.cream.binId})` : '— none'}`)
    console.log(`            skim    : ${intended.skim ? `item ${intended.skim.itemId} @ ${binName(intended.skim.binId)} (${intended.skim.binId})` : '— none'}`)

    // ---- config sanity checks on the intended side (independent of NS) ----
    const expectCreamItem = intended.source.itemId ? itemConfig.getCreamItemForSource(intended.source.itemId).id : null
    if (intended.cream && expectCreamItem && Number(intended.cream.itemId) !== Number(expectCreamItem)) {
      problems.push(`Batch ${row.batchId}: cream item ${intended.cream.itemId} != expected ${expectCreamItem} for source ${intended.source.itemId}`)
    }
    if (intended.source.binId && BIN_TO_NAME[intended.source.binId] == null) {
      problems.push(`Batch ${row.batchId}: source bin ${intended.source.binId} is not a known silo/tank bin`)
    }
    if (intended.cream && intended.cream.binId && !String(binName(intended.cream.binId)).startsWith('CSilo')) {
      problems.push(`Batch ${row.batchId}: cream landing in ${binName(intended.cream.binId)} (expected a CSilo bin)`)
    }
    if (intended.skim && intended.skim.binId && !String(binName(intended.skim.binId)).startsWith('MSilo')) {
      problems.push(`Batch ${row.batchId}: skim landing in ${binName(intended.skim.binId)} (expected an MSilo bin)`)
    }

    if (!liveNs) { console.log('  ACTUAL    (NS skipped — Core API down)'); continue }

    // ---- actual side from NS ----
    let lines
    try {
      lines = await fetchNsUnbuild(row.nsTransactionId)
    } catch (err) {
      console.log(`  ACTUAL    NS query failed: ${err.message.slice(0, 160)}`)
      problems.push(`Batch ${row.batchId}: NS query failed for txn ${row.nsTransactionId}`)
      continue
    }
    if (!lines.length) {
      console.log(`  ACTUAL    NS returned no lines for txn ${row.nsTransactionId} (deleted? wrong id?)`)
      problems.push(`Batch ${row.batchId}: NS txn ${row.nsTransactionId} has no lines`)
      continue
    }

    // Assembly line = negative qty (consumed); components = positive (produced).
    const assemblyLines = lines.filter(l => Number(l.qty) < 0)
    const componentLines = lines.filter(l => Number(l.qty) > 0)
    console.log('  ACTUAL    posted lines:')
    for (const l of lines) {
      const leg = Number(l.qty) < 0 ? 'assembly' : 'component'
      console.log(`     [${leg}] item ${l.item_id} (${l.item_name || '?'}) qty ${Number(l.qty).toFixed(1)}  bin ${binName(l.bin_id)} (${l.bin_id ?? 'NO BIN'})`)
    }

    // ---- diff intended vs actual ----
    const asm = assemblyLines[0]
    if (asm) {
      const itemOk = Number(asm.item_id) === Number(intended.source.itemId)
      const binOk = intended.source.binId == null || Number(asm.bin_id) === Number(intended.source.binId)
      console.log(`     diff assembly: ${mark(itemOk)}item  ${mark(binOk)}bin`)
      if (!itemOk) problems.push(`Batch ${row.batchId}: ASSEMBLY item posted ${asm.item_id}, intended ${intended.source.itemId}`)
      if (!binOk) problems.push(`Batch ${row.batchId}: ASSEMBLY bin posted ${binName(asm.bin_id)} (${asm.bin_id}), intended ${binName(intended.source.binId)} (${intended.source.binId})`)
    }
    for (const leg of ['cream', 'skim']) {
      const intent = intended[leg]
      if (!intent) continue
      const match = componentLines.find(l => Number(l.item_id) === Number(intent.itemId))
      if (!match) {
        console.log(`     diff ${leg}: XX no component line with item ${intent.itemId}`)
        problems.push(`Batch ${row.batchId}: ${leg.toUpperCase()} item ${intent.itemId} not found among posted component lines`)
        continue
      }
      const binOk = intent.binId == null || Number(match.bin_id) === Number(intent.binId)
      console.log(`     diff ${leg}: OK item  ${mark(binOk)}bin`)
      if (!binOk) problems.push(`Batch ${row.batchId}: ${leg.toUpperCase()} bin posted ${binName(match.bin_id)} (${match.bin_id}), intended ${binName(intent.binId)} (${intent.binId})`)
    }
  }

  console.log('\n' + '='.repeat(80))
  console.log(`SUMMARY: ${problems.length} problem(s) across ${rows.length} unbuild(s)`)
  console.log('='.repeat(80))
  for (const p of problems) console.log(`  - ${p}`)
  if (!problems.length) console.log('  All checked unbuilds posted the right items to the right bins.')

  await sequelize.close()
}

main().catch(err => {
  console.error('FAILED:', err)
  process.exit(1)
})
