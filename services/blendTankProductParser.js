/**
 * Blend Tank Product Parser
 * Resolves blend-tank product strings to NetSuite RAW FG assembly items.
 *
 * Two lookup paths in order:
 *   1. Exact match against RAW_FG_ITEM_MAP (for the standardized AVEVA select-
 *      tag values that are coming "soon"). When MES_PARSER_STRICT_MODE is set,
 *      this is the only path — unmatched inputs return null.
 *   2. Fuzzy match against PRODUCT_CATALOG (legacy free-text path — same
 *      brand/fat%/modifiers scoring used historically). Only runs when strict
 *      mode is off; logs at warn level so we can audit usage.
 */

const config = require('../config')

// ── Exact-match table (AVEVA standardized values) ───────────────────────
// Add entries as the standardized list lands. Keys are case-sensitive and
// exactly as the historian writes them; values are raw FG NS item IDs.
const RAW_FG_ITEM_MAP = {
  // (Populate as the standardized list arrives.)
}

// ── Product catalog ─────────────────────────────────────────────────────
// Each entry: { nsId, name, brand, fatPct, modifiers[] }
// brand/fatPct/modifiers are used for matching, nsId for NS work order creation.

// Catalog points at RAW assembly items — the blend tank produces the raw,
// pre-UHT version of each consumer product. Entries with nsId: null have no
// raw item in NS yet; matches against them will fall to pending_ns.
const PRODUCT_CATALOG = [
  // Alexandre Eco Dairy
  { nsId: 8333, name: 'Raw Alexandre Eco Dairy A2/A2 Organic 4% Whole Milk', brand: 'alexandre', fatPct: 4, modifiers: ['organic', 'a2', 'whole'] },
  { nsId: null, name: 'Alexandre Eco Dairy A2/A2 Organic Chocolate 4% Milk', brand: 'alexandre', fatPct: 4, modifiers: ['organic', 'a2', 'chocolate'] },

  // Conventional Milk
  { nsId: 8362, name: 'Raw Conventional Milk 1%', brand: 'conventional', fatPct: 1, modifiers: [] },
  { nsId: null, name: 'Conventional Milk 1% LAC Free', brand: 'conventional', fatPct: 1, modifiers: ['lacfree'] },
  { nsId: 8361, name: 'Raw Conventional Milk 2%', brand: 'conventional', fatPct: 2, modifiers: [] },
  { nsId: null, name: 'Conventional Milk 2% LAC Free', brand: 'conventional', fatPct: 2, modifiers: ['lacfree'] },
  { nsId: 8360, name: 'Raw Conventional Milk 3.25%', brand: 'conventional', fatPct: 3.25, modifiers: [] },
  { nsId: null, name: 'Conventional Milk 3.25% Lac Free', brand: 'conventional', fatPct: 3.25, modifiers: ['lacfree'] },
  { nsId: 8359, name: 'Raw Conventional Milk 3.5%', brand: 'conventional', fatPct: 3.5, modifiers: [] },
  { nsId: 8358, name: 'Raw Conventional Whole Milk 3.25% (No Vitamins)', brand: 'conventional', fatPct: 3.25, modifiers: ['novitamins'] },

  // DFI (Diversified Foods Inc) — general
  { nsId: null, name: 'DFI 2% Milk', brand: 'dfi', fatPct: 2, modifiers: [] },
  { nsId: 8357, name: 'Raw DFI Holiday Nog', brand: 'dfi', fatPct: null, modifiers: ['nog'] },

  // DFI Marcel's specialty
  { nsId: null, name: "DFI Marcel's 1% Lac Free", brand: 'marcels', fatPct: 1, modifiers: ['lacfree'] },
  { nsId: 8356, name: "Raw DFI Marcel's Modern Pantry Heavy Cream", brand: 'marcels', fatPct: null, modifiers: ['heavycream'] },
  { nsId: null, name: "DFI Marcel's Modern Pantry Light Whip Cream UHT", brand: 'marcels', fatPct: null, modifiers: ['lightcream'] },
  { nsId: 8355, name: "Raw DFI Marcel's Modern Pantry UHT Half & Half", brand: 'marcels', fatPct: null, modifiers: ['halfhalf'] },

  // DFI Marcels milk
  { nsId: 8354, name: 'Raw DFI Marcels 0% Milk', brand: 'marcels', fatPct: 0, modifiers: [] },
  { nsId: 8340, name: 'Raw DFI Marcels 1% Milk', brand: 'marcels', fatPct: 1, modifiers: [] },
  { nsId: 8339, name: 'Raw DFI Marcels 2% Milk', brand: 'marcels', fatPct: 2, modifiers: [] },
  { nsId: 8353, name: 'Raw DFI Marcels 3.25% Milk', brand: 'marcels', fatPct: 3.25, modifiers: ['whole'] },

  // DFI Swan River
  { nsId: null, name: 'DFI: Swan River Vanilla Sweet Cream (F)', brand: 'swanriver', fatPct: null, modifiers: ['sweetcream'] },

  // ESL
  { nsId: 8350, name: 'Raw ESL Half & Half', brand: 'esl', fatPct: null, modifiers: ['halfhalf'] },
  { nsId: 8349, name: 'Raw ESL Heavy Whip Cream', brand: 'esl', fatPct: null, modifiers: ['heavycream'] },

  // Horizon Organic
  { nsId: 8335, name: 'Raw Horizon Organic 2% Milk', brand: 'horizon', fatPct: 2, modifiers: ['organic'] },
  { nsId: 8348, name: 'Raw Horizon Organic 3.25% Whole Milk', brand: 'horizon', fatPct: 3.25, modifiers: ['organic', 'whole'] },
  { nsId: null, name: 'Horizon Organic Half & Half', brand: 'horizon', fatPct: null, modifiers: ['organic', 'halfhalf'] },

  // Kirkland (Costco)
  { nsId: 8347, name: 'Raw Kirkland 1% Organic Milk', brand: 'kirkland', fatPct: 1, modifiers: ['organic'] },
  { nsId: 8346, name: 'Raw Kirkland 2% Organic Lac Free Milk', brand: 'kirkland', fatPct: 2, modifiers: ['organic', 'lacfree'] },
  { nsId: 8344, name: 'Raw Kirkland 2% Organic Milk', brand: 'kirkland', fatPct: 2, modifiers: ['organic'] },
  { nsId: null, name: 'Kirkland A2 Organic Whole Milk', brand: 'kirkland', fatPct: null, modifiers: ['organic', 'a2', 'whole'] },
  { nsId: 8343, name: 'Raw Kirkland Chocolate 2% Organic Milk - Aseptic', brand: 'kirkland', fatPct: 2, modifiers: ['organic', 'chocolate'] },
  { nsId: 8342, name: 'Raw Kirkland Organic Whole Milk', brand: 'kirkland', fatPct: null, modifiers: ['organic', 'whole'] },

  // American Farmer / Blue Valley / Golden Flow
  { nsId: 8364, name: 'Raw American Farmer Whole Milk', brand: 'americanfarmer', fatPct: 3.5, modifiers: ['whole'] },
  { nsId: null, name: 'Blue Valley Whole Milk', brand: 'bluevalley', fatPct: 3.3, modifiers: ['whole'] },
  { nsId: null, name: 'Golden Flow', brand: 'goldenflow', fatPct: 1, modifiers: [] },

  // Barista / Kinera / Nurri (specialty)
  { nsId: 8363, name: 'Raw Barista Frappe Mix', brand: 'barista', fatPct: null, modifiers: ['frappe'] },
  { nsId: 8336, name: 'Raw Kinera Chocolate', brand: 'kinera', fatPct: null, modifiers: ['chocolate'] },
  { nsId: 8334, name: 'Raw Kinera Strawberry', brand: 'kinera', fatPct: null, modifiers: ['strawberry'] },
  { nsId: null, name: 'Nurri - Chocolate', brand: 'nurri', fatPct: null, modifiers: ['chocolate'] },
  { nsId: null, name: 'Nurri - Salted Caramel', brand: 'nurri', fatPct: null, modifiers: ['caramel'] },
  { nsId: null, name: 'Nurri - Sweet Cream', brand: 'nurri', fatPct: null, modifiers: ['sweetcream'] },

  // DairyPure
  { nsId: null, name: 'DairyPure 2% - 8oz', brand: 'dairypure', fatPct: 2, modifiers: [] },
  { nsId: null, name: 'DairyPure Half & Half - 8oz', brand: 'dairypure', fatPct: null, modifiers: ['halfhalf'] },

  // DG
  { nsId: null, name: 'DG Chocolate Milk 2%', brand: 'dg', fatPct: 2, modifiers: ['chocolate'] },
  { nsId: 8352, name: 'Raw DG Half & Half', brand: 'dg', fatPct: null, modifiers: ['halfhalf'] },
  { nsId: 8351, name: 'Raw DG Heavy Cream', brand: 'dg', fatPct: null, modifiers: ['heavycream'] },
  { nsId: null, name: 'DG Light Cream', brand: 'dg', fatPct: null, modifiers: ['lightcream'] },

  // Dutch Brothers
  { nsId: null, name: 'Dutch - Annihilator (Macadamia)', brand: 'dutch', fatPct: null, modifiers: ['macadamia'] },
  { nsId: null, name: 'Dutch - Caramelizer (Choc Caramel)', brand: 'dutch', fatPct: null, modifiers: ['chocolate', 'caramel'] },
  { nsId: null, name: 'Dutch - Golden Eagle (Vanilla Caramel)', brand: 'dutch', fatPct: null, modifiers: ['caramel'] },

  // HWC Trial
  { nsId: null, name: 'HWC Aseptic Trial', brand: 'hwc', fatPct: null, modifiers: ['heavycream'] },

  // Organic misc
  { nsId: null, name: 'Organic 2% Sample', brand: 'organic', fatPct: 2, modifiers: ['organic'] },
  { nsId: 8341, name: 'Raw Organic Milk 0% Lac Free', brand: 'organic', fatPct: 0, modifiers: ['organic', 'lacfree'] },
  { nsId: null, name: 'Tres Monjitas 2% Organic', brand: 'tresmonjitas', fatPct: 2, modifiers: ['organic'] },

  // Trials (may not match — that's OK, they'll go to pending_ns)
  { nsId: null, name: 'Trial - Sweet Cream', brand: 'trial', fatPct: null, modifiers: ['sweetcream'] },
  { nsId: null, name: 'Water Trials', brand: 'water', fatPct: null, modifiers: [] },
]

