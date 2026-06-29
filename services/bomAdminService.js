/**
 * BOM Admin Service — read and edit assembly-item Bills of Material from the UI.
 *
 * Backs the SunApps "BOM Admin" page (/admin/bom). Two jobs:
 *   1. Expose the dairy product hierarchy as selectable groups (surge-tank FGs,
 *      batch-tank goods, raw cream/skim/milk) from the authoritative MES maps —
 *      these categories are NOT a NetSuite field, they live in mesItemConfig.js.
 *   2. Read an item's current/default BOM revision, and overwrite that revision's
 *      component sublist on save (the user-chosen write mode).
 *
 * Write mechanics mirror the proven script scripts/attachBatchBom.js:
 *   - overwrite: PATCH /record/v1/bomRevision/{revId} { component: { items } }
 *   - no BOM yet: POST /record/v1/bom → POST /record/v1/bomRevision →
 *                 PATCH /record/v1/assemblyItem/{id} to link.
 *
 * SAFETY: honors config.MES_DRY_RUN (logs the intended write, posts nothing).
 * BOM changes affect only NEW work orders, never released/existing ones.
 */
const core = require('../clients/coreClient')
const config = require('../config')
const { RAW_FG_TO_FG_MAP, FG_TO_RAW_FG_MAP, RAW_ITEMS } = require('./mesItemConfig')

// Proven SuiteQL path; core.suiteQL()'s route is mis-wired (see costRevaluationService).
function sql(q) {
  return core.netsuitePost('/query/v1/suiteql', { q })
}
function rows(res) {
  return res?.items || res?.body?.items || []
}

// NS responses sometimes return the new id only via the Location header.
function extractId(res) {
  const direct = res?.id || res?.body?.id
  if (direct) return String(direct)
  const loc = res?.headers?.location
  if (loc) {
    const m = String(loc).match(/\/(\d+)$/)
    if (m) return m[1]
  }
  return null
}

// Resolve display names for a set of item ids in one query. Returns { [id]: name }.
async function resolveNames(ids) {
  const unique = [...new Set(ids.map(Number).filter(Boolean))]
  if (!unique.length) return {}
  const map = {}
  const r = rows(await sql(`SELECT id, itemid, displayname FROM item WHERE id IN (${unique.join(',')})`))
  for (const row of r) {
    // itemid (Name) holds the descriptive product name in this account;
    // displayname is a numeric internal code, so prefer itemid.
    map[String(row.id)] = row.itemid || row.displayname || `item ${row.id}`
  }
  return map
}

/**
 * Selectable item groups for the editor, sourced from the MES maps.
 * RAW_FG_TO_FG_MAP keys = batch-tank goods (raw blend outputs), values = surge-tank
 * FGs (pasteurized). FG_TO_RAW_FG_MAP is the 1:1 twin link (fgId → batchGoodId).
 */
async function getGroups() {
  const surgeFGIds = Object.values(RAW_FG_TO_FG_MAP)
  const batchGoodIds = Object.keys(RAW_FG_TO_FG_MAP).map(Number)
  const rawItemList = Object.values(RAW_ITEMS)

  const names = await resolveNames([...surgeFGIds, ...batchGoodIds, ...rawItemList.map((i) => i.id)])
  const byName = (a, b) => a.name.localeCompare(b.name)
  const toEntry = (id) => ({ id: Number(id), name: names[String(id)] || `item ${id}` })

  return {
    surgeFGs: surgeFGIds.map(toEntry).sort(byName),
    batchGoods: batchGoodIds.map(toEntry).sort(byName),
    // RAW_ITEMS carries its own labels; prefer the live NS name when available.
    rawItems: rawItemList
      .map((i) => ({ id: i.id, name: names[String(i.id)] || i.name }))
      .sort(byName),
    twinMap: FG_TO_RAW_FG_MAP, // surge fgId → batch-good (raw FG) id
  }
}

// Validate that an item exists and is an assembly, then return the REST record
// type to use. NS accepts the generic `assemblyItem` endpoint for lot-numbered
// assemblies too (verified), so we always use it — the lookup is purely to give a
// clean error for missing items (e.g. a prod-only id absent in this account) or
// non-assembly items (purchased InvtParts have no editable BOM) instead of a raw
// NS 400 "There are no records of this type."
async function resolveAssemblyEndpoint(itemId) {
  const meta = rows(await sql(`SELECT itemtype FROM item WHERE id = ${Number(itemId)}`))[0]
  if (!meta) throw new Error(`item ${itemId} not found in NetSuite (it may not exist in this account)`)
  if (String(meta.itemtype) !== 'Assembly') {
    throw new Error(`item ${itemId} is a ${meta.itemtype} item, not an assembly — it has no editable BOM`)
  }
  return 'assemblyItem'
}

