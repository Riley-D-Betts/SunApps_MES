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

// Catalog points at RAW assembly items — the blend tank produces type-2
// (separator output) or type-3 (raw FG) milk, both of which carry the
// "Raw " name prefix in NetSuite. Non-Raw entries (type-4 finished goods)
// are filtered out of fuzzy matches by parseProductName so a typo can't
// open a wrong WO on a BT (type-4 belongs to the surge tank flow).
//
// Type-2 entries (Raw Conv / Org / A2 fat-level + creams) cover the
// standardization-in-BT flow per BATCH_LIFECYCLE_PLAN.md §3. Item IDs
// match mesItemConfig.RAW_ITEMS.
const PRODUCT_CATALOG = [
  // ── Type-3: Raw FGs (blend-tank produced, surge-tank pasteurized) ────
  // Listed FIRST so brand-specific type-3 entries win ties against their
  // generic type-2 cousins. Example: "Raw Organic Milk 0% Lac Free" must
  // land on 8341 (type-3 lac-free), NOT 5482 (type-2 organic skim — a
  // separator cannot produce lac-free milk).
  // Each entry mirrors a surge tank canonical FG. Items not on the surge
  // canonical list (e.g. the old Raw Conventional Milk 1/2/3.25/3.5% line)
  // are intentionally absent.
  // Alexandre Eco Dairy — accept both "alexandre" and bare "a2" as brand
  // keys so "A2 Chocolate" / "A2 Whole" inputs match here without colliding
  // with the type-2 A2 entries (those have brand: 'a2' single, so inputs that
  // share modifiers like 'cream'/'skim' still pick the right type-2 row).
  { nsId: 8333, name: 'Raw Alexandre Eco Dairy A2/A2 Organic 4% Whole Milk', brand: ['alexandre', 'a2'], fatPct: 4, modifiers: ['organic', 'a2', 'whole'] },
  { nsId: 8371, name: 'Raw Alexandre Eco Dairy A2/A2 Organic Chocolate 4% Milk', brand: ['alexandre', 'a2'], fatPct: 4, modifiers: ['organic', 'a2', 'chocolate'] },

  // DFI (Diversified Foods Inc)
  { nsId: 8357, name: 'Raw DFI Holiday Nog', brand: 'dfi', fatPct: null, modifiers: ['nog'] },

  // DFI Marcel's specialty
  { nsId: 8356, name: "Raw DFI Marcel's Modern Pantry Heavy Cream", brand: 'marcels', fatPct: null, modifiers: ['heavycream'] },
  { nsId: 8355, name: "Raw DFI Marcel's Modern Pantry UHT Half & Half", brand: 'marcels', fatPct: null, modifiers: ['halfhalf'] },

  // DFI Marcels milk
  { nsId: 8354, name: 'Raw DFI Marcels 0% Milk', brand: 'marcels', fatPct: 0, modifiers: [] },
  { nsId: 8340, name: 'Raw DFI Marcels 1% Milk', brand: 'marcels', fatPct: 1, modifiers: [] },
  { nsId: 8339, name: 'Raw DFI Marcels 2% Milk', brand: 'marcels', fatPct: 2, modifiers: [] },
  { nsId: 8353, name: 'Raw DFI Marcels 3.25% Milk', brand: 'marcels', fatPct: 3.25, modifiers: ['whole'] },

  // ESL
  { nsId: 8350, name: 'Raw ESL Half & Half', brand: 'esl', fatPct: null, modifiers: ['halfhalf'] },
  { nsId: 8349, name: 'Raw ESL Heavy Whip Cream', brand: 'esl', fatPct: null, modifiers: ['heavycream'] },

  // Horizon Organic
  { nsId: 8335, name: 'Raw Horizon Organic 2% Milk', brand: 'horizon', fatPct: 2, modifiers: ['organic'] },
  { nsId: 8348, name: 'Raw Horizon Organic 3.25% Whole Milk', brand: 'horizon', fatPct: 3.25, modifiers: ['organic', 'whole'] },

  // Kirkland (Costco)
  { nsId: 8347, name: 'Raw Kirkland 1% Organic Milk', brand: 'kirkland', fatPct: 1, modifiers: ['organic'] },
  { nsId: 8346, name: 'Raw Kirkland 2% Organic Lac Free Milk', brand: 'kirkland', fatPct: 2, modifiers: ['organic', 'lacfree'] },
  { nsId: 8344, name: 'Raw Kirkland 2% Organic Milk', brand: 'kirkland', fatPct: 2, modifiers: ['organic'] },
  { nsId: 8343, name: 'Raw Kirkland Chocolate 2% Organic Milk - Aseptic', brand: 'kirkland', fatPct: 2, modifiers: ['organic', 'chocolate'] },
  { nsId: 8342, name: 'Raw Kirkland Organic Whole Milk', brand: 'kirkland', fatPct: null, modifiers: ['organic', 'whole'] },

  // American Farmer
  { nsId: 8364, name: 'Raw American Farmer Whole Milk', brand: 'americanfarmer', fatPct: 3.5, modifiers: ['whole'] },

  // Barista / Kinera (specialty)
  { nsId: 8363, name: 'Raw Barista Frappe Mix', brand: 'barista', fatPct: null, modifiers: ['frappe'] },
  { nsId: 8336, name: 'Raw Kinera Chocolate', brand: 'kinera', fatPct: null, modifiers: ['chocolate'] },
  { nsId: 8334, name: 'Raw Kinera Strawberry', brand: 'kinera', fatPct: null, modifiers: ['strawberry'] },

  // DG
  { nsId: 8352, name: 'Raw DG Half & Half', brand: 'dg', fatPct: null, modifiers: ['halfhalf'] },
  { nsId: 8351, name: 'Raw DG Heavy Cream', brand: 'dg', fatPct: null, modifiers: ['heavycream'] },

  // Organic misc
  { nsId: 8341, name: 'Raw Organic Milk 0% Lac Free', brand: 'organic', fatPct: 0, modifiers: ['organic', 'lacfree'] },

  // ── Type-2: Raw separated milk (separator outputs, also produced by
  // ── standardization-in-BT from other type-2 inputs) ─────────────────
  // Listed AFTER type-3 so brand-specific type-3 entries win catalog-order
  // ties. Item IDs match mesItemConfig.RAW_ITEMS.
  { nsId: 8163, name: 'Raw Conventional 0% - Skim',  brand: 'conventional', fatPct: 0,    modifiers: ['skim'] },
  { nsId: 5415, name: 'Raw Conventional 1%',          brand: 'conventional', fatPct: 1,    modifiers: [] },
  { nsId: 5412, name: 'Raw Conventional 2%',          brand: 'conventional', fatPct: 2,    modifiers: [] },
  { nsId: 5413, name: 'Raw Conventional 3.25%',       brand: 'conventional', fatPct: 3.25, modifiers: [] },
  { nsId: 5416, name: 'Raw Conventional 3.5%',        brand: 'conventional', fatPct: 3.5,  modifiers: [] },
  { nsId: 5480, name: 'Raw Conventional Cream',       brand: 'conventional', fatPct: 40,   modifiers: ['cream'] },
  { nsId: 5405, name: 'Raw Conventional UF Milk',     brand: 'conventional', fatPct: null, modifiers: ['uf'] },
  { nsId: 5482, name: 'Raw Organic 0%',               brand: 'organic',      fatPct: 0,    modifiers: ['organic', 'skim'] },
  { nsId: 5409, name: 'Raw Organic 1%',               brand: 'organic',      fatPct: 1,    modifiers: ['organic'] },
  { nsId: 5410, name: 'Raw Organic 2%',               brand: 'organic',      fatPct: 2,    modifiers: ['organic'] },
  { nsId: 5411, name: 'Raw Organic 3.25%',            brand: 'organic',      fatPct: 3.25, modifiers: ['organic'] },
  { nsId: 5401, name: 'Raw Organic 3.5%',             brand: 'organic',      fatPct: 3.5,  modifiers: ['organic'] },
  { nsId: 5483, name: 'Raw Organic Cream',            brand: 'organic',      fatPct: 40,   modifiers: ['organic', 'cream'] },
  { nsId: 5402, name: 'Raw Organic UF Milk',          brand: 'organic',      fatPct: null, modifiers: ['organic', 'uf'] },
  { nsId: 5484, name: 'Raw Organic A2 0%',            brand: 'a2',           fatPct: 0,    modifiers: ['organic', 'a2', 'skim'] },
  { nsId: 8366, name: 'Raw Organic A2 1%',            brand: 'a2',           fatPct: 1,    modifiers: ['organic', 'a2'] },
  { nsId: 8367, name: 'Raw Organic A2 2%',            brand: 'a2',           fatPct: 2,    modifiers: ['organic', 'a2'] },
  { nsId: 8368, name: 'Raw Organic A2 3.25%',         brand: 'a2',           fatPct: 3.25, modifiers: ['organic', 'a2'] },
  { nsId: 8369, name: 'Raw Organic A2 3.5%',          brand: 'a2',           fatPct: 3.5,  modifiers: ['organic', 'a2'] },
  { nsId: 8370, name: 'Raw Organic A2 4%',            brand: 'a2',           fatPct: 4,    modifiers: ['organic', 'a2'] },
  { nsId: 8365, name: 'Raw Organic A2 Cream',         brand: 'a2',           fatPct: 40,   modifiers: ['organic', 'a2', 'cream'] },
]

