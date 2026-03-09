const BaseProvider = require('./baseProvider')

/**
 * Mock provider for development and testing.
 * Generates realistic fake separator batch and bulk milk flow data.
 */
class MockProvider extends BaseProvider {
  constructor() {
    super()
    this._batchCounter = 1000
  }

  async getSeparatorBatches(since) {
    // ~30% chance of generating a batch each poll
    if (Math.random() > 0.3) return []

    this._batchCounter++
    const now = new Date()
    const batchStart = new Date(now.getTime() - 30 * 60 * 1000) // 30 min ago
    const inputVolume = 5000 + Math.floor(Math.random() * 2000) // 5000-7000 gal
    const creamVolume = Math.floor(inputVolume * (0.35 + Math.random() * 0.05)) // ~35-40%
    const skimVolume = Math.floor(inputVolume * (0.55 + Math.random() * 0.05))  // ~55-60%

    const silos = ['SILO_1', 'SILO_2']
    const sourceSilo = silos[Math.floor(Math.random() * silos.length)]

    return [{
      batchId: `SEP-${this._batchCounter}`,
      sourceSilo,
      inputVolume,
      creamVolume,
      skimVolume,
      batchStart,
      batchEnd: now,
    }]
  }

  async getBulkMilkFlowData(since) {
    // ~50% chance of generating a flow reading each poll
    if (Math.random() > 0.5) return []

    return [{
      timestamp: new Date(),
      creamVolume: Math.floor(10 + Math.random() * 40), // 10-50 gal incremental
      skimVolume: Math.floor(20 + Math.random() * 80),  // 20-100 gal incremental
    }]
  }
}

module.exports = MockProvider