// Resolve an assembly item's default BOM + current revision id.
// Mirrors costRevaluationService.resolveMasterBomRevision.
async function resolveBomRevision(itemId, recordType) {
  const recType = recordType || (await resolveAssemblyEndpoint(itemId))
  const wrap = await core.netsuiteGet(`/record/v1/${recType}/${itemId}?expandSubResources=true`)
  const item = wrap?.body || wrap
  const bomRows = item?.billOfMaterials?.items || []
  if (!bomRows.length) return { bomId: null, revisionId: null }
  const chosen = bomRows.find((r) => r.masterDefault || r.bomDefault) || bomRows[0]
  const bomId = chosen?.billOfMaterials?.id ? String(chosen.billOfMaterials.id) : null
  let revisionId = chosen?.currentRevision?.id ? String(chosen.currentRevision.id) : null
  if (!revisionId && bomId) {
    const latest = rows(await sql(`SELECT id FROM bomrevision WHERE billofmaterials = ${bomId} ORDER BY id DESC`))[0]
    revisionId = latest?.id ? String(latest.id) : null
  }
  return { bomId, revisionId }
}

/**
 * Read an item's current BOM. Returns the resolved bom/revision ids plus the
 * component lines (item id/name, quantity, bomQuantity, componentYield).
 */
async function getItemBom(itemId) {
  const id = Number(itemId)
  if (!Number.isFinite(id)) throw new Error(`invalid item id: ${itemId}`)

  const recordType = await resolveAssemblyEndpoint(id)
  const { bomId, revisionId } = await resolveBomRevision(id, recordType)
  let components = []
  if (revisionId) {
    const comps = rows(await sql(
      `SELECT item, quantity, bomquantity, componentyield FROM bomrevisioncomponent WHERE bomrevision = ${revisionId} ORDER BY item`,
    ))
    const names = await resolveNames([id, ...comps.map((c) => c.item)])
    components = comps.map((c, i) => ({
      lineId: i + 1,
      itemId: Number(c.item),
      itemName: names[String(c.item)] || `item ${c.item}`,
      quantity: Number(c.quantity),
      bomQuantity: c.bomquantity != null ? Number(c.bomquantity) : Number(c.quantity),
      componentYield: c.componentyield != null ? Number(c.componentyield) : 100,
    }))
  }
  const itemName = (await resolveNames([id]))[String(id)] || `item ${id}`
  return { itemId: id, itemName, bomId, revisionId, hasBom: !!revisionId, components }
}

