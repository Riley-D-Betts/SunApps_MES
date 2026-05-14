/**
 * Surge Tank Product Parser
 *
 * Resolves a surge-tank product string (from ThermaRoute.ST{N}_ProductDesc) to
 * a NetSuite finished-goods (FG) assembly item — the *pasteurized* version of
 * the product. The blend tank parser ([[blendTankProductParser]]) points at
 * the corresponding RAW items; this one is the FG counterpart.
 *
 * Two lookup paths in order:
 *   1. Exact match against FG_ITEM_MAP (for the standardized AVEVA values
 *      that are coming "soon"). Operator-set free-text won't hit these.
 *   2. Fuzzy match against PRODUCT_CATALOG (legacy free-text path — same
 *      brand/fat%/modifiers scoring as the blend tank parser).
 *
 * When AVEVA ships the constrained surge-tank product input, the exact-match
 * branch will catch every real value and the fuzzy fallback becomes dead code
 * — at that point delete the catalog and keep only the map.
 */

// ── Exact-match table (AVEVA standardized values) ───────────────────────
// Add entries as the standardized list lands. Keys are case-sensitive and
// exactly as the historian writes them.
const FG_ITEM_MAP = {
  // (Populate as the standardized list arrives.)
}

// ── Fuzzy catalog (legacy free-text path) ───────────────────────────────
// Mirrors blendTankProductParser's PRODUCT_CATALOG but each entry's nsId
// points at the FG (finished pasteurized) item, not the raw assembly.
const PRODUCT_CATALOG = [
  // Alexandre Eco Dairy
  { nsId: 3278, name: 'Alexandre Eco Dairy A2/A2 Organic 4% Whole Milk', brand: 'alexandre', fatPct: 4, modifiers: ['organic', 'a2', 'whole'] },
  { nsId: 4899, name: 'Alexandre Eco Dairy A2/A2 Organic Chocolate 4% Milk', brand: 'alexandre', fatPct: 4, modifiers: ['organic', 'a2', 'chocolate'] },

  // Conventional Milk
  { nsId: 2793, name: 'Conventional Milk 1%', brand: 'conventional', fatPct: 1, modifiers: [] },
  { nsId: 2880, name: 'Conventional Milk 1% LAC Free', brand: 'conventional', fatPct: 1, modifiers: ['lacfree'] },
  { nsId: 3471, name: 'Conventional Milk 2%', brand: 'conventional', fatPct: 2, modifiers: [] },
  { nsId: 2883, name: 'Conventional Milk 2% LAC Free', brand: 'conventional', fatPct: 2, modifiers: ['lacfree'] },
  { nsId: 2808, name: 'Conventional Milk 3.25%', brand: 'conventional', fatPct: 3.25, modifiers: [] },
  { nsId: 2886, name: 'Conventional Milk 3.25% Lac Free', brand: 'conventional', fatPct: 3.25, modifiers: ['lacfree'] },
  { nsId: 2645, name: 'Conventional Milk 3.5%', brand: 'conventional', fatPct: 3.5, modifiers: [] },
  { nsId: 3223, name: 'Conventional Whole Milk 3.25% (No Vitamins)', brand: 'conventional', fatPct: 3.25, modifiers: ['novitamins'] },

  // DFI (Diversified Foods Inc) — general
  { nsId: 3231, name: 'DFI 2% Milk', brand: 'dfi', fatPct: 2, modifiers: [] },
  { nsId: 3395, name: 'DFI Holiday Nog', brand: 'dfi', fatPct: null, modifiers: ['nog'] },

  // DFI Marcel's specialty
  { nsId: 6855, name: "DFI Marcel's 1% Lac Free", brand: 'marcels', fatPct: 1, modifiers: ['lacfree'] },
  { nsId: 3493, name: "DFI Marcel's Modern Pantry Heavy Cream", brand: 'marcels', fatPct: null, modifiers: ['heavycream'] },
  { nsId: 3046, name: "DFI Marcel's Modern Pantry Light Whip Cream UHT", brand: 'marcels', fatPct: null, modifiers: ['lightcream'] },
  { nsId: 2940, name: "DFI Marcel's Modern Pantry UHT Half & Half", brand: 'marcels', fatPct: null, modifiers: ['halfhalf'] },

  // DFI Marcels milk
  { nsId: 3222, name: 'DFI Marcels 0% Milk', brand: 'marcels', fatPct: 0, modifiers: [] },
  { nsId: 3228, name: 'DFI Marcels 1% Milk', brand: 'marcels', fatPct: 1, modifiers: [] },
  { nsId: 4012, name: 'DFI Marcels 2% Milk', brand: 'marcels', fatPct: 2, modifiers: [] },
  { nsId: 3236, name: 'DFI Marcels 3.25% Milk', brand: 'marcels', fatPct: 3.25, modifiers: ['whole'] },

  // DFI Swan River
  { nsId: 3939, name: 'DFI: Swan River Vanilla Sweet Cream (F)', brand: 'swanriver', fatPct: null, modifiers: ['sweetcream'] },

  // ESL
  { nsId: 3900, name: 'ESL Half & Half', brand: 'esl', fatPct: null, modifiers: ['halfhalf'] },
  { nsId: 3905, name: 'ESL Heavy Whip Cream', brand: 'esl', fatPct: null, modifiers: ['heavycream'] },

  // Horizon Organic
  { nsId: 5911, name: 'Horizon Organic 2% Milk', brand: 'horizon', fatPct: 2, modifiers: ['organic'] },
  { nsId: 5907, name: 'Horizon Organic 3.25% Whole Milk', brand: 'horizon', fatPct: 3.25, modifiers: ['organic', 'whole'] },
  { nsId: 7477, name: 'Horizon Organic Half & Half', brand: 'horizon', fatPct: null, modifiers: ['organic', 'halfhalf'] },

  // Kirkland (Costco)
  { nsId: 4495, name: 'Kirkland 1% Organic Milk', brand: 'kirkland', fatPct: 1, modifiers: ['organic'] },
  { nsId: 4501, name: 'Kirkland 2% Organic Lac Free Milk', brand: 'kirkland', fatPct: 2, modifiers: ['organic', 'lacfree'] },
  { nsId: 4498, name: 'Kirkland 2% Organic Milk', brand: 'kirkland', fatPct: 2, modifiers: ['organic'] },
  { nsId: 4485, name: 'Kirkland A2 Organic Whole Milk', brand: 'kirkland', fatPct: null, modifiers: ['organic', 'a2', 'whole'] },
  { nsId: 4548, name: 'Kirkland Chocolate 2% Organic Milk - Aseptic', brand: 'kirkland', fatPct: 2, modifiers: ['organic', 'chocolate'] },
  { nsId: 6420, name: 'Kirkland Organic Whole Milk', brand: 'kirkland', fatPct: null, modifiers: ['organic', 'whole'] },

  // American Farmer / Blue Valley / Golden Flow
  { nsId: 5510, name: 'American Farmer Whole Milk', brand: 'americanfarmer', fatPct: 3.5, modifiers: ['whole'] },
  { nsId: 7455, name: 'Blue Valley Whole Milk', brand: 'bluevalley', fatPct: 3.3, modifiers: ['whole'] },
  { nsId: 7452, name: 'Golden Flow', brand: 'goldenflow', fatPct: 1, modifiers: [] },

  // Barista / Kinera / Nurri (specialty)
  { nsId: 5314, name: 'Barista Frappe Mix', brand: 'barista', fatPct: null, modifiers: ['frappe'] },
  { nsId: 5317, name: 'Kinera Chocolate', brand: 'kinera', fatPct: null, modifiers: ['chocolate'] },
  { nsId: 5003, name: 'Kinera Strawberry', brand: 'kinera', fatPct: null, modifiers: ['strawberry'] },
  { nsId: 7674, name: 'Nurri - Chocolate', brand: 'nurri', fatPct: null, modifiers: ['chocolate'] },
  { nsId: 7671, name: 'Nurri - Salted Caramel', brand: 'nurri', fatPct: null, modifiers: ['caramel'] },
  { nsId: 7668, name: 'Nurri - Sweet Cream', brand: 'nurri', fatPct: null, modifiers: ['sweetcream'] },

  // DairyPure
  { nsId: 5320, name: 'DairyPure 2% - 8oz', brand: 'dairypure', fatPct: 2, modifiers: [] },
  { nsId: 5323, name: 'DairyPure Half & Half - 8oz', brand: 'dairypure', fatPct: null, modifiers: ['halfhalf'] },

  // DG
  { nsId: 2796, name: 'DG Chocolate Milk 2%', brand: 'dg', fatPct: 2, modifiers: ['chocolate'] },
  { nsId: 2889, name: 'DG Half & Half', brand: 'dg', fatPct: null, modifiers: ['halfhalf'] },
  { nsId: 2790, name: 'DG Heavy Cream', brand: 'dg', fatPct: null, modifiers: ['heavycream'] },
  { nsId: 4029, name: 'DG Light Cream', brand: 'dg', fatPct: null, modifiers: ['lightcream'] },

  // Dutch Brothers
  { nsId: 7474, name: 'Dutch - Annihilator (Macadamia)', brand: 'dutch', fatPct: null, modifiers: ['macadamia'] },
  { nsId: 7225, name: 'Dutch - Caramelizer (Choc Caramel)', brand: 'dutch', fatPct: null, modifiers: ['chocolate', 'caramel'] },
  { nsId: 7222, name: 'Dutch - Golden Eagle (Vanilla Caramel)', brand: 'dutch', fatPct: null, modifiers: ['caramel'] },

  // HWC Trial
  { nsId: 6624, name: 'HWC Aseptic Trial', brand: 'hwc', fatPct: null, modifiers: ['heavycream'] },

  // Organic misc
  { nsId: 6651, name: 'Organic 2% Sample', brand: 'organic', fatPct: 2, modifiers: ['organic'] },
  { nsId: 3926, name: 'Organic Milk 0% Lac Free', brand: 'organic', fatPct: 0, modifiers: ['organic', 'lacfree'] },
  { nsId: 7594, name: 'Tres Monjitas 2% Organic', brand: 'tresmonjitas', fatPct: 2, modifiers: ['organic'] },

  // Trials (may not match — that's OK, they'll go to pending_ns)
  { nsId: 6891, name: 'Trial - Sweet Cream', brand: 'trial', fatPct: null, modifiers: ['sweetcream'] },
  { nsId: 6752, name: 'Water Trials', brand: 'water', fatPct: null, modifiers: [] },
]

