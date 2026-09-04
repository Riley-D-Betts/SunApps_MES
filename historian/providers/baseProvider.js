/**
 * Abstract base class for Historian data providers.
 * All providers must implement these methods.
 */
class BaseProvider {
  /**
   * Get separator batch data since the given timestamp.
   * @param {Date} since - Only return batches after this time
   * @returns {Promise<Array<{
   *   batchId: string,
   *   sourceSilo: string,
   *   inputVolume: number,
   *   creamVolume: number,
   *   skimVolume: number,
   *   batchStart: Date,
   *   batchEnd: Date
   * }>>}
   */
  async getSeparatorBatches(since) {
    throw new Error('getSeparatorBatches() not implemented')
  }

  /**
   * Get current separator live status from SCADA + OEM XFR tags.
   * @returns {Promise<{
   *   feedPermit: number,
   *   motorRpm: number,
   *   creamFlowGpm: number,
   *   skimFlowGpm: number,
   *   feedTotalLbs: number,
   *   source: string,
   *   itemId: string,
   *   transferName: string,
   *   destinations: string[],
   *   creamTotalLbs: number,
   *   skimTotalLbs: number
   * }>}
   */
  async getSeparatorStatus() {
    throw new Error('getSeparatorStatus() not implemented')
  }

  /**
   * Single-tick snapshot for the state machine. Returns every signal the
   * machine evaluates per tick: feedPermit, motorRpm, cipChemReq, cipRinseReq,
   * feedTotalLbs, creamTotalGal, skimTotalGal, xfrSource, xfrItemId,
   * xfrTransferName, xfrDestinations[4], xfrTransferCompleteRising (rising
   * edge this tick), siloProductConfig (per-silo index/name). See
   * BATCH_LIFECYCLE_PLAN.md §2 and services/separatorStateMachine.js.
   */
  async getSeparatorTickSnapshot() {
    throw new Error('getSeparatorTickSnapshot() not implemented')
  }

  /**
   * Get bulk milk flow data since the given timestamp.
   * @param {Date} since - Only return readings after this time
   * @returns {Promise<Array<{
   *   timestamp: Date,
   *   creamVolume: number,
   *   skimVolume: number
   * }>>}
   */
  async getBulkMilkFlowData(since) {
    throw new Error('getBulkMilkFlowData() not implemented')
  }

  /**
   * Get blend tank status for all 4 tanks.
   * NOTE_STRING is the Atlas product name; currentWOState is the Atlas WO
   * lifecycle state ("Running" while production WO is active, "Complete"
   * between batches).
   * @returns {Promise<Array<{
   *   tankId: string,
   *   productName: string,
   *   weightLbs: number,
   *   batchSize: number,
   *   fromEntName: string,
   *   toEntName: string,
   *   currentWOState: string
   * }>>}
   */
  async getBlendTankStatus() {
    throw new Error('getBlendTankStatus() not implemented')
  }

  /**
   * Get milk/cream line status including totalizer, product info, source, destination.
   * @returns {Promise<Array<{
   *   line: string,
   *   totalizerLbs: number,
   *   productName: string,
   *   productCode: string,
   *   siloName: string,
   *   requestedBy: string,
   *   requestedTargetLbs: number,
   *   mode: string,
   *   stepName: string,
   *   active: boolean,
   *   targetComplete: boolean,
   *   density: number,
   *   memRequestedBy: string,
   *   memSiloName: string,
   *   memProductName: string,
   *   memTotalizerLbs: number
   * }>>}
   */
  async getMilkLineStatus() {
    throw new Error('getMilkLineStatus() not implemented')
  }

  /**
   * Get current gallons, lbs, and product info for every silo (5 raw milk
   * + 3 cream). Level % is derived from gallons/capacity since the
   * canonical LevelValue tag has bad OPC quality.
   * @returns {Promise<Array<{
   *   siloId: string,
   *   kind: 'milk' | 'cream',
   *   gallons: number,
   *   lbs: number,
   *   capacityGal: number,
   *   levelPct: number,
   *   tempF: number,
   *   productName: string,
   *   density: number
   * }>>}
   */
  async getSiloStatus() {
    throw new Error('getSiloStatus() not implemented')
  }

  /**
   * Live state of the two milk receiving bays (Ingr_Rec_RecBay{1,2}_IO XFR
   * objects — same shape as the separator's transfer object). `source` is the
   * TRUCK NUMBER the operator keyed in (joins customrecord_milk_truck
   * custrecord_mt_truck_number), `itemId` the Standardization product index
   * (15 raw conventional, 16 raw organic …), `destinations` the silo(s) the
   * load pumps into. `transferReady` is the permissive: 1 while a transfer is
   * set up/running; QTYActual climbs during the unload and resets per load.
   * @returns {Promise<Array<{
   *   bayId: 'RecBay1' | 'RecBay2',
   *   source: string,
   *   itemId: string,
   *   destinations: string[],
   *   qtyActualLbs: number,
   *   qtyTargetLbs: number,
   *   intakeQtyLbs: number,
   *   transferReady: boolean,
   *   transferComplete: boolean
   * }>>}
   */
  async getReceivingStatus() {
    throw new Error('getReceivingStatus() not implemented')
  }