// Free-text search for any assembly item (fallback path when not picking a group).
async function searchItems(term) {
  const q = String(term || '').trim()
  if (q.length < 2) return []
  const safe = q.replace(/'/g, "''")
  const r = rows(await sql(
    `SELECT id, itemid, displayname FROM item
     WHERE itemtype = 'Assembly' AND isinactive = 'F'
       AND (UPPER(itemid) LIKE UPPER('%${safe}%') OR UPPER(displayname) LIKE UPPER('%${safe}%'))
     ORDER BY itemid`,
  ))
  return r.slice(0, 50).map((row) => ({
    id: Number(row.id),
    itemId: row.itemid,
    name: row.itemid || row.displayname || `item ${row.id}`,
  }))
}

// Validate + shape UI components into the NS bomRevision.component sublist.
function buildComponentItems(itemId, components) {
  if (!Array.isArray(components) || !components.length) {
    throw new Error('components required (non-empty array)')
  }
  return components.map((c, i) => {
    const compId = Number(c.itemId)
    if (!Number.isFinite(compId) || compId <= 0) throw new Error(`component #${i + 1} missing a valid itemId`)
    if (compId === Number(itemId)) throw new Error(`component ${compId} is the assembly item itself (self-reference not allowed)`)
    const quantity = Number(c.quantity)
    if (!(quantity > 0)) throw new Error(`component ${compId} needs quantity > 0`)
    return {
      item: { id: String(compId) },
      quantity,
      bomQuantity: Number(c.bomQuantity ?? quantity),
      componentYield: Number(c.componentYield ?? 100),
      itemSource: { id: 'STOCK' },
      lineId: i + 1,
    }
  })
}

// Read-only diff: current revision components vs the proposed set.
async function previewBom(itemId, components) {
  const items = buildComponentItems(itemId, components) // validates
  const current = await getItemBom(itemId)
  const names = await resolveNames(components.map((c) => c.itemId))
  const proposed = components.map((c) => ({
    itemId: Number(c.itemId),
    itemName: c.itemName || names[String(c.itemId)] || `item ${c.itemId}`,
    quantity: Number(c.quantity),
    bomQuantity: Number(c.bomQuantity ?? c.quantity),
    componentYield: Number(c.componentYield ?? 100),
  }))
  return {
    itemId: Number(itemId),
    itemName: current.itemName,
    hasBom: current.hasBom,
    current: current.components,
    proposed,
    nsItems: items,
  }
}

/**
 * Overwrite the item's current/default BOM revision components. If the item has
 * no BOM yet, create bom + revision and link it (mirrors attachBatchBom.js).
 * Honors config.MES_DRY_RUN. Returns the persisted BOM (re-read) on commit.
 */
async function commitBom(itemId, components) {
  const items = buildComponentItems(itemId, components)
  const recordType = await resolveAssemblyEndpoint(itemId)
  let { bomId, revisionId } = await resolveBomRevision(itemId, recordType)

  if (config.MES_DRY_RUN) {
    console.log(`[BomAdmin] DRY RUN — would write ${items.length} component(s) to item ${itemId} (bom ${bomId}, rev ${revisionId})`)
    return { dryRun: true, itemId: Number(itemId), bomId, revisionId, wouldWrite: items }
  }

  if (revisionId) {
    // Overwrite current revision — full sublist replace.
    await core.netsuitePatch(`/record/v1/bomRevision/${revisionId}`, { component: { items } })
  } else {
    // No BOM attached yet — create + link.
    const itemName = (await core.netsuiteGet(`/record/v1/${recordType}/${itemId}?fields=itemId`))?.body?.itemId || `item ${itemId}`
    const bomRes = await core.netsuitePost('/record/v1/bom', {
      name: String(itemName),
      availableForAllLocations: true,
      availableForAllAssemblies: false,
    })
    bomId = extractId(bomRes)
    if (!bomId) throw new Error('failed to create BOM (no id returned)')
    const revRes = await core.netsuitePost('/record/v1/bomRevision', {
      billOfMaterials: { id: bomId },
      name: 'Revision 1',
      component: { items },
    })
    revisionId = extractId(revRes)
    if (!revisionId) throw new Error('failed to create BOM revision (no id returned)')
    await core.netsuitePatch(`/record/v1/${recordType}/${itemId}`, {
      billOfMaterials: {
        items: [{ billOfMaterials: { id: bomId }, currentRevision: { id: revisionId }, masterDefault: true }],
      },
    })
  }

  const after = await getItemBom(itemId)
  return { dryRun: false, created: !revisionId, ...after }
}

/**
 * Bulk: set every surge-tank FG's BOM to a single component of 1 lb of its
 * batch-tank twin. Dry-run by default — returns a per-FG before/after diff with
 * warnings; only writes when commit === true.
 */
async function bulkSurgeTwins({ commit = false } = {}) {
  const fgIds = Object.values(RAW_FG_TO_FG_MAP)
  const names = await resolveNames([...fgIds, ...Object.keys(RAW_FG_TO_FG_MAP).map(Number)])
  const results = []

  for (const fgId of fgIds) {
    const rawFgId = FG_TO_RAW_FG_MAP[String(fgId)]
    const entry = {
      fgId: Number(fgId),
      fgName: names[String(fgId)] || `item ${fgId}`,
      batchGoodId: rawFgId ? Number(rawFgId) : null,
      batchGoodName: rawFgId ? names[String(rawFgId)] || `item ${rawFgId}` : null,
      warnings: [],
      status: 'preview',
    }

    if (!rawFgId) {
      entry.warnings.push('no batch-tank twin in RAW_FG_TO_FG_MAP')
      entry.status = 'skipped'
      results.push(entry)
      continue
    }

    const target = [{ itemId: Number(rawFgId), quantity: 1, bomQuantity: 1, componentYield: 100 }]
    entry.after = [{ itemId: Number(rawFgId), itemName: entry.batchGoodName, quantity: 1, bomQuantity: 1, componentYield: 100 }]
    try {
      const before = await getItemBom(fgId)
      entry.before = before.components
      entry.hadBom = before.hasBom
      if (commit) {
        const res = await commitBom(fgId, target)
        entry.status = res.dryRun ? 'dry-run' : 'committed'
      }
    } catch (err) {
      entry.warnings.push(err.message)
      entry.status = 'error'
    }
    results.push(entry)
  }

  return { commit: !!commit, count: results.length, results }
}

module.exports = {
  getGroups,
  getItemBom,
  searchItems,
  previewBom,
  commitBom,
  bulkSurgeTwins,
}
