const BaseProvider = require('./baseProvider')
const config = require('../../config')

/**
 * REST provider for real Aveva Historian API.
 * Stub implementation — fill in actual endpoints when Historian API is available.
 */
class RestProvider extends BaseProvider {
  constructor() {
    super()
    this.baseUrl = config.HISTORIAN_BASE_URL
    this.username = config.HISTORIAN_USERNAME
    this.password = config.HISTORIAN_PASSWORD
  }

  async getSeparatorBatches(since) {
    // TODO: Implement real Aveva Historian REST API calls
    // Example:
    //   GET {baseUrl}/api/batches?tag=SEPARATOR&since={since.toISOString()}
    //   Map response to standard shape: { batchId, sourceSilo, inputVolume, creamVolume, skimVolume, batchStart, batchEnd }
    throw new Error('RestProvider.getSeparatorBatches() not yet implemented — configure Historian API endpoints')
  }

  async getBulkMilkFlowData(since) {
    // TODO: Implement real Aveva Historian REST API calls
    // Example:
    //   GET {baseUrl}/api/tags/BULK_MILK_FLOW?since={since.toISOString()}
    //   Map response to standard shape: { timestamp, creamVolume, skimVolume }
    throw new Error('RestProvider.getBulkMilkFlowData() not yet implemented — configure Historian API endpoints')
  }
}

module.exports = RestProvider
