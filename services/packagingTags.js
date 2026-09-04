/**
 * Packaging line tags the facility map reads (see the Sep 2026 "Packaging Line
 * Tag Audit"). Only tags that actually publish with good OPC quality are
 * listed; the Wonderware job/AUC/OCO objects, accumulators, cappers, the
 * sleever and Pall6 were never fed and are deliberately left out.
 *
 * Lines 5 and 6 share one palletizer (Pall5) and one counting case packer
 * (CsPckr5 / CasePacker5_CaseCounts) — the job attributes their movement to
 * whichever filler has product flowing.
 */
const PALLETIZERS = { 1: 'Pack_Pack1_Pall1_IO', 3: 'Pack_Pack3_Pall3_IO', 4: 'Pack_Pack4_Pall4_IO', 5: 'Pack_Pack5_Pall5_IO' }
const CASE_PACKERS = { 1: 'Pack_Pack1_CsPckr1_IO', 3: 'Pack_Pack3_CsPckr3_IO', 4: 'Pack_Pack4_CsPckr4_IO', 5: 'Pack_Pack5_CsPckr5_IO' }
/** Historian unit labels as published; 3/4 say l/h and 5/6 say l/min (3/4's label is suspect — see README). */
const FILLER_FLOW = { 3: { fqn: 'Filler3.ProductFlowRate', unit: 'l/h' }, 4: { fqn: 'Filler4.ProductFlowRate', unit: 'l/h' }, 5: { fqn: 'Filler5.ProductFlowRate', unit: 'l/min' }, 6: { fqn: 'Filler6.ProductFlowRate', unit: 'l/min' } }
const CASES_TODAY_56 = 'CasePacker5_CaseCounts'
const FILLER1 = {
  lane1Good: 'Filler1.L1_Carton_Count_Good',
  lane2Good: 'Filler1.L2_Carton_Count_Good',
  runMode: 'Filler1.CI_To_Proc.RunMode',
  cipRunning: 'Filler1.CI_To_Proc.CIPRunning',
  sipRunning: 'Filler1.CI_To_Proc.SIPRunning',
}
const STERILE_FILLERS = { 1: 'ThermaRoute.Filler1_Sterile', 2: 'ThermaRoute.Filler2_Sterile', 3: 'ThermaRoute.Filler3_Sterile', 4: 'ThermaRoute.Filler4_Sterile', 5: 'ThermaRoute.Filler5_Sterile' }
const STERILE_LEGS = { TR11: 'ThermaRoute.TR11_Sterile', TR12: 'ThermaRoute.TR12_Sterile', TR13: 'ThermaRoute.TR13_Sterile', TR14: 'ThermaRoute.TR14_Sterile' }

/** Every FQN the poll reads, so providers and tests agree on the list. */
function allFqns() {
  const out = []
  for (const b of Object.values(PALLETIZERS)) out.push(`${b}.Day_Counts`, `${b}.UCO.Mcounts#.0`, `${b}.UCO.MUtilState`, `${b}.UCO.MUtilReasonCd`, `${b}.Pallet_Complete`)
  for (const b of Object.values(CASE_PACKERS)) out.push(`${b}.UCO.Mcounts#.0`, `${b}.UCO.MUtilState`, `${b}.UCO.MUtilReasonCd`, `${b}.RMS.RecipeName_Active`)
  out.push(CASES_TODAY_56)
  for (const f of Object.values(FILLER_FLOW)) out.push(f.fqn)
  out.push(...Object.values(FILLER1), ...Object.values(STERILE_FILLERS), ...Object.values(STERILE_LEGS))
  return out
}

module.exports = { PALLETIZERS, CASE_PACKERS, FILLER_FLOW, CASES_TODAY_56, FILLER1, STERILE_FILLERS, STERILE_LEGS, allFqns }
