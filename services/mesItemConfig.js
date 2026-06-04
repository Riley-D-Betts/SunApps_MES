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
const SKIM_ITEM_CONV  = { id: 8163, name: 'Raw Conventional 0% - Skim' }
const SKIM_ITEM_ORG   = { id: 5482, name: 'Raw Organic 0%' }

const CREAM_ITEM = CREAM_ITEM_CONV
const SKIM_ITEM  = SKIM_ITEM_CONV

const RAW_ITEMS = {
  CONV_0:      { id: 8163, name: 'Raw Conventional 0% - Skim' },
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
  ORG_A2_0:    { id: 5484, name: 'Raw Organic A2 0%' },
  ORG_A2_1:    { id: 8366, name: 'Raw Organic A2 1%' },
  ORG_A2_2:    { id: 8367, name: 'Raw Organic A2 2%' },
  ORG_A2_3_25: { id: 8368, name: 'Raw Organic A2 3.25%' },
  ORG_A2_3_5:  { id: 8369, name: 'Raw Organic A2 3.5%' },
  ORG_A2_4:    { id: 8370, name: 'Raw Organic A2 4%' },
  ORG_A2_CREAM:{ id: 8365, name: 'Raw Organic A2 Cream' },
}

const WASTE_ALERT_THRESHOLD = 5

// Maps '<assemblyItemId>_<skimProductIndex>' → NS BOM ID for assemblyUnbuild.
// Each BOM represents one fat-level output; the skim destination's productIndex
// determines which BOM (and therefore which component items) NS should use.
const SEPARATION_BOM_MAP = {
  '5417_1': 353,  // Conventional → 3.5%   (Raw Conventional Milk to 3.5% and Cream)
  '5417_2': 351,  // Conventional → 3.25%  (Raw Conventional Milk to 3.25% and Cream)
  '5417_3': 338,  // Conventional → 2%     (Raw Conventional Milk to 2% and Cream)
  '5417_4': 337,  // Conventional → 1%     (Raw Conventional Milk to 1% and Cream)
  '5417_5': 251,  // Conventional → Fat Free / Skim (Raw Conventional Milk to Skim and Cream)
  '5404_6': 350,  // Organic → 3.5%   (Raw Organic Milk to 3.5% and cream)
  '5404_7': 349,  // Organic → 3.25%  (Raw Organic Milk to 3.25% and cream)
  '5404_8': 348,  // Organic → 2%     (Raw Organic Milk to 2% and cream)
  '5404_9': 347,  // Organic → 1%     (Raw Organic Milk to 1% and cream)
  '5404_10': 252, // Organic → Fat Free / Skim (Raw Organic Milk to skim and cream)
  // A2 separator outputs — HMI indices 22-25 only (no 3.5% or 4% in SCADA).
  // BOM 253 currently produces regular org cream (5483), not A2 cream (8365) — flag for NS fix.
  '5403_22': 379, // Organic A2 → 3.25% (Raw Organic A2 Milk to A2 3.25% and Cream)
  '5403_23': 378, // Organic A2 → 2%    (Raw Organic A2 Milk to A2 2% and Cream)
  '5403_24': 377, // Organic A2 → 1%    (Raw Organic A2 Milk to A2 1% and Cream)
  '5403_25': 253, // Organic A2 → Fat Free / Skim (Raw Organic A2 Milk to A2 Skim and Cream)
}

// Operators occasionally leave skim-destination silos on conventional indices
// (1-5) even when running organic source (5404). The cream silo has the same
// issue (idx 11 = conv cream while fed organic) which is already handled by
// getCreamItemForSource(). Apply the same tolerance for skim: if source is
// organic and skim index is in the conventional range (1-5), translate to the
// organic equivalent (idx + 5) so BOM lookup and item derivation both land on
// the correct organic item and BOM.
function normalizeSkimIndex(sourceItemId, skimProductIndex) {
  const src = Number(sourceItemId)
  const idx = Number(skimProductIndex)
  if (src === 5404 && idx >= 1 && idx <= 5) return idx + 5
  return idx
}

function getSeparationBomId(assemblyItemId, skimProductIndex) {
  if (!assemblyItemId || !skimProductIndex) return null
  return SEPARATION_BOM_MAP[`${assemblyItemId}_${skimProductIndex}`] || null
}

const BLEND_TANK_ITEM_MAP = {}

