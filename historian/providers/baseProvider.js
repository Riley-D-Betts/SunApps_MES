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
   *   stepNum: number
   * }>>}
   */
  async getUhtStatus() {
    throw new Error('getUhtStatus() not implemented')
  }

  /**
   * Get live status for the four aseptic surge tanks (ST81-84).
   * @returns {Promise<Array<{
   *   tankId: string,
   *   mainLevelPct: number,
   *   mainGallons: number,
   *   productDesc: string,
   *   state: number,
   *   empty: boolean,
   *   connected: boolean,
   *   sterProdBarrOK: boolean,
   *   fillingOK: boolean
   * }>>}
   */
  async getSurgeTankStatus() {
    throw new Error('getSurgeTankStatus() not implemented')
  }
}

module.exports = BaseProvider
