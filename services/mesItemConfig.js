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
  ORG_3_5:     { id: 5401, name: 'Raw Organic 3.5%' },
  ORG_CREAM:   { id: 5483, name: 'Raw Organic Cream' },
  ORG_MILK:    { id: 5404, name: 'Raw Organic Milk' },
  ORG_UF:      { id: 5402, name: 'Raw Organic UF Milk' },
  ORG_A2:      { id: 5403, name: 'Raw Organic A2 Milk' },
  ORG_A2_GRADE: { id: 5406, name: 'Raw Organic Grade A (A2/A2) Milk' },
}

const WASTE_ALERT_THRESHOLD = 5

// Maps '<assemblyItemId>_<skimProductIndex>' → NS BOM ID for assemblyUnbuild.
// Each BOM represents one fat-level output; the skim destination's productIndex
// determines which BOM (and therefore which component items) NS should use.
const SEPARATION_BOM_MAP = {
  '5417_1': 335,  // Conventional → 3.5%
  '5417_2': 334,  // Conventional → 3.25%
  '5417_3': 333,  // Conventional → 2%
  '5417_4': 332,  // Conventional → 1%
  '5417_5': 251,  // Conventional → Fat Free / Skim
  '5404_6': 339,  // Organic → 3.5%
  '5404_7': 338,  // Organic → 3.25%
  '5404_8': 337,  // Organic → 2%
  '5404_9': 336,  // Organic → 1%
  '5404_10': 252, // Organic → Fat Free / Skim
}

function getSeparationBomId(assemblyItemId, skimProductIndex) {
  if (!assemblyItemId || !skimProductIndex) return null
  return SEPARATION_BOM_MAP[`${assemblyItemId}_${skimProductIndex}`] || null
}

const BLEND_TANK_ITEM_MAP = {}

// NS bin IDs for each silo and blend tank at location 23 (bin names: Silo-Raw-N, Silo-Cream-N, Blend-NA/B)
const SILO_BIN_MAP = {
  MSilo1: 1006,
  MSilo2: 1002,
  MSilo3: 1003,
  MSilo4: 1005,
  MSilo5: 1001,
  CSilo1: 1013,
  CSilo2: 1008,
  CSilo3: 1007,
}

const TANK_BIN_MAP = {
  BlendTank1A: 1016,
  BlendTank1B: 1017,
  BlendTank2A: 1019,
  BlendTank2B: 1020,
}

// Aseptic surge tanks (post-UHT). Operator routes any UHT to any ST per run,
// so completion bin for a UHT-direct WO is whichever ST is connected at the
// time. NS bin names: Surge-81/82/83/84.
const SURGE_TANK_BIN_MAP = {
  ST81: 1011,
  ST82: 1012,
  ST83: 1014,
  ST84: 1015,
}

// SCADA strings for silos aren't perfectly consistent — operators sometimes
// configure "RawMilkSilo5" / "CreamSilo2" instead of the canonical "MSilo5" /
// "CSilo2". Normalize to the bin-map key before lookup.
function normalizeSiloName(raw) {
  if (!raw || typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s) return null
  if (SILO_BIN_MAP[s] != null || TANK_BIN_MAP[s] != null) return s

  const m = s.match(/(\d+)\s*$/)
  if (!m) return null
  const n = m[1]
  const lower = s.toLowerCase()
  if (lower.includes('cream') || lower.startsWith('csilo') || lower.startsWith('cl')) {
    return `CSilo${n}`
  }
  if (lower.includes('milk') || lower.includes('skim') || lower.startsWith('msilo') || lower.startsWith('ml')) {
    return `MSilo${n}`
  }
  return null
}

function getBinId(siloOrTankName) {
  if (!siloOrTankName) return null
  const direct = SILO_BIN_MAP[siloOrTankName] ?? TANK_BIN_MAP[siloOrTankName] ?? SURGE_TANK_BIN_MAP[siloOrTankName]
  if (direct != null) return direct
  // Surge-tank shorthand (ST81-84) is already canonical; no further normalization.
  if (/^ST\d+$/.test(siloOrTankName)) return null
  const normalized = normalizeSiloName(siloOrTankName)
  if (!normalized) return null
  const v = SILO_BIN_MAP[normalized] ?? TANK_BIN_MAP[normalized] ?? null
  return v != null ? v : null
}

// Classify a destination silo as the cream receiver or skim receiver.
// Cream silos start with "C" (CSilo*), milk silos start with "M" (MSilo*) — raw
// skim is received back into an M-silo after separation.
function classifySiloDestination(raw) {
  const name = normalizeSiloName(raw)
  if (!name) return null
  if (name.startsWith('CSilo')) return 'cream'
  if (name.startsWith('MSilo')) return 'skim'
  return null
}

