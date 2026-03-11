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
   * Get blend tank work order status for all 4 tanks.
   * @returns {Promise<Array<{
   *   tankId: string,
   *   currentWO: string,
   *   currentItem: string,
   *   currentWOState: string,
   *   jobRunning: number,
   *   batchSize: number,
   *   fromEntName: string,
   *   toEntName: string
   * }>>}
   */
  async getBlendTankStatus() {
    throw new Error('getBlendTankStatus() not implemented')
  }

  /**
   * Get milk/cream line batch totalizer readings.
   * @returns {Promise<Array<{
   *   line: string,
   *   totalizerLbs: number
   * }>>}
   */
  async getMilkLineStatus() {
    throw new Error('getMilkLineStatus() not implemented')
  }
}

module.exports = BaseProvider
