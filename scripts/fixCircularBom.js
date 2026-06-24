/**
 * fixCircularBom.js
 *
 * Removes the "raw unseparated" whole-milk component from the BOMs of all
 * individual fat-% milk items (conventional and organic). This breaks the
 * circular reference that prevents setting up Raw Conventional / Raw Organic
 * as assemblies that can be unbuilt into their component milks and cream.
 *
 * Usage: node scripts/fixCircularBom.js
 *
 * Phase 1 — Discovery: fetches every item's BOM and logs all components.
 * Phase 2 — Cleanup:   removes any component identified as a circular
 *                       "raw unseparated" parent (detected by item ID match
 *                       against the WHOLE_MILK_IDS set, and by name pattern
 *                       as a fallback).
 *
 * Advanced BOM (bomRevision) is handled if Classic BOM members are absent.
 */

const core = require('../clients/coreClient')

// All fat-% items whose BOMs should NOT contain "raw conventional/organic" whole milk
const ITEMS_TO_FIX = [
  // Conventional
  { id: 5477, name: 'Raw Conventional 0%' },
  { id: 5415, name: 'Raw Conventional 1%' },
  { id: 5412, name: 'Raw Conventional 2%' },
  { id: 5413, name: 'Raw Conventional 3.25%' },
  { id: 5416, name: 'Raw Conventional 3.5%' },
  { id: 5480, name: 'Raw Conventional Cream' },
  { id: 5405, name: 'Raw Conventional UF Milk' },
  // Organic
  { id: 5482, name: 'Raw Organic 0%' },
  { id: 5409, name: 'Raw Organic 1%' },
  { id: 5410, name: 'Raw Organic 2%' },
  { id: 5411, name: 'Raw Organic 3.25%' },
  { id: 5481, name: 'Raw Organic 3.5%' },
  { id: 5483, name: 'Raw Organic Cream' },
  { id: 5402, name: 'Raw Organic UF Milk' },
  { id: 5403, name: 'Raw Organic A2 Milk' },
  { id: 5406, name: 'Raw Organic Grade A (A2/A2) Milk' },
]

// Item IDs for Raw Conventional Milk and Raw Organic Milk (whole / unseparated).
// These are the components that create the circular BOM.
// Add any additional IDs here if NS has separate "raw unseparated" items.
const WHOLE_MILK_IDS = new Set([
  '5417', // Raw Conventional Milk
  '5404', // Raw Organic Milk
])

function isCircularComponent(member) {
  const id = String(member?.item?.id || member?.item || '')
  if (WHOLE_MILK_IDS.has(id)) return true

  // Fallback: name-based detection for items not in WHOLE_MILK_IDS
  const name = (member?.item?.refName || '').toLowerCase().trim()
  if (!name) return false
  const hasConventional = name.includes('raw conventional') || name === 'raw conventional'
  const hasOrganic = name.includes('raw organic') || name === 'raw organic'
  if (!hasConventional && !hasOrganic) return false
  // Exclude items that are already specific (have fat %, cream, uf, a2, grade a)
  if (name.match(/\d+\.?\d*%/) || name.includes('cream') || name.includes('uf') || name.includes('a2') || name.includes('grade')) return false
  return true
}

// ── BOM fetching ────────────────────────────────────────────────────────────

async function fetchClassicBom(itemId) {
  const raw = await core.netsuiteGet(`/record/v1/assemblyItem/${itemId}?expandSubResources=true`)
  const item = raw?.body || raw
  const members = item?.members?.items || []
  return { item, members }
}

async function fetchAdvancedBomRevision(itemId) {
  // Find the active BOM for this assembly item via SuiteQL
  const q = `
    SELECT br.id, br.name
    FROM BOMRevision br
    INNER JOIN BOM b ON b.id = br.bom
    WHERE b.item = ${itemId}
    AND br.isDefault = 'T'
    ORDER BY br.id DESC
  `
  const result = await core.suiteQL(q)
  const rows = result?.body?.items || result?.items || []
  if (!rows.length) return null

  const revId = rows[0].id
  const raw = await core.netsuiteGet(`/record/v1/bomRevision/${revId}?expandSubResources=true`)
  const rev = raw?.body || raw
  const components = rev?.component?.items || []
  return { revId, rev, components }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const stats = { inspected: 0, fixed: 0, skipped: 0, errors: 0 }

  for (const target of ITEMS_TO_FIX) {
    stats.inspected++
    console.log(`\n── ${target.name} (id ${target.id}) ──`)

    let bomType = null
    let members = []
    let itemRecord = null
    let advRev = null

    try {
      const classic = await fetchClassicBom(target.id)
      itemRecord = classic.item
      members = classic.members

      if (members.length > 0) {
        bomType = 'classic'
      } else {
        // Try Advanced BOM
        advRev = await fetchAdvancedBomRevision(target.id)
        if (advRev?.components?.length > 0) {
          bomType = 'advanced'
          members = advRev.components
        } else {
          console.log('  No BOM members found (classic or advanced)')
          stats.skipped++
          continue
        }
      }
    } catch (err) {
      console.error(`  ERROR fetching BOM: ${err.message}`)
      stats.errors++
      continue
    }

    // Log all members
    console.log(`  BOM type: ${bomType} — ${members.length} component(s):`)
    for (const m of members) {
      const id = m?.item?.id || m?.item || '?'
      const name = m?.item?.refName || m?.description || '?'
      const qty = m?.quantity ?? '?'
      const flag = isCircularComponent(m) ? '  ← CIRCULAR (will remove)' : ''
      console.log(`    [${id}] "${name}"  qty=${qty}${flag}`)
    }

    const circular = members.filter(isCircularComponent)
    if (circular.length === 0) {
      console.log('  Nothing to remove.')
      stats.skipped++
      continue
    }

    const kept = members.filter(m => !isCircularComponent(m))
    console.log(`  Removing ${circular.length} circular component(s), keeping ${kept.length}`)

    try {
      if (bomType === 'classic') {
        // Rebuild the members sublist without the circular component.
        // Each member must have at minimum: item, quantity.
        const newItems = kept.map(m => {
          const entry = { item: { id: String(m.item?.id || m.item) }, quantity: m.quantity }
          if (m.units?.id) entry.units = { id: String(m.units.id) }
          return entry
        })
        await core.netsuitePatch(`/record/v1/assemblyItem/${target.id}`, {
          members: { replaceAll: true, items: newItems },
        })
        console.log(`  ✓ Classic BOM patched — members now: ${newItems.length}`)
      } else {
        // Advanced BOM: patch the bomRevision's component sublist
        const newItems = kept.map(m => {
          const entry = { item: { id: String(m.item?.id || m.item) }, quantity: m.quantity }
          if (m.units?.id) entry.units = { id: String(m.units.id) }
          return entry
        })
        await core.netsuitePatch(`/record/v1/bomRevision/${advRev.revId}`, {
          component: { replaceAll: true, items: newItems },
        })
        console.log(`  ✓ Advanced BOM revision ${advRev.revId} patched — components now: ${newItems.length}`)
      }
      stats.fixed++
    } catch (err) {
      console.error(`  ERROR patching BOM: ${err.message}`)
      if (err.data) console.error(`  NS response: ${JSON.stringify(err.data).slice(0, 400)}`)
      stats.errors++
    }
  }

  console.log('\n══════════════════════════════════════')
  console.log(`Done.  inspected=${stats.inspected}  fixed=${stats.fixed}  skipped=${stats.skipped}  errors=${stats.errors}`)
}

main().catch(err => { console.error(err); process.exitCode = 1 })
