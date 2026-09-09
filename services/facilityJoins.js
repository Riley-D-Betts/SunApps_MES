/**
 * Facility map joins — how SVG ids on the SunApps facility map relate to what
 * this service sees (historian entity ids) and to each other (which drawn pipe
 * lights when which vessel is active).
 *
 * The browser owns the full registry (labels, zones, from/to) in
 * SunApps/src/components/facility-map/facilityMap.registry.js; this file is the
 * server-side subset needed to produce EntityState keyed by SVG id. Anything an
 * admin may need to change (which surge circle is ST81, which blend tank is
 * cocoa) is an ASSIGNMENT with defaults here and overrides persisted in
 * MesFacilitySettings (see facilitySettingsService).
 */

/** Admin-editable assignments: SVG id → historian id. */
const DEFAULT_ASSIGNMENTS = {
  surge: { surge1: 'ST81', surge2: 'ST82', surge3: 'ST83', surge4: 'ST84' },
  blend: { blendtank1: 'BlendTank1A', blendtank2: 'BlendTank1B', blendtank3: 'BlendTank2A', blendtank4: 'BlendTank2B', blendtank5: 'CocoaTank' },
}

/** Fixed joins (drawn once, not admin-editable). */
const SILOS = { MSilo1: 'silo1', MSilo2: 'silo2', MSilo3: 'silo3', MSilo4: 'silo4', MSilo5: 'silo5', CSilo1: 'cream1', CSilo2: 'cream2', CSilo3: 'cream3' }
const UHTS = { UHT1: { uht: 'uht1', balance: 'balance1', hom: 'hom1', homline: 'homline1', balanceline: 'balanceline1' }, UHT2: { uht: 'uht2', balance: 'balance2', hom: 'hom2', homline: 'homline2', balanceline: 'balanceline2' } }
const BLEND_LINES = { ML1: 'milktransfer1', ML2: 'milktransfer2', ML3: 'milktransfer3', ML4: 'milktransfer4', CL1: 'creamtransfer1', CL2: 'creamtransfer2' }
/** Drawn feed from the manifolds to blend tanks (only these exist in the drawing). */
const MANIFOLD_TO_TANK = { blendtank1: 'vctoblend1', blendtank2: 'vctoblend3' }
/** Blend-tank outlet stubs into the outlet matrix. */
const OUTLET_LINE = { blendtank1: 'blendline1', blendtank2: 'blendline2', blendtank3: 'blendline3', blendtank4: 'blendline4' }
/** UHT → surge routing cluster → tank, and tank → filler routing cluster. */
const SURGE_IN = { surge4: 'homsurgeline1', surge2: 'homsurgeline2', surge1: 'homsurgeline3', surge3: 'homsurgeline4' }
const SURGE_OUT = { surge4: 'surgeline1', surge2: 'surgeline2', surge3: 'surgeline3', surge1: 'surgeline4' }
/** Surge-tank select legs → drawn filler legs (paired). */
const SEL_LEG = { 1: 'filler1filler2line', 4: 'filler3filler4line', 3: 'filler5filler6line' }
const LEG_FILLERS = { filler1filler2line: ['line1filler', 'line2filler'], filler3filler4line: ['line3filler', 'line4filler'], filler5filler6line: ['line5filler', 'line6filler'] }
/** Separator lines (bidirectional: source runs IN, destinations run OUT). */
const SEP_LINE = { MSilo1: 'msepline1', MSilo2: 'msepline2', MSilo3: 'msepline3', MSilo4: 'msepline4', MSilo5: 'msepline5', CSilo1: 'csepline1', CSilo2: 'csepline2', CSilo3: 'csepline3' }
/** Silo → milk/cream header stubs (blend feed path). */
const SILO_TRANSLINE = { MSilo1: 'silo1transline', MSilo2: 'silo2transline', MSilo3: 'silo3transline', MSilo4: 'silo4transline', MSilo5: 'silo5transline', CSilo1: 'cream1transline', CSilo2: 'cream2transline', CSilo3: 'cream3transline' }

/**
 * Packaging line → drawn members (mirror of LINES in the browser registry; keep in
 * step). Lines 5 and 6 share one palletizer. Line status (scheduler) is painted
 * onto every member; Filler 1 keeps its own metered status.
 */
const LINE_MEMBERS = {
  1: ['line1filler', 'line1conveyor', 'line1case', 'line1pallet', 'line11helix', 'line12helix'],
  2: ['line2filler', 'line2conveyor', 'line2case', 'line2combiner', 'line2pallet'],
  3: ['line3filler', 'line3conveyor', 'line3helix', 'line3case', 'line3pallet'],
  4: ['line4filler', 'line4conveyor', 'line4helix', 'line4case', 'line4pallet'],
  5: ['line5filler', 'line5conveyor', 'line5caps', 'line5helix', 'line5case', 'line56pallet'],
  6: ['line6filler', 'line6conveyor', 'line6caps', 'line6helix', 'line6case', 'line56pallet'],
}
/**
 * Receiving bays (historian XFR objects) → the drawn hose from the truck bridge to the
 * receiving header. Both hoses leave `recbridge`; the two circles by the driver area
 * (rectank1/2) are CIP chemical tanks and never carry milk.
 */
