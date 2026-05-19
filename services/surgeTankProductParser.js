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
 *
 * Flip MES_PARSER_STRICT_MODE on (config/index.js) once FG_ITEM_MAP is fully
 * populated; that disables the fuzzy branch and forces unrecognized inputs to
 * pending_ns rather than silently scoring against the wrong item.
 */

const config = require('../config')

// ── Exact-match table (AVEVA standardized values) ───────────────────────
// Add entries as the standardized list lands. Keys are case-sensitive and
// exactly as the historian writes them.
const FG_ITEM_MAP = {
  // (Populate as the standardized list arrives.)
}

// ── Fuzzy catalog (legacy free-text path) ───────────────────────────────
// Surge tank end products only — pasteurized type-4 FGs. This is the
// canonical list per BATCH_LIFECYCLE_PLAN.md and the source description.
// Anything not on this list is NOT made on a surge tank; the parser
// returns null so the batch lands on pending_ns rather than being
// silently scored onto a wrong item.
const PRODUCT_CATALOG = [
  // Alexandre Eco Dairy
  { nsId: 3278, name: 'Alexandre Eco Dairy A2/A2 Organic 4% Whole Milk',         brand: 'alexandre',      fatPct: 4,    modifiers: ['organic', 'a2', 'whole'] },
  { nsId: 4899, name: 'Alexandre Eco Dairy A2/A2 Organic Chocolate 4% Milk',     brand: 'alexandre',      fatPct: 4,    modifiers: ['organic', 'a2', 'chocolate'] },

  // American Farmer
  { nsId: 5510, name: 'American Farmer Whole Milk',                              brand: 'americanfarmer', fatPct: 3.5,  modifiers: ['whole'] },

  // Barista
  { nsId: 5314, name: 'Barista Frappe Mix',                                      brand: 'barista',        fatPct: null, modifiers: ['frappe'] },

  // DFI
  { nsId: 3395, name: 'DFI Holiday Nog',                                         brand: 'dfi',            fatPct: null, modifiers: ['nog'] },

  // DFI Marcel's specialty
  { nsId: 3493, name: "DFI Marcel's Modern Pantry Heavy Cream",                  brand: 'marcels',        fatPct: null, modifiers: ['heavycream'] },
  { nsId: 2940, name: "DFI Marcel's Modern Pantry UHT Half & Half",              brand: 'marcels',        fatPct: null, modifiers: ['halfhalf'] },

  // DFI Marcels milk
  { nsId: 3222, name: 'DFI Marcels 0% Milk',                                     brand: 'marcels',        fatPct: 0,    modifiers: [] },
  { nsId: 3228, name: 'DFI Marcels 1% Milk',                                     brand: 'marcels',        fatPct: 1,    modifiers: [] },
  { nsId: 4012, name: 'DFI Marcels 2% Milk',                                     brand: 'marcels',        fatPct: 2,    modifiers: [] },
  { nsId: 3236, name: 'DFI Marcels 3.25% Milk',                                  brand: 'marcels',        fatPct: 3.25, modifiers: ['whole'] },

  // DG
  { nsId: 2889, name: 'DG Half & Half',                                          brand: 'dg',             fatPct: null, modifiers: ['halfhalf'] },
  { nsId: 2790, name: 'DG Heavy Cream',                                          brand: 'dg',             fatPct: null, modifiers: ['heavycream'] },

  // ESL
  { nsId: 3900, name: 'ESL Half & Half',                                         brand: 'esl',            fatPct: null, modifiers: ['halfhalf'] },
  { nsId: 3905, name: 'ESL Heavy Whip Cream',                                    brand: 'esl',            fatPct: null, modifiers: ['heavycream'] },

  // Horizon Organic
  { nsId: 5911, name: 'Horizon Organic 2% Milk',                                 brand: 'horizon',        fatPct: 2,    modifiers: ['organic'] },
  { nsId: 5907, name: 'Horizon Organic 3.25% Whole Milk',                        brand: 'horizon',        fatPct: 3.25, modifiers: ['organic', 'whole'] },

  // Kinera
  { nsId: 5317, name: 'Kinera Chocolate',                                        brand: 'kinera',         fatPct: null, modifiers: ['chocolate'] },
  { nsId: 5003, name: 'Kinera Strawberry',                                       brand: 'kinera',         fatPct: null, modifiers: ['strawberry'] },

  // Kirkland (Costco)
  { nsId: 4495, name: 'Kirkland 1% Organic Milk',                                brand: 'kirkland',       fatPct: 1,    modifiers: ['organic'] },
  { nsId: 4501, name: 'Kirkland 2% Organic Lac Free Milk',                       brand: 'kirkland',       fatPct: 2,    modifiers: ['organic', 'lacfree'] },
  // NOTE: "Kirkland 2% Organic Lactose Free" (NS 7462) is the obsolete SKU
  // and intentionally NOT in the catalog. Use 4501 (Lac Free Milk) instead.
  { nsId: 4498, name: 'Kirkland 2% Organic Milk',                                brand: 'kirkland',       fatPct: 2,    modifiers: ['organic'] },
  { nsId: 4548, name: 'Kirkland Chocolate 2% Organic Milk - Aseptic',            brand: 'kirkland',       fatPct: 2,    modifiers: ['organic', 'chocolate'] },
  { nsId: 6420, name: 'Kirkland Organic Whole Milk',                             brand: 'kirkland',       fatPct: null, modifiers: ['organic', 'whole'] },

  // Organic misc
  { nsId: 3926, name: 'Organic Milk 0% Lac Free',                                brand: 'organic',        fatPct: 0,    modifiers: ['organic', 'lacfree'] },
]