const BRAND_ALIASES = {
  marcel: 'marcels', marcels: 'marcels', "marcel's": 'marcels', mp: 'marcels',
  kirkland: 'kirkland', ks: 'kirkland', costco: 'kirkland',
  conventional: 'conventional', conv: 'conventional',
  dfi: 'dfi', diversified: 'dfi',
  dg: 'dg',
  esl: 'esl',
  horizon: 'horizon',
  alexandre: 'alexandre', alex: 'alexandre',
  'swan river': 'swanriver', swanriver: 'swanriver', starbucks: 'swanriver',
  'american farmer': 'americanfarmer', americanfarmer: 'americanfarmer',
  'blue valley': 'bluevalley', bluevalley: 'bluevalley',
  'golden flow': 'goldenflow', goldenflow: 'goldenflow',
  barista: 'barista',
  kinera: 'kinera',
  nurri: 'nurri',
  dairypure: 'dairypure', 'dairy pure': 'dairypure',
  dutch: 'dutch', 'dutch bros': 'dutch',
  hwc: 'hwc',
  organic: 'organic',
  'tres monjitas': 'tresmonjitas', tresmonjitas: 'tresmonjitas',
  trial: 'trial',
  water: 'water',
}

const MODIFIER_PATTERNS = [
  { key: 'lacfree', patterns: ['lac free', 'lacfree', 'lactose free', 'lactosefree', 'lf'] },
  { key: 'organic', patterns: ['organic', 'org'] },
  { key: 'chocolate', patterns: ['chocolate', 'choc'] },
  { key: 'a2', patterns: ['a2', 'a2/a2'] },
  { key: 'whole', patterns: ['whole'] },
  { key: 'halfhalf', patterns: ['half & half', 'half and half', 'halfhalf', 'half half', 'h&h', 'h/h', 'hh'] },
  { key: 'heavycream', patterns: ['heavy cream', 'heavycream', 'heavy whip', 'hwc'] },
  { key: 'lightcream', patterns: ['light cream', 'lightcream', 'light whip'] },
  { key: 'sweetcream', patterns: ['sweet cream', 'sweetcream'] },
  { key: 'nog', patterns: ['nog', 'eggnog'] },
  { key: 'novitamins', patterns: ['no vitamin', 'no vit'] },
  { key: 'frappe', patterns: ['frappe', 'frape'] },
  { key: 'strawberry', patterns: ['strawberry'] },
  { key: 'macadamia', patterns: ['macadamia', 'annihilator'] },
  { key: 'caramel', patterns: ['caramel', 'caramelizer', 'golden eagle'] },
]