  /**
   * Get live status for both UHT pasteurizers.
   * @returns {Promise<Array<{
   *   uhtId: string,
   *   active: boolean,
   *   jobRunning: boolean,
   *   currentWO: string,
   *   currentItem: string,
   *   galActual: number,
   *   flowGpm: number,
   *   stepNum: number,
   *   stepName: string,
   *   mode: 'PROCESS' | 'CIP' | 'DD_INH' | 'IDLE',
   *   recipeText: string,
   *   woState: string,
   *   fromEntName: string,
   *   toEntName: string
   * }>>}
   */
  async getUhtStatus() {
    throw new Error('getUhtStatus() not implemented')
  }

  /**
   * Resolve which surge tanks each UHT is plumbed to (Connection_Code === 1).
   * UHT1 connects to ST81+ST82; UHT2 to ST83+ST84. Returns null per UHT if
   * no tanks are connected. The caller determines the actively filling tank
   * via level-delta from getSurgeTankStatus pollDeltaGal.
   * @returns {Promise<{ UHT1: string[] | null, UHT2: string[] | null }>}
   */
  async getUhtSurgeTankRouting() {
    throw new Error('getUhtSurgeTankRouting() not implemented')
  }

  /**
   * Get live status for the four aseptic surge tanks (ST81-84).
   * `pollDeltaGal` is the signed change in mainGallons since the previous
   * poll (positive = inflow from UHT, negative = outflow to filler). Null
   * on the first poll after process start.
   * @returns {Promise<Array<{
   *   tankId: string,
   *   mainLevelPct: number,
   *   mainGallons: number,
   *   pollDeltaGal: number | null,
   *   productDesc: string,
   *   state: number,
   *   empty: boolean,
   *   connected: boolean,
   *   sterProdBarrOK: boolean,
   *   fillingOK: boolean,
   *   activeFill: boolean,
   *   connectedUht: string | null
   * }>>}
   */
  async getSurgeTankStatus() {
    throw new Error('getSurgeTankStatus() not implemented')
  }

  /**
   * Read the Filler 1 inlet flow meter (TR11 FT1140) — the combined
   * ST81/82 → Filler 1 leg. Line-level, NOT per-surge-tank flow.
   * Raw current values only; consumers own all baseline/delta math. The
   * totalizer is a resettable odometer that also counts non-production
   * (flush/CIP) flow — product math must gate on `running`.
   * Never rejects: failed or bad-OPC-quality reads return measured:false
   * with null gpm/totalizerGal. `running` (Filler1 RunMode) is independent
   * of `measured`; `sampleAt` is the historian timestamp of the GPM sample
   * whenever that read succeeded (may be non-null while measured is false;
   * null only when the GPM read itself failed).
   * @returns {Promise<{
   *   gpm: number | null,
   *   totalizerGal: number | null,
   *   measured: boolean,
   *   running: boolean | null,
   *   sampleAt: string | null
   * }>}
   */
  async getFiller1InletFlow() {
    throw new Error('getFiller1InletFlow() not implemented')
  }

  /**
   * Resolve which surge tank a given UHT is currently routed to. Used at the
   * start of a UHT-direct run to figure out which ST{NN} will receive the FG,
   * so the WO can be created with the correct pasteurized assembly item.
   * @param {string} uhtId - 'UHT1' or 'UHT2'
   * @returns {Promise<{
   *   surgeTankId: string,
   *   connectionCode: number,
   *   productDesc: string,
   *   mainLevelPct: number
   * } | null>}
   */
  async getUhtDestinationSurgeTank(uhtId) {
    throw new Error('getUhtDestinationSurgeTank() not implemented')
  }

  /**
   * Read the current value of the per-UHT software milk-flow totalizer (in
   * gallons). The hardware lacks a real totalizer on FT1102, so the rest
   * provider integrates the live GPM over time while the UHT is in PROCESS
   * mode. Value resets on each IDLE→PROCESS transition.
   *
   * Used by the surge tank tick as the inflow source (UHT → ST is 1:1 during
   * a run). When/if a hardware ST inflow tag ships, swap this read.
   * @param {string} uhtId - 'UHT1' or 'UHT2'
   * @returns {Promise<number>} gallons; 0 if the UHT is idle or unknown
   */
  async getUhtMilkTotalizer(uhtId) {
    throw new Error('getUhtMilkTotalizer() not implemented')
  }

  /**
   * Read the current FromEntName tag for a UHT — the source entity the UHT
   * is currently pulling from. Either a silo (MSiloN or CSiloN) or a blend
   * tank (BlendTankNA/B). Drives surge-tank-batch component resolution.
   * @param {string} uhtId - 'UHT1' or 'UHT2'
   * @returns {Promise<string>} '' when the UHT is idle or tag is empty
   */
  async getUhtFromEntName(uhtId) {
    throw new Error('getUhtFromEntName() not implemented')
  }
}

module.exports = BaseProvider