// ── Brand aliases ───────────────────────────────────────────────────────
// Maps common abbreviations/variations to canonical brand keys.

const BRAND_ALIASES = {
  // Marcels
  marcel: 'marcels', marcels: 'marcels', "marcel's": 'marcels', mp: 'marcels',
  // Kirkland
  kirkland: 'kirkland', ks: 'kirkland', costco: 'kirkland',
  // Conventional (type-2 + type-3 raw FG share this brand)
  conventional: 'conventional', conv: 'conventional',
  // Organic generic (covers both type-2 separator outputs and 'raw organic Nx%')
  organic: 'organic', org: 'organic',
  // A2 — distinct from organic so A2-specific catalog entries win for A2 inputs
  a2: 'a2', 'a2/a2': 'a2',
  // DFI
  dfi: 'dfi', diversified: 'dfi',
  // DG (also called DairyGold)
  dg: 'dg', dairygold: 'dg', 'dairy gold': 'dg',
  // ESL
  esl: 'esl',
  // Horizon
  horizon: 'horizon',
  // Alexandre
  alexandre: 'alexandre', alex: 'alexandre',
  // American Farmer
  'american farmer': 'americanfarmer', americanfarmer: 'americanfarmer',
  // Barista / Kinera
  barista: 'barista',
  kinera: 'kinera',
}

