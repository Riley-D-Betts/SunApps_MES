#!/usr/bin/env node
/**
 * Probe NS to confirm the actual tracking flags (islotitem, usebins) on the
 * milk items mes_item_config references. Also dumps the subtype so we know
 * which REST path getItemTracking should be hitting.
 *
 * Usage:
 *   CORE_API_URL=https://sundev01.mes.suntado.com node scripts/probeItemTracking.js
 */
const core = require('../clients/coreClient')

const ITEMS = [
  // Source / raw
  { id: 5417, label: 'Raw Conventional Milk' },
  { id: 5404, label: 'Raw Organic Milk' },
  { id: 5403, label: 'Raw Organic A2 Milk' },
  { id: 5406, label: 'Raw Organic Grade A (A2/A2) Milk' },
  // Cream
  { id: 5480, label: 'Raw Conventional Cream' },
  { id: 5483, label: 'Raw Organic Cream' },
  // Post-separator skim / fat-level outputs
  { id: 8163, label: 'Conventional Fat Free / Skim' },
  { id: 5415, label: 'Conventional Low Fat 1%' },
  { id: 5412, label: 'Conventional Reduced Fat 2%' },
  { id: 5413, label: 'Conventional Whole 3.25%' },
  { id: 5416, label: 'Conventional Whole 3.5%' },
  { id: 5409, label: 'Organic Low Fat 1%' },
  { id: 5410, label: 'Organic Reduced Fat 2%' },
  { id: 5411, label: 'Organic Whole 3.25%' },
  { id: 5401, label: 'Organic Whole 3.5%' },
  { id: 5482, label: 'Organic Fat Free / Skim' },
  // Blend tank assembly examples
  { id: 8340, label: 'Raw DFI Marcels 1% Milk (assembly)' },
  { id: 8342, label: 'Raw Kirkland Organic Whole Milk (assembly)' },
]

const ID_LIST = ITEMS.map(i => i.id).join(',')

;(async () => {
  console.log(`CORE_API_URL = ${process.env.CORE_API_URL || '(default)'}`)
  console.log(`Probing tracking flags for ${ITEMS.length} items\n`)

  const q = `
    SELECT id, itemid, displayname, subtype, islotitem, usebins, isserialitem
    FROM item
    WHERE id IN (${ID_LIST})
    ORDER BY id
  `
  console.log(`SQL: ${q.replace(/\s+/g, ' ').trim()}\n`)

  try {
    const res = await core.netsuitePost('/query/v1/suiteql', { q })
    const rows = res?.body?.items || res?.items || []
    if (rows.length === 0) {
      console.log('(no rows — id list may be wrong for this NS account)')
      return
    }
    const cols = ['id', 'subtype', 'islotitem', 'usebins', 'isserialitem', 'displayname']
    console.log(cols.join('\t'))
    console.log(cols.map(() => '---').join('\t'))
    for (const r of rows) {
      console.log(cols.map(c => {
        const v = r[c]
        if (v === 'T' || v === true) return 'YES'
        if (v === 'F' || v === false) return 'no'
        return String(v ?? '')
      }).join('\t'))
    }
    console.log(`\n(${rows.length} row${rows.length === 1 ? '' : 's'})`)
  } catch (err) {
    console.error(`FAILED: ${err.message.slice(0, 400)}`)
  }
})().catch(err => {
  console.error('Probe failed:', err.message)
  process.exit(1)
})