const REC_BRIDGE = 'recbridge'
const REC_BAYS = { RecBay1: { line: 'recline1', label: 'Bay 1' }, RecBay2: { line: 'recline2', label: 'Bay 2' } }
/** Receiving header → raw silo lines. */
const REC_SILO_LINE = { MSilo1: 'recsiloline1', MSilo2: 'recsiloline2', MSilo3: 'recsiloline3', MSilo4: 'recsiloline4', MSilo5: 'recsiloline5' }
/** Drawn case packer / palletizer / filler per line (5 and 6 share the palletizer). */
const LINE_CASE = { 1: 'line1case', 2: 'line2case', 3: 'line3case', 4: 'line4case', 5: 'line5case', 6: 'line6case' }
const LINE_PALLET = { 1: 'line1pallet', 2: 'line2pallet', 3: 'line3pallet', 4: 'line4pallet', 5: 'line56pallet', 6: 'line56pallet' }
const LINE_FILLER = { 1: 'line1filler', 2: 'line2filler', 3: 'line3filler', 4: 'line4filler', 5: 'line5filler', 6: 'line6filler' }
/** ThermaRoute legs TR11–14 ↔ drawn filler legs (TR1n = Sel n; Sel 1 → fillers 1&2, Sel 4 → 3&4, Sel 3 → 5&6; TR12 has no drawn leg). */
const LEG_TR = { TR11: 'filler1filler2line', TR14: 'filler3filler4line', TR13: 'filler5filler6line' }
/** Which drawn surge leg feeds each line (legs are paired). */
const LINE_LEG = { 1: 'filler1filler2line', 2: 'filler1filler2line', 3: 'filler3filler4line', 4: 'filler3filler4line', 5: 'filler5filler6line', 6: 'filler5filler6line' }

/** "BT1A" / "BlendTank1A" / "bt 1a" → "BlendTank1A"; "TSTAT1" / "TSTAT-1" → "TSTAT1". */
function normalizeVessel(raw) {
  if (!raw || typeof raw !== 'string') return null
  const s = raw.trim().toLowerCase().replace(/[^a-z0-9]/g, '')
  const bt = s.replace(/^blendtank/, '').replace(/^bt/, '').replace(/^blend/, '').replace(/^tank/, '')
  if (/^[12][ab]$/.test(bt)) return `BlendTank${bt.toUpperCase()}`
  const ts = s.match(/^tstat(\d)$/)
  if (ts) return `TSTAT${ts[1]}`
  if (/^cocoa/.test(s)) return 'CocoaTank'
  const uht = s.match(/^uht(\d)$/)
  if (uht) return `UHT${uht[1]}`
  return raw.trim()
}

/** "MSilo3" / "RawMilkSilo3" / "msilo 3" → "MSilo3"; "CSilo2" / "CreamSilo2" → "CSilo2". */
function normalizeSilo(raw) {
  if (!raw || typeof raw !== 'string') return null
  const s = raw.toLowerCase().replace(/[^a-z0-9]/g, '')
  let m = s.match(/^(?:c|cream|crm)(?:silo)?(\d)$/) || s.match(/^creamsilo(\d)$/)
  if (m) return `CSilo${m[1]}`
  m = s.match(/^(?:m|raw|rawmilk|milk)?silo(\d)$/) || s.match(/^msilo(\d)$/)
  if (m) return `MSilo${m[1]}`
  return raw.trim()
}

/** Merge admin overrides over the defaults, keeping only known SVG ids. */
function mergeAssignments(overrides = {}) {
  const out = {}
  for (const group of Object.keys(DEFAULT_ASSIGNMENTS)) {
    out[group] = { ...DEFAULT_ASSIGNMENTS[group] }
    for (const [svgId, hid] of Object.entries(overrides[group] || {})) {
      if (svgId in out[group] && typeof hid === 'string' && hid.trim()) out[group][svgId] = hid.trim()
    }
  }
  return out
}

module.exports = {
  DEFAULT_ASSIGNMENTS, SILOS, UHTS, BLEND_LINES, MANIFOLD_TO_TANK, OUTLET_LINE, SURGE_IN, SURGE_OUT, SEL_LEG, LEG_FILLERS, SEP_LINE, SILO_TRANSLINE, LINE_MEMBERS, LINE_LEG, LINE_CASE, LINE_PALLET, LINE_FILLER, LEG_TR, REC_BRIDGE, REC_BAYS, REC_SILO_LINE,
  normalizeVessel, normalizeSilo, mergeAssignments,
}
