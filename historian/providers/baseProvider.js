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
}

module.exports = BaseProvider
