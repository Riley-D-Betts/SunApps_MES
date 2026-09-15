/**
 * Reset-aware separator totalizer math (SD-722).
 *
 * The three separator totalizers — Product.SepFeedTotal (lb) and
 * Ing_Sep_CMSep1_HIST.Cream_/Skim_Flow_Totalized (gal) — are PER-TRANSFER
 * counters: SCADA zeroes all three when it starts a new transfer, and they
 * hold the previous transfer's final total until then. The reset lands AFTER
 * the SEPSTAT.FEEDPERMIT rising edge MES opens on. Prod evidence (AnalogSummary
 * @10 s, scripts/recomputeSeparationVolumes.js reproduces it):
 *
 *   batch  reset vs MES open   pre-reset (held) totals at open
 *   61     +66 s               cream 18,794 lb / skim 235,822 lb
 *   169    +538 s              feed 250,651 / cream 22,923 / skim 234,504
 *   172    +347 s              feed 468,635 / cream 55,839 / skim 402,886
 *   173    +68 s               feed 244,174 / cream 21,337 / skim 229,936
 *   175    +5 s                feed 172,066 / cream 21,866 / skim 155,382
 *
 * The old code baselined at the edge (= the previous transfer's totals) and
 * then computed `current − baseline`, which is only right while current is
 * still below the stale baseline. Once the new transfer out-ran the previous
 * one's total the subtraction silently under-counted (batch 61: cream 9,710 vs
 * real 28,503 lb, skim 82,545 vs 318,367 → phantom +253k lb "waste").
 *
 * Model used here: a batch's volume is the sum of the totalizer's rises over
 * its window. Each reading is compared to the previous one; a big drop is a
 * reset. The FIRST reset a batch sees is normally the new transfer's own start:
 * count from 0 and DISCARD the pre-reset value when either
 *   - it lands within START_RESET_GRACE_MS of the MES open, or
 *   - the counter never rose while the batch was open (it was frozen at the
 *     previous transfer's held total — batches 54/146 reset 23–39 min after
 *     open, and batch 146's pre-reset reading was exactly batch 145's total).
 * Any other reset (a second SCADA transfer inside one MES batch, e.g. a short
 * permit drop that didn't close the batch, or the next transfer starting just
 * before a late close) KEEPS the volume so far and adds the post-reset rise,
 * so measured milk is never lost (batch 6: 437k lb then a reset at close).
 *
 * State is expressed through the persisted baseline so no new columns are
 * needed: volume = reading − baseline always holds, so "keep V and add the
 * post-reset rise from 0" is baseline := −V (DECIMAL(14,2) allows negatives).
 */

// A drop is a reset only if it's big in both relative and absolute terms —
// a real reset goes to ~0 from thousands; tiny wobbles are not resets.
const RESET_DROP_FRACTION = 0.5
const RESET_MIN_DROP = 50
// Observed reset lag after the MES open is 5 s – 9 min (table above); 20 min
// leaves margin without swallowing a genuine second transfer.
const START_RESET_GRACE_MS = 20 * 60 * 1000

function isReset(prevReading, reading) {
  if (prevReading == null || reading == null) return false
  const p = Number(prevReading)
  const r = Number(reading)
  if (!isFinite(p) || !isFinite(r)) return false
  return r < p * RESET_DROP_FRACTION && p - r > RESET_MIN_DROP
}

/**
 * Fresh per-batch state for one totalizer.
 * @param {number} baseline      starting baseline (lb)
 * @param {number} openReading   reading at the MES open (0/null = none yet)
 */
function newTotalizerState(baseline, openReading) {
  const r = Number(openReading) || 0
  return {
    baseline: Number(baseline) || 0,
    last: r || null,        // last non-zero reading
    first: r || null,       // first non-zero reading this batch (frozen check)
    zeroSince: null,        // when the current run of 0 readings began
    resetSeen: false,       // a reset (this transfer's start) already handled
    hydrated: false,        // rebuilt from a DB row; cleared on the next non-zero reading
  }
}

/**
 * Advance one totalizer by one tick reading. Pure: returns the next state plus
 * { volume, reset, inGrace }.
 *
 * A reading of 0 is ambiguous — a reset still waiting for flow (batch 175 read
 * 0 for 12 min) or a dropout (restProvider maps a null value to 0) — so the
 * volume is held and the time the zeros began is remembered; the reset is
 * confirmed on the next non-zero reading, and the grace decision uses when the
 * zeros began. Shared by separatorStateMachine (live + replay ticks) and
 * scripts/recomputeSeparationVolumes.js so both compute identically.
 *
 * @param {object} st          state from newTotalizerState / previous call
 * @param {number} reading     totalizer reading in lb
 * @param {number} nowMs       reading time
 * @param {number|null} openedAtMs  MES open time of the batch
 */
function advanceTotalizer(st, reading, nowMs, openedAtMs) {
  const baseline = Number(st.baseline) || 0
  const last = st.last != null && isFinite(Number(st.last)) ? Number(st.last) : null
  const r = Number(reading) || 0
  if (!r) {
    return {
      ...st, baseline, last,
      zeroSince: st.zeroSince ?? nowMs,
      volume: Math.max(0, (last ?? baseline) - baseline),
      reset: false, inGrace: false,
    }
  }
  const resetAt = st.zeroSince ?? nowMs
  const inGrace = openedAtMs != null && resetAt - openedAtMs < START_RESET_GRACE_MS
  let next = { ...st, baseline, last: r, first: st.first ?? r, zeroSince: null, hydrated: false }
  let reset = false
  if (st.hydrated && !st.resetSeen && baseline > 0 && r < baseline - RESET_MIN_DROP) {
    // First reading after resuming a row that never recorded a reset, and the
    // counter is BELOW the baseline: the reset already happened (downtime, or a
    // row written by the pre-SD-722 code, whose `current < baseline → current`
    // fallback stored volume = reading, so baseline + volume is not a real
    // reading). Count from the reset rather than accumulating a phantom total.
    next.baseline = 0
    next.resetSeen = true
    reset = true
  } else if (isReset(last, r)) {
    reset = true
    const frozen = last - (st.first ?? last) <= RESET_MIN_DROP
    if (!st.resetSeen && (inGrace || frozen)) {
      next.baseline = 0                                   // this transfer's own start
    } else {
      next.baseline = -Math.max(0, last - baseline)       // keep volume so far, add post-reset rise
    }
    next.resetSeen = true
  }
  return { ...next, volume: Math.max(0, r - next.baseline), reset, inGrace }
}

module.exports = {
  RESET_DROP_FRACTION,
  RESET_MIN_DROP,
  START_RESET_GRACE_MS,
  isReset,
  newTotalizerState,
  advanceTotalizer,
}