// ── Brand aliases ───────────────────────────────────────────────────────
// Maps common abbreviations/variations to canonical brand keys.

const BRAND_ALIASES = {
  // Marcels
  marcel: 'marcels', marcels: 'marcels', "marcel's": 'marcels', mp: 'marcels',
  // Kirkland
  kirkland: 'kirkland', ks: 'kirkland', costco: 'kirkland',
  // Conventional
  conventional: 'conventional', conv: 'conventional',
  // DFI
  dfi: 'dfi', diversified: 'dfi',
  // DG (Dollar General / DairyGold)
  dg: 'dg',
  // ESL
  esl: 'esl',
  // Horizon
  horizon: 'horizon',
  // Alexandre
  alexandre: 'alexandre', alex: 'alexandre',
  // Swan River
  'swan river': 'swanriver', swanriver: 'swanriver', starbucks: 'swanriver',
  // American Farmer / Blue Valley / Golden Flow
  'american farmer': 'americanfarmer', americanfarmer: 'americanfarmer',
  'blue valley': 'bluevalley', bluevalley: 'bluevalley',
  'golden flow': 'goldenflow', goldenflow: 'goldenflow',
  // Barista / Kinera / Nurri
  barista: 'barista',
  kinera: 'kinera',
  nurri: 'nurri',
  // DairyPure
  dairypure: 'dairypure', 'dairy pure': 'dairypure',
  // Dutch Brothers
  dutch: 'dutch', 'dutch bros': 'dutch',
  // HWC
  hwc: 'hwc',
  // Organic (generic)
  organic: 'organic',
  // Tres Monjitas
  'tres monjitas': 'tresmonjitas', tresmonjitas: 'tresmonjitas',
  // Trial / Water (these won't match well — intentional)
  trial: 'trial',
  water: 'water',
}