function normalize(input) {
  return input
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractFatPct(input) {
  const match = input.match(/(\d+(?:\.\d+)?)\s*%/)
  if (match) return parseFloat(match[1])
  return null
}

function extractBrand(input) {
  const multiWordAliases = Object.keys(BRAND_ALIASES).filter(a => a.includes(' '))
  for (const alias of multiWordAliases) {
    if (input.includes(alias)) return BRAND_ALIASES[alias]
  }
  const words = input.split(/[\s,.\-\/]+/)
  for (const word of words) {
    if (BRAND_ALIASES[word]) return BRAND_ALIASES[word]
  }
  return null
}

function extractModifiers(input) {
  const found = []
  for (const mod of MODIFIER_PATTERNS) {
    for (const pattern of mod.patterns) {
      if (input.includes(pattern)) {
        found.push(mod.key)
        break
      }
    }
  }
  return found
}

function scoreProduct(product, brand, fatPct, modifiers) {
  let score = 0
  if (brand) {
    if (product.brand !== brand) return 0
    score += 10
  }
  if (fatPct !== null && product.fatPct !== null) {
    if (product.fatPct === fatPct) score += 5
    else return 0
  } else if (fatPct !== null && product.fatPct === null) {
    score -= 1
  } else if (fatPct === null && product.fatPct !== null) {
    score -= 1
  }
  for (const mod of modifiers) {
    if (product.modifiers.includes(mod)) score += 3
  }
  for (const mod of product.modifiers) {
    if (!modifiers.includes(mod)) score -= 1
  }
  return score
}

/**
 * Resolve a surge-tank product string to an FG NS item.
 * Tries the exact-match table first (AVEVA standardized) before falling back
 * to the fuzzy brand/fat/modifier scoring.
 */
function parseProductName(input) {
  if (!input || typeof input !== 'string') return null

  if (FG_ITEM_MAP[input] != null) {
    const nsId = FG_ITEM_MAP[input]
    const hit = PRODUCT_CATALOG.find(p => p.nsId === nsId)
    return {
      nsId,
      name: hit?.name || input,
      confidence: 'exact',
      ambiguous: false,
      score: 100,
      parsed: { exactMatch: true, key: input },
      alternatives: [],
    }
  }

  const normalized = normalize(input)
  const brand = extractBrand(normalized)
  const fatPct = extractFatPct(normalized)
  const modifiers = extractModifiers(normalized)
  const parsed = { normalized, brand, fatPct, modifiers }

  const scored = PRODUCT_CATALOG
    .map(p => ({ ...p, score: scoreProduct(p, brand, fatPct, modifiers) }))
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) {
    console.log(`[SurgeTankParser] No match for "${input}" → parsed:`, parsed)
    return null
  }

  const best = scored[0]
  const confidence = best.score >= 15 ? 'high' : best.score >= 10 ? 'medium' : 'low'
  const ambiguous = scored.length > 1 && scored[0].score === scored[1].score

  console.log(`[SurgeTankParser] "${input}" → ${best.name} (NS ${best.nsId}, score=${best.score}, confidence=${confidence}${ambiguous ? ', AMBIGUOUS' : ''})`)
  if (scored.length > 1) {
    console.log(`[SurgeTankParser]   Runner-up: ${scored[1].name} (NS ${scored[1].nsId}, score=${scored[1].score})`)
  }

  return {
    nsId: best.nsId,
    name: best.name,
    confidence,
    ambiguous,
    score: best.score,
    parsed,
    alternatives: ambiguous ? scored.slice(1, 4).map(p => ({ nsId: p.nsId, name: p.name, score: p.score })) : [],
  }
}

function getProductByNsId(nsId) {
  return PRODUCT_CATALOG.find(p => p.nsId === nsId) || null
}

function getProductCatalog() {
  return PRODUCT_CATALOG.map(p => ({ nsId: p.nsId, name: p.name }))
}

module.exports = {
  parseProductName,
  getProductByNsId,
  getProductCatalog,
  PRODUCT_CATALOG,
  FG_ITEM_MAP,
}
