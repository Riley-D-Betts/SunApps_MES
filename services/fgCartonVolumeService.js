'use strict'

/**
 * Physical carton volume per finished-goods SKU (SD-722), from NetSuite.
 *
 * The BOM lb/case (bulk lb consumed ÷ cases on packaging WorkOrds) is a
 * costing number, not what is in the case: the Aug 2026 mass-balance audit
 * found it runs 10–20 % under the physical fill. Plant-balance and filler loss
 * need the PHYSICAL figure: carton mL × cartons per case × lb/gal.
 *
 * Source, per SKU:
 *   1. The carton component on its packaging WorkOrds (item.custitem6 = 3,
 *      "… 64 oz. (1893mL) Gable Top", "… 8 oz. (250mL) TPA Edge Carton").
 *      Cartons per case = carton qty ÷ cases on those WorkOrds (rounded).
 *   2. Fallback: the SKU name ("… 64 oz -4 Pack"), flagged `source: 'name'`.
 *
 * Fill vs carton size: a nominal size (8 / 16 / 32 / 64 oz) is filled to the
 * metric label (250 / 500 / 1000 / 1893 mL). Any other ounce figure is the
 * actual fill in a larger carton — "59 oz. (1893mL)" is 59 oz (1745 mL) in a
 * 64 oz gable top — so a non-nominal ounce figure wins over the mL label.
 * Density is the report's single milk estimate (mesItemConfig.LBS_PER_GAL);
 * cream is a little lighter, which the callers state as a caveat.
 */

const { suiteql, nsDate } = require('./fgShipmentService')
const itemConfig = require('./mesItemConfig')
const plantTime = require('../utils/plantTime')

const ML_PER_GAL = 3785.411784
const ML_PER_OZ = 29.5735
const NOMINAL_OZ_ML = { 8: 250, 16: 500, 32: 1000, 64: 1893 }
const CACHE_MS = 6 * 60 * 60 * 1000
const _cache = new Map() // sku → { at, value }

const round2 = v => Math.round(Number(v || 0) * 100) / 100

/** Fill in mL from a carton or SKU name, or null. */
function fillMlFromName(name) {
  const s = String(name || '')
  const oz = s.match(/(\d+(?:\.\d+)?)\s*(?:fl\.?\s*)?oz\b/i)
  const ml = s.match(/\(?\s*(\d{3,4})\s*ml\s*\)?/i)
  const ozN = oz ? Number(oz[1]) : null
  if (ozN != null && !NOMINAL_OZ_ML[ozN]) return round2(ozN * ML_PER_OZ)
  if (ml) return Number(ml[1])
  if (ozN != null) return NOMINAL_OZ_ML[ozN]
  return null
}

/** Cartons per case from a SKU name ("… -4 Pack", "12 pack", "18-Pack"), or null. */
function packFromName(name) {
  const m = String(name || '').match(/(\d+)\s*-?\s*(?:pack|pk|ct)\b/i)
  return m ? Number(m[1]) : null
}

function lbPerCase(ml, count) {
  return ml != null && count ? round2((ml * count / ML_PER_GAL) * itemConfig.LBS_PER_GAL) : null
}

/**
 * { [sku]: { sku, mL, cartonsPerCase, lbPerCase, galPerCarton, source, cartonName } }
 * for the given SKU ids (unknown SKUs come back with mL null). `names` is an
 * optional { sku: itemName } map used for the name fallback.
 */
async function getCartonVolumes(skus, names = {}) {
  const ids = [...new Set((skus || []).map(String).filter(s => /^\d+$/.test(s)))]
  const out = {}
  const missing = []
  for (const id of ids) {
    const hit = _cache.get(id)
    if (hit && Date.now() - hit.at < CACHE_MS && (hit.value.mL != null || !names[id])) out[id] = hit.value
    else missing.push(id)
  }
  if (missing.length) {
    const since = plantTime.addPlantDays(plantTime.plantDateString(), -365)
    const rows = []
    for (let i = 0; i < missing.length; i += 200) {
      const chunk = missing.slice(i, i + 200)
      rows.push(...await suiteql(`
        SELECT tl2.item AS sku, BUILTIN.DF(tl2.item) AS skuname, tl1.item AS carton, BUILTIN.DF(tl1.item) AS cartonname,
               SUM(ABS(tl1.quantity)) AS cartons, SUM(tl2.quantity) AS cases
        FROM transactionline tl1 JOIN transaction t ON t.id = tl1.transaction
        JOIN item ci ON ci.id = tl1.item AND ci.custitem6 = 3
        JOIN transactionline tl2 ON tl2.transaction = t.id AND tl2.quantity > 0 AND tl2.item != tl1.item
        WHERE t.type = 'WorkOrd' AND tl1.quantity < 0 AND tl2.item IN (${chunk.join(', ')})
          AND t.trandate >= ${nsDate(since)}
        GROUP BY tl2.item, BUILTIN.DF(tl2.item), tl1.item, BUILTIN.DF(tl1.item)`))
    }
    const best = {}
    for (const r of rows) {
      const sku = String(r.sku)
      const cases = Number(r.cases) || 0
      const ml = fillMlFromName(r.cartonname)
      if (!cases || ml == null) continue
      if (r.skuname && !names[sku]) names[sku] = r.skuname
      if (!best[sku] || cases > best[sku].cases) best[sku] = { cases, ml, count: Math.round(Number(r.cartons) / cases), cartonName: r.cartonname }
    }
    for (const id of missing) {
      let value
      const b = best[id]
      if (b && b.count > 0) {
        value = { sku: id, mL: b.ml, cartonsPerCase: b.count, source: 'carton component', cartonName: b.cartonName }
      } else {
        const ml = fillMlFromName(names[id])
        const count = packFromName(names[id])
        value = { sku: id, mL: ml, cartonsPerCase: ml != null ? count : null, source: ml != null && count ? 'name' : 'unknown', cartonName: null }
      }
      value.lbPerCase = lbPerCase(value.mL, value.cartonsPerCase)
      value.galPerCarton = value.mL != null ? value.mL / ML_PER_GAL : null
      _cache.set(id, { at: Date.now(), value })
      out[id] = value
    }
  }
  return out
}

function clearCache() { _cache.clear() }

module.exports = { getCartonVolumes, fillMlFromName, packFromName, lbPerCase, ML_PER_GAL, clearCache }