// ── Modifier patterns ───────────────────────────────────────────────────
// Each modifier has keyword patterns that trigger it.

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

// ── Parser ──────────────────────────────────────────────────────────────

/**
 * Normalize operator input for matching.
 * - Lowercase
 * - Remove apostrophes
 * - Collapse whitespace
 * - Trim
 */
function normalize(input) {
  return input
    .toLowerCase()
    .replace(/[''`]/g, '')
    .replace(/\s*\(\d+\)\s*$/, '') // Strip Atlas back-to-back suffix e.g. "(2)"
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract fat percentage from input string.
 * Handles: "1%", "2%", "3.25%", "0%", "1 %", and "whole" (→ null, matched as modifier)
 * @returns {number|null}
 */
function extractFatPct(input) {
  // Match patterns like "1%", "2 %", "3.25%", "0.5%"
  const match = input.match(/(\d+(?:\.\d+)?)\s*%/)
  if (match) return parseFloat(match[1])
  return null
}

/**
 * Extract brand from normalized input.
 * Tries multi-word aliases first, then single-word.
 * @returns {string|null}
 */
function extractBrand(input) {
  // Try multi-word aliases first (e.g., "swan river")
  const multiWordAliases = Object.keys(BRAND_ALIASES).filter(a => a.includes(' '))
  for (const alias of multiWordAliases) {
    if (input.includes(alias)) return BRAND_ALIASES[alias]
  }

  // Try single-word aliases
  const words = input.split(/[\s,.\-\/]+/)
  for (const word of words) {
    if (BRAND_ALIASES[word]) return BRAND_ALIASES[word]
  }

  return null
}

/**
 * Extract modifiers from normalized input.
 * @returns {string[]}
 */
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

/**
 * Score a product against extracted criteria.
 * Higher score = better match. Returns 0 for non-match.
 *
 * Scoring:
 *  - Brand match: +10 (required — 0 score if brand doesn't match)
 *  - Fat % match: +5
 *  - Each matching modifier: +3
 *  - Each mismatching modifier (in product but not input): -1
 */
function scoreProduct(product, brand, fatPct, modifiers) {
  let score = 0

  // Brand must match (if we detected one)
  if (brand) {
    if (product.brand !== brand) return 0
    score += 10
  }

  // Fat % match
  if (fatPct !== null && product.fatPct !== null) {
    if (product.fatPct === fatPct) score += 5
    else return 0 // Fat % mismatch is a hard fail
  } else if (fatPct !== null && product.fatPct === null) {
    // Input has fat %, product doesn't (e.g., "half and half" products) — slight penalty
    score -= 1
  } else if (fatPct === null && product.fatPct !== null) {
    // No fat % in input — not a hard fail, but less specific
    score -= 1
  }

  // Modifier scoring
  for (const mod of modifiers) {
    if (product.modifiers.includes(mod)) {
      score += 3
    }
  }

  // Penalize products that have modifiers the input doesn't mention
  for (const mod of product.modifiers) {
    if (!modifiers.includes(mod)) {
      score -= 1
    }
  }

  return score
}

/**
 * Parse an operator-entered product name and match to a NS assembly item.
 *
 * @param {string} input - Raw operator input (e.g., "Marcels 1%", "KS 2% org")
 * @returns {{ nsId: number, name: string, confidence: string, score: number, parsed: object } | null}
 */
function parseProductName(input) {
  if (!input || typeof input !== 'string') return null

  if (RAW_FG_ITEM_MAP[input] != null) {
    const nsId = RAW_FG_ITEM_MAP[input]
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

  if (config.MES_PARSER_STRICT_MODE) {
    console.warn(`[ProductParser] STRICT mode: no RAW_FG_ITEM_MAP entry for "${input}" — returning null`)
    return null
  }

  const normalized = normalize(input)
  const brand = extractBrand(normalized)
  const fatPct = extractFatPct(normalized)
  const modifiers = extractModifiers(normalized)

  const parsed = { normalized, brand, fatPct, modifiers }

  // Score all products
  const scored = PRODUCT_CATALOG
    .map(p => ({ ...p, score: scoreProduct(p, brand, fatPct, modifiers) }))
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)

  if (scored.length === 0) {
    console.log(`[ProductParser] No match for "${input}" → parsed:`, parsed)
    return null
  }

  console.warn(`[ProductParser] FUZZY fallback used for "${input}" — populate RAW_FG_ITEM_MAP to phase this out`)

  const best = scored[0]
  const confidence = best.score >= 15 ? 'high' : best.score >= 10 ? 'medium' : 'low'

  // Check for ambiguous match (top two scores are equal)
  const ambiguous = scored.length > 1 && scored[0].score === scored[1].score

  console.log(`[ProductParser] "${input}" → ${best.name} (NS ${best.nsId}, score=${best.score}, confidence=${confidence}${ambiguous ? ', AMBIGUOUS' : ''})`)
  if (scored.length > 1) {
    console.log(`[ProductParser]   Runner-up: ${scored[1].name} (NS ${scored[1].nsId}, score=${scored[1].score})`)
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

/**
 * Get a product directly by NS internal ID (for manual override / UI selection).
 */
function getProductByNsId(nsId) {
  return PRODUCT_CATALOG.find(p => p.nsId === nsId) || null
}

/**
 * Get the full product catalog (for UI dropdowns).
 */
function getProductCatalog() {
  return PRODUCT_CATALOG.map(p => ({ nsId: p.nsId, name: p.name }))
}

module.exports = {
  parseProductName,
  getProductByNsId,
  getProductCatalog,
  PRODUCT_CATALOG,
  RAW_FG_ITEM_MAP,
}
