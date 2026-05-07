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
   * Uses NOTE_STRING (product name from Atlas) for batch detection.
   * @returns {Promise<Array<{
   *   tankId: string,
   *   productName: string,
   *   weightLbs: number,
   *   batchSize: number,
   *   fromEntName: string,
   *   toEntName: string
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
   *   density: number
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
}

module.exports = BaseProvider