const HISTORIAN_ITEM_MAP = {
  '300015': { id: 5417, name: 'Raw Conventional Milk', nsType: 'Assembly' },
  '300016': { id: 5404, name: 'Raw Organic Milk', nsType: 'Assembly' },
  '300005': { id: 5477, name: 'Raw Conventional 0%', nsType: 'InvtPart' },
  '300010': { id: 5482, name: 'Raw Organic 0%', nsType: 'InvtPart' },
  '300011': { id: 5480, name: 'Raw Conventional Cream', nsType: 'InvtPart' },
  '300012': { id: 5483, name: 'Raw Organic Cream', nsType: 'InvtPart' },
  '300013': { id: 5405, name: 'Raw Conventional UF Milk', nsType: 'InvtPart' },
  '300017': { id: 5403, name: 'Raw Organic A2 Milk', nsType: 'Assembly' },
  '205000': { id: 5406, name: 'Raw Organic Grade A (A2/A2) Milk', nsType: 'Assembly' },
}

// Keyed by the Standardization HMI "Product Config" index (1-40). When the
// separator runs, the source silo's IndexSelectRead, the skim-destination
// silo's IndexSelectRead, and the cream-destination silo's IndexSelectRead
// each resolve to an entry here — that lookup drives the NS items on the
// assembly unbuild. An entry with `id: null` means the NetSuite item has
// not been created yet; batches that land on a null entry are deliberately
// dropped to `pending_ns` so we have a list of what still needs to be
// created in NetSuite before the flow is end-to-end.
const PRODUCT_INDEX_ITEM_MAP = {
  1:  { id: 5416, name: 'Conventional Whole 3.5%' },
  2:  { id: 5413, name: 'Conventional Whole 3.25%' },
  3:  { id: 5412, name: 'Conventional Reduced Fat 2%' },
  4:  { id: 5415, name: 'Conventional Low Fat 1%' },
  5:  { id: 5477, name: 'Conventional Fat Free' },
  6:  { id: 5401, name: 'Organic Whole 3.5%' },
  7:  { id: 5411, name: 'Organic Whole 3.25%' },
  8:  { id: 5410, name: 'Organic Reduced Fat 2%' },
  9:  { id: 5409, name: 'Organic Low Fat 1%' },
  10: { id: 5482, name: 'Organic Fat Free' },
  11: { id: 5480, name: 'Conventional Cream 40%' },
  12: { id: 5483, name: 'Organic Cream 40%' },
  13: { id: 5405, name: 'Conventional UF Milk' },
  14: { id: 5402, name: 'Organic UF Milk' },
  15: { id: 5417, name: 'Raw Conventional' },
  16: { id: 5404, name: 'Raw Organic' },
  19: { id: null, name: 'Water' },
  20: { id: null, name: 'Blowback' },
  21: { id: 5403, name: 'Raw A2 Organic' },
  22: { id: null, name: 'A2 Organic Whole 3.25%' },
  23: { id: null, name: 'A2 Organic Reduced Fat 2%' },
  24: { id: null, name: 'A2 Organic Low Fat 1%' },
  25: { id: null, name: 'A2 Organic Fat Free' },
  26: { id: null, name: 'A2 Organic Cream' },
}

function getItemByProductIndex(idx) {
  const n = Number(idx)
  if (!Number.isFinite(n) || n <= 0) return { id: null, name: `Unknown product (index ${idx ?? 'none'})` }
  const hit = PRODUCT_INDEX_ITEM_MAP[n]
  if (hit) return hit
  return { id: null, name: `Unmapped product index ${n}` }
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
  SEPARATION_BOM_MAP,
  getSeparationBomId,
  SILO_ITEM_MAP,
  HISTORIAN_ITEM_MAP,
  BLEND_TANK_ITEM_MAP,
  SILO_BIN_MAP,
  TANK_BIN_MAP,
  SURGE_TANK_BIN_MAP,
  RAW_ITEMS,
  PRODUCT_INDEX_ITEM_MAP,
  CREAM_ITEM,
  SKIM_ITEM,
  CREAM_ITEM_CONV,
  CREAM_ITEM_ORG,
  SKIM_ITEM_CONV,
  SKIM_ITEM_ORG,
  WASTE_ALERT_THRESHOLD,
  getItem,
  getItemByProductIndex,
  getOutputItems,
  getInputItem,
  getBlendTankItem,
  getBinId,
  normalizeSiloName,
  classifySiloDestination,
  resolveNSItemByMesCode,
}
