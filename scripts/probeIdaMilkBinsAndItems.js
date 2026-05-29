#!/usr/bin/env node
/**
 * Probe the Ida Milk subsidiary's bins + items for rebuilding
 * services/mesItemConfig.js after the company change.
 *
 * Usage:
 *   CORE_API_URL=https://sundev01.mes.suntado.com node scripts/probeIdaMilkBinsAndItems.js
 *
 * Defaults to the dev URL if CORE_API_URL isn't set.
 */
const core = require('../clients/coreClient')

const NS_LOCATION_ID = 30

async function run(label, q) {
  console.log(`\n── ${label} ──`)
  console.log(`SQL: ${q.replace(/\s+/g, ' ').trim()}`)
  try {
    const res = await core.netsuitePost('/query/v1/suiteql', { q })
    const rows = res?.body?.items || res?.items || []
    if (rows.length === 0) {
      console.log('(no rows)')
      return
    }
    const cols = Object.keys(rows[0])
    console.log(cols.join('\t'))
    console.log(cols.map(() => '---').join('\t'))
    for (const r of rows) {
      console.log(cols.map(c => String(r[c] ?? '')).join('\t'))
    }
    console.log(`(${rows.length} row${rows.length === 1 ? '' : 's'})`)
  } catch (err) {
    console.error(`FAILED: ${err.message.slice(0, 400)}`)
  }
}

;(async () => {
  console.log(`CORE_API_URL = ${process.env.CORE_API_URL || '(default)'}`)
  console.log(`NS_LOCATION_ID filter = ${NS_LOCATION_ID}`)

  await run(
    'All bins (any name pattern that could be a silo / blend tank / surge tank)',
    `SELECT id, binnumber, location, BUILTIN.DF(location) AS location_name
     FROM bin
     WHERE LOWER(binnumber) LIKE '%silo%'
        OR LOWER(binnumber) LIKE '%blend%'
        OR LOWER(binnumber) LIKE '%surge%'
        OR LOWER(binnumber) LIKE '%bt%'
        OR LOWER(binnumber) LIKE '%st%'
        OR LOWER(binnumber) LIKE '%tank%'
     ORDER BY binnumber`
  )

  await run(
    `Bins with positive on-hand at location ${NS_LOCATION_ID}`,
    `SELECT DISTINCT bin.id, bin.binnumber
     FROM inventorybalance bal
     JOIN bin ON bin.id = bal.binnumber
     WHERE bal.location = ${NS_LOCATION_ID}
       AND COALESCE(bal.quantityavailable, bal.quantityonhand) > 0
     ORDER BY bin.binnumber`
  )

  await run(
    'Raw milk / cream / fat-level items (any active item whose display name looks like raw input or post-separator output)',
    `SELECT id, itemid, displayname, isinactive
     FROM item
     WHERE isinactive = 'F'
       AND (
         LOWER(displayname) LIKE 'raw %'
         OR LOWER(displayname) LIKE '%conventional %'
         OR LOWER(displayname) LIKE '%organic %'
         OR LOWER(displayname) LIKE '%a2 %'
         OR LOWER(displayname) LIKE '%cream%'
         OR LOWER(displayname) LIKE '%skim%'
         OR LOWER(displayname) LIKE '%uf milk%'
         OR LOWER(displayname) LIKE '%whole milk%'
         OR LOWER(displayname) LIKE '%fat free%'
         OR LOWER(displayname) LIKE '%low fat%'
         OR LOWER(displayname) LIKE '%reduced fat%'
       )
     ORDER BY displayname`
  )

  await run(
    `Per-(bin, item) on-hand snapshot at location ${NS_LOCATION_ID} — what's actually sitting in the candidate bins right now`,
    `SELECT bin.binnumber AS bin_name, bin.id AS bin_id,
            item.displayname AS item_name, item.id AS item_id,
            SUM(bal.quantityonhand)  AS on_hand,
            SUM(COALESCE(bal.quantityavailable, bal.quantityonhand)) AS available
     FROM inventorybalance bal
     JOIN bin ON bin.id = bal.binnumber
     JOIN item ON item.id = bal.item
     WHERE bal.location = ${NS_LOCATION_ID}
       AND COALESCE(bal.quantityavailable, bal.quantityonhand) > 0
     GROUP BY bin.binnumber, bin.id, item.displayname, item.id
     ORDER BY bin.binnumber, item.displayname`
  )
})().catch(err => {
  console.error('Probe failed:', err.message)
  process.exit(1)
})