// ── Modifier patterns ───────────────────────────────────────────────────
// Each modifier has keyword patterns that trigger it.

const MODIFIER_PATTERNS = [
  { key: 'lacfree', patterns: ['lac free', 'lacfree', 'lactose free', 'lactosefree', 'lf'] },
  { key: 'organic', patterns: ['organic', 'org'] },
  { key: 'chocolate', patterns: ['chocolate', 'choc'] },
  { key: 'a2', patterns: ['a2', 'a2/a2'] },
  { key: 'whole', patterns: ['whole'] },
  { key: 'skim', patterns: ['skim', 'fat free', 'fatfree', '0%'] },
  { key: 'cream', patterns: ['cream'] },
  { key: 'uf', patterns: ['uf milk', 'uf'] },
  { key: 'halfhalf', patterns: ['half & half', 'half and half', 'halfhalf', 'half half', 'h&h', 'h/h', 'hh'] },
  { key: 'heavycream', patterns: ['heavy cream', 'heavycream', 'heavy whip', 'hwc'] },
  { key: 'nog', patterns: ['nog', 'eggnog'] },
  { key: 'frappe', patterns: ['frappe', 'frape'] },
  { key: 'strawberry', patterns: ['strawberry'] },
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

  // Brand must match (if we detected one). product.brand can be a single
  // string or an array of accepted brand keys — used so Alexandre entries
  // also match bare "a2" inputs without breaking type-2 A2 catalog matching.
  if (brand) {
    const productBrands = Array.isArray(product.brand) ? product.brand : [product.brand]
    if (!productBrands.includes(brand)) return 0
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

  // Brand required (mirrors surge tank parser). Without it, modifier/fat-pct
  // scoring picks the closest catalog entry regardless of intent. The blend
  // tank catalog is the canonical type-2 + type-3 list; only known brand
  // keywords resolve to it.
  if (!brand) {
    console.log(`[ProductParser] No brand recognized in "${input}" — returning null`)
    return null
  }

  // Score all products. Type-4 (non-Raw) names are filtered out — the blend
  // tank only produces type-2 / type-3 milk, all of which have "Raw " in their
  // NS name. The catalog itself is curated to Raw-only, but the filter is
  // belt-and-suspenders for any future non-Raw entries that sneak in.
  const scored = PRODUCT_CATALOG
    .filter(p => typeof p.name === 'string' && p.name.startsWith('Raw '))
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