const BRAND_ALIASES = {
  // Alexandre
  alexandre: 'alexandre', alex: 'alexandre',
  // American Farmer
  'american farmer': 'americanfarmer', americanfarmer: 'americanfarmer',
  // Barista
  barista: 'barista',
  // DFI (Holiday Nog only — Marcel's is its own brand below)
  dfi: 'dfi',
  // DFI Marcel's
  marcel: 'marcels', marcels: 'marcels', "marcel's": 'marcels', mp: 'marcels',
  // DG (also called DairyGold)
  dg: 'dg', dairygold: 'dg', 'dairy gold': 'dg',
  // ESL
  esl: 'esl',
  // Horizon
  horizon: 'horizon',
  // Kinera
  kinera: 'kinera',
  // Kirkland (Costco)
  kirkland: 'kirkland', ks: 'kirkland', costco: 'kirkland',
  // Organic (catch-all for "Organic Milk 0% Lac Free")
  organic: 'organic',
}

const MODIFIER_PATTERNS = [
  { key: 'lacfree', patterns: ['lac free', 'lacfree', 'lactose free', 'lactosefree', 'lf'] },
  { key: 'organic', patterns: ['organic', 'org'] },
  { key: 'chocolate', patterns: ['chocolate', 'choc'] },
  { key: 'a2', patterns: ['a2', 'a2/a2'] },
  { key: 'whole', patterns: ['whole'] },
  { key: 'halfhalf', patterns: ['half & half', 'half and half', 'halfhalf', 'half half', 'h&h', 'h/h', 'hh'] },
  { key: 'heavycream', patterns: ['heavy cream', 'heavycream', 'heavy whip', 'hwc'] },
  { key: 'nog', patterns: ['nog', 'eggnog'] },
  { key: 'frappe', patterns: ['frappe', 'frape'] },
  { key: 'strawberry', patterns: ['strawberry'] },
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

  if (config.MES_PARSER_STRICT_MODE) {
    console.warn(`[SurgeTankParser] STRICT mode: no FG_ITEM_MAP entry for "${input}" — returning null`)
    return null
  }

  const normalized = normalize(input)
  const brand = extractBrand(normalized)
  const fatPct = extractFatPct(normalized)
  const modifiers = extractModifiers(normalized)
  const parsed = { normalized, brand, fatPct, modifiers }

  // Brand required. Without it, modifier/fat-pct scoring picks the
  // closest catalog entry regardless of intent ("Conv 2%" was leaking
  // to "DFI Marcels 2% Milk"). The surge tank catalog is the canonical
  // type-4 list and only known brand keywords resolve to it.
  if (!brand) {
    console.log(`[SurgeTankParser] No brand recognized in "${input}" — returning null`)
    return null
  }

  // Surge tank produces type-4 finished goods only — no "Raw " items. The
  // catalog is curated to FG entries; the filter is belt-and-suspenders for
  // any future Raw entry that sneaks in.
  const scored = PRODUCT_CATALOG
    .filter(p => typeof p.name === 'string' && !p.name.startsWith('Raw '))
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

  console.warn(`[SurgeTankParser] FUZZY fallback used for "${input}" — populate FG_ITEM_MAP to phase this out`)
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