// NS bin IDs for each silo and blend tank at location 30 (bin names: Silo-Raw-N, Silo-Cream-N, Blend-NA/B)
const SILO_BIN_MAP = {
  MSilo1: 4931,
  MSilo2: 4932,
  MSilo3: 4933,
  MSilo4: 4934,
  MSilo5: 4935,
  CSilo1: 4928,
  CSilo2: 4929,
  CSilo3: 4930,
}

const TANK_BIN_MAP = {
  BlendTank1A: 3105,
  BlendTank1B: 3106,
  BlendTank2A: 3107,
  BlendTank2B: 3108,
}

// Aseptic surge tanks (post-UHT). Operator routes any UHT to any ST per run,
// so completion bin for a UHT-direct WO is whichever ST is connected at the
// time. NS bin names: Surge-81/82/83/84.
const SURGE_TANK_BIN_MAP = {
  ST81: 4995,
  ST82: 4996,
  ST83: 4997,
  ST84: 4998,
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
  '300005': { id: 8163, name: 'Raw Conventional 0% - Skim', nsType: 'InvtPart' },
  '300010': { id: 5482, name: 'Raw Organic 0%', nsType: 'InvtPart' },
  '300011': { id: 5480, name: 'Raw Conventional Cream', nsType: 'InvtPart' },
  '300012': { id: 5483, name: 'Raw Organic Cream', nsType: 'InvtPart' },
  '300013': { id: 5405, name: 'Raw Conventional UF Milk', nsType: 'InvtPart' },
  '300017': { id: 5403, name: 'Raw Organic A2 Milk', nsType: 'Assembly' },
  '300018': { id: 5484, name: 'Raw Organic A2 0%', nsType: 'InvtPart' },
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
  5:  { id: 8163, name: 'Conventional Fat Free' },
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
  22: { id: 8368, name: 'A2 Organic Whole 3.25%' },
  23: { id: 8367, name: 'A2 Organic Reduced Fat 2%' },
  24: { id: 8366, name: 'A2 Organic Low Fat 1%' },
  25: { id: 5484, name: 'A2 Organic Fat Free' },
  26: { id: 8365, name: 'A2 Organic Cream' },
}

// Layer 2 → Layer 3 translation: each raw FG (blend tank assembly output) maps
// to its FG sibling (surge tank assembly output, 1:1 pasteurize). Derived by
// parallel-walking blendTankProductParser.PRODUCT_CATALOG (raw FG nsId) and
// surgeTankProductParser.PRODUCT_CATALOG (FG nsId). Used by surge tank
// resolveLayer3Component to (a) pick the canonical component for a blend-fed
// surge WO and (b) decide whether to warn on a non-canonical feed.
const RAW_FG_TO_FG_MAP = {
  8333: 3278,  // Raw Alexandre Eco Dairy A2/A2 Organic 4% Whole Milk → Alexandre …
  8371: 4899,  // Raw Alexandre Eco Dairy A2/A2 Organic Chocolate 4% Milk → Alexandre … Chocolate 4% Milk
  8362: 2793,  // Raw Conventional Milk 1% → Conventional Milk 1%
  8361: 3471,  // Raw Conventional Milk 2% → Conventional Milk 2%
  8360: 2808,  // Raw Conventional Milk 3.25% → Conventional Milk 3.25%
  8359: 2645,  // Raw Conventional Milk 3.5% → Conventional Milk 3.5%
  8358: 3223,  // Raw Conventional Whole Milk 3.25% (No Vitamins) → …
  8357: 3395,  // Raw DFI Holiday Nog → DFI Holiday Nog
  8356: 3493,  // Raw DFI Marcel's Modern Pantry Heavy Cream → …
  8355: 2940,  // Raw DFI Marcel's Modern Pantry UHT Half & Half → …
  8354: 3222,  // Raw DFI Marcels 0% Milk → DFI Marcels 0% Milk
  8340: 3228,  // Raw DFI Marcels 1% Milk → DFI Marcels 1% Milk
  8339: 4012,  // Raw DFI Marcels 2% Milk → DFI Marcels 2% Milk
  8353: 3236,  // Raw DFI Marcels 3.25% Milk → DFI Marcels 3.25% Milk
  8350: 3900,  // Raw ESL Half & Half → ESL Half & Half
  8349: 3905,  // Raw ESL Heavy Whip Cream → ESL Heavy Whip Cream
  8335: 5911,  // Raw Horizon Organic 2% Milk → Horizon Organic 2% Milk
  8348: 5907,  // Raw Horizon Organic 3.25% Whole Milk → …
  8347: 4495,  // Raw Kirkland 1% Organic Milk → Kirkland 1% Organic Milk
  8346: 4501,  // Raw Kirkland 2% Organic Lac Free Milk → …
  8344: 4498,  // Raw Kirkland 2% Organic Milk → Kirkland 2% Organic Milk
  8343: 4548,  // Raw Kirkland Chocolate 2% Organic Milk - Aseptic → …
  8342: 6420,  // Raw Kirkland Organic Whole Milk → Kirkland Organic Whole Milk
  8364: 5510,  // Raw American Farmer Whole Milk → American Farmer Whole Milk
  8363: 5314,  // Raw Barista Frappe Mix → Barista Frappe Mix
  8336: 5317,  // Raw Kinera Chocolate → Kinera Chocolate
  8334: 5003,  // Raw Kinera Strawberry → Kinera Strawberry
  8352: 2889,  // Raw DG Half & Half → DG Half & Half
  8351: 2790,  // Raw DG Heavy Cream → DG Heavy Cream
  8341: 3926,  // Raw Organic Milk 0% Lac Free → Organic Milk 0% Lac Free
  8815: 8403,  // Raw Aldi 2% Organic Milk → Aldi 2% Organic Milk
  8816: 8406,  // Raw Aldi 3.25% Organic Whole Milk → Aldi 3.25% Organic Whole Milk
  8817: 8409,  // Raw Aldi 3.25% Organic Whole Milk w/ DHA → Aldi 3.25% Organic Whole Milk w/ DHA
  8812: 7477,  // Raw Horizon Organic Half & Half → Horizon Organic Half & Half
  8918: 8271,  // Raw DFI Marcels Chocolate 1% Milk → DFI Marcels Chocolate 1% Milk
}

