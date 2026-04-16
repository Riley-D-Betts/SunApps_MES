const core = require('../clients/coreClient')

const _resolvedItemCache = {}

const SILO_ITEM_MAP = {
  'MSilo1': { id: 5417, name: 'Raw Conventional Milk' },
  'MSilo2': { id: 5417, name: 'Raw Conventional Milk' },
  'MSilo3': { id: 5417, name: 'Raw Conventional Milk' },
  'MSilo4': { id: 5404, name: 'Raw Organic Milk' },
  'MSilo5': { id: 5404, name: 'Raw Organic Milk' },
  'CSilo1': { id: 5480, name: 'Raw Conventional Cream' },
  'CSilo2': { id: 5480, name: 'Raw Conventional Cream' },
  'CSilo3': { id: 5483, name: 'Raw Organic Cream' },
}

const CREAM_ITEM_CONV = { id: 5480, name: 'Raw Conventional Cream' }
const CREAM_ITEM_ORG  = { id: 5483, name: 'Raw Organic Cream' }
const SKIM_ITEM_CONV  = { id: 5477, name: 'Raw Conventional 0%' }
const SKIM_ITEM_ORG   = { id: 5482, name: 'Raw Organic 0%' }

const CREAM_ITEM = CREAM_ITEM_CONV
const SKIM_ITEM  = SKIM_ITEM_CONV

const RAW_ITEMS = {
  CONV_0:      { id: 5477, name: 'Raw Conventional 0%' },
  CONV_1:      { id: 5415, name: 'Raw Conventional 1%' },
  CONV_2:      { id: 5412, name: 'Raw Conventional 2%' },
  CONV_3_25:   { id: 5413, name: 'Raw Conventional 3.25%' },
  CONV_3_5:    { id: 5416, name: 'Raw Conventional 3.5%' },
  CONV_CREAM:  { id: 5480, name: 'Raw Conventional Cream' },
  CONV_MILK:   { id: 5417, name: 'Raw Conventional Milk' },
  CONV_UF:     { id: 5405, name: 'Raw Conventional UF Milk' },
  ORG_0:       { id: 5482, name: 'Raw Organic 0%' },
  ORG_1:       { id: 5409, name: 'Raw Organic 1%' },
  ORG_2:       { id: 5410, name: 'Raw Organic 2%' },
  ORG_3_25:    { id: 5411, name: 'Raw Organic 3.25%' },
  ORG_3_5:     { id: 5481, name: 'Raw Organic 3.5%' },
  ORG_CREAM:   { id: 5483, name: 'Raw Organic Cream' },
  ORG_MILK:    { id: 5404, name: 'Raw Organic Milk' },
  ORG_UF:      { id: 5402, name: 'Raw Organic UF Milk' },
  ORG_A2:      { id: 5403, name: 'Raw Organic A2 Milk' },
  ORG_A2_GRADE: { id: 5406, name: 'Raw Organic Grade A (A2/A2) Milk' },
}

const WASTE_ALERT_THRESHOLD = 5

const BLEND_TANK_ITEM_MAP = {}

const HISTORIAN_ITEM_MAP = {
  '300015': { id: 5417, name: 'Raw Conventional Milk', nsType: 'Assembly' },
  '300016': { id: 5404, name: 'Raw Organic Milk', nsType: 'Assembly' },
  '300005': { id: 5477, name: 'Raw Conventional 0%', nsType: 'InvtPart' },
  '300010': { id: 5482, name: 'Raw Organic 0%', nsType: 'InvtPart' },
  '300011': { id: 5480, name: 'Raw Conventional Cream', nsType: 'InvtPart' },
  '300012': { id: 5483, name: 'Raw Organic Cream', nsType: 'InvtPart' },
}

function getItem(mesItemCode, sourceSilo) {
  if (mesItemCode && HISTORIAN_ITEM_MAP[mesItemCode]) return HISTORIAN_ITEM_MAP[mesItemCode]
  if (sourceSilo && SILO_ITEM_MAP[sourceSilo]) return SILO_ITEM_MAP[sourceSilo]
  return { id: null, name: `Unknown (item: ${mesItemCode || 'none'}, silo: ${sourceSilo || 'none'})` }
}

function getOutputItems(sourceSilo) {
  const isOrganic = sourceSilo === 'MSilo4' || sourceSilo === 'MSilo5'
  return {
    cream: isOrganic ? CREAM_ITEM_ORG : CREAM_ITEM_CONV,
    skim: isOrganic ? SKIM_ITEM_ORG : SKIM_ITEM_CONV,
  }
}

function getInputItem(sourceSilo) {
  const item = SILO_ITEM_MAP[sourceSilo]
  if (!item) throw new Error(`Unknown silo: ${sourceSilo}. Known silos: ${Object.keys(SILO_ITEM_MAP).join(', ')}`)
  return item
}

function getBlendTankItem(mesItemCode) {
  if (mesItemCode && BLEND_TANK_ITEM_MAP[mesItemCode]) return BLEND_TANK_ITEM_MAP[mesItemCode]
  if (mesItemCode && HISTORIAN_ITEM_MAP[mesItemCode]) return HISTORIAN_ITEM_MAP[mesItemCode]
  return { id: null, name: `Unknown blend tank item (${mesItemCode || 'none'})` }
}

async function resolveNSItemByMesCode(mesItemCode) {
  if (!mesItemCode) return null
  if (BLEND_TANK_ITEM_MAP[mesItemCode]) return BLEND_TANK_ITEM_MAP[mesItemCode]
  if (HISTORIAN_ITEM_MAP[mesItemCode]) return HISTORIAN_ITEM_MAP[mesItemCode]
  if (_resolvedItemCache[mesItemCode]) return _resolvedItemCache[mesItemCode]

  const query = `SELECT id, itemid, displayname, description, subtype FROM item WHERE (displayname = '${mesItemCode}' OR itemid = '${mesItemCode}') AND isinactive = 'F'`
  const response = await core.suiteQL(query)
  const items = response?.items || []

  if (items.length === 0) {
    console.warn(`[MesItemConfig] No NS item found for MES code '${mesItemCode}'`)
    return null
  }

  if (items.length > 1) {
    console.warn(`[MesItemConfig] Multiple NS items found for MES code '${mesItemCode}' — using first: ${items[0].id}`)
  }

  const item = items[0]
  const resolved = { id: parseInt(item.id), name: item.displayname || item.itemid, nsType: item.subtype || 'Assembly' }
  _resolvedItemCache[mesItemCode] = resolved
  console.log(`[MesItemConfig] Resolved MES code '${mesItemCode}' → NS item ${resolved.id} (${resolved.name})`)
  return resolved
}

module.exports = {
  SILO_ITEM_MAP,
  HISTORIAN_ITEM_MAP,
  BLEND_TANK_ITEM_MAP,
  RAW_ITEMS,
  CREAM_ITEM,
  SKIM_ITEM,
  CREAM_ITEM_CONV,
  CREAM_ITEM_ORG,
  SKIM_ITEM_CONV,
  SKIM_ITEM_ORG,
  WASTE_ALERT_THRESHOLD,
  getItem,
  getOutputItems,
  getInputItem,
  getBlendTankItem,
  resolveNSItemByMesCode,
}
