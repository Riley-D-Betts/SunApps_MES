const config = require('../config')
const MockProvider = require('./providers/mockProvider')
const RestProvider = require('./providers/restProvider')

/**
 * Factory: returns the configured Historian provider instance.
 */
function createProvider() {
  switch (config.HISTORIAN_PROVIDER) {
    case 'rest':
      return new RestProvider()
    case 'mock':
    default:
      return new MockProvider()
  }
}

module.exports = { createProvider }