const FG_TO_RAW_FG_MAP = Object.fromEntries(
  Object.entries(RAW_FG_TO_FG_MAP).map(([rawFg, fg]) => [String(fg), Number(rawFg)])
)

// Item IDs that represent raw bulk (pre-separator) milk. Used to distinguish
// layer-2-skip (Layer 1 ran, post-separator content) from layer-1-and-2-skip
// (Layer 1 also skipped, bulk milk piped straight to UHT) when a silo feeds
// the UHT directly.
const BULK_RAW_ITEM_IDS = new Set([5417, 5404, 5403, 5406])

function isBulkRawId(id) {
  return BULK_RAW_ITEM_IDS.has(Number(id))
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

// Cream output is fully determined by the source silo's item — operators have
// no fat-level choice for cream, so the cream silo's productIndex on the HMI
// is not authoritative (and is often stale, e.g. CSilo3 reading idx 11 / conv
// while fed by organic source). Always derive from source instead.
// 5404 = Raw Organic, 5403 = Raw Organic A2, 5406 = Grade A A2/A2 → organic cream.
// A2 cream item 8365 exists in NS but BOM 253 still produces 5483; mirror that.
function getCreamItemForSource(sourceItemId) {
  const id = Number(sourceItemId)
  if (id === 5404 || id === 5403 || id === 5406) return CREAM_ITEM_ORG
  return CREAM_ITEM_CONV
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

function clearCaches() {
  for (const k of Object.keys(_resolvedItemCache)) delete _resolvedItemCache[k]
}

module.exports = {
  clearCaches,
  SEPARATION_BOM_MAP,
  getSeparationBomId,
  normalizeSkimIndex,
  SILO_ITEM_MAP,
  HISTORIAN_ITEM_MAP,
  BLEND_TANK_ITEM_MAP,
  SILO_BIN_MAP,
  TANK_BIN_MAP,
  SURGE_TANK_BIN_MAP,
  RAW_ITEMS,
  PRODUCT_INDEX_ITEM_MAP,
  RAW_FG_TO_FG_MAP,
  FG_TO_RAW_FG_MAP,
  BULK_RAW_ITEM_IDS,
  isBulkRawId,
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
  getCreamItemForSource,
  getInputItem,
  getBlendTankItem,
  getBinId,
  normalizeSiloName,
  classifySiloDestination,
  resolveNSItemByMesCode,
}
