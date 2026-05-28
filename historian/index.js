const config = require('../config')
const MockProvider = require('./providers/mockProvider')
const RestProvider = require('./providers/restProvider')
const HistoricalProvider = require('./providers/historicalProvider')

/**
 * Factory: returns a Historian provider instance. Pass an explicit type to
 * override the env default — used by the runtime-config flow that swaps
 * providers without a restart.
 */
function createProvider(type) {
  const which = type || config.HISTORIAN_PROVIDER
  switch (which) {
    case 'rest':
      return new RestProvider()
    case 'historical':
      return new HistoricalProvider()
    case 'mock':
    default:
      return new MockProvider()
  }
}

module.exports = { createProvider }
