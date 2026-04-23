const BaseProvider = require('./baseProvider')

/**
 * Mock provider for development and testing.
 * Generates realistic fake separator batch and bulk milk flow data.
 */
class MockProvider extends BaseProvider {
  constructor() {
    super()
    this._batchCounter = 1000
    this._blendTankCycle = 0
    this._lineTotalizers = {
      ML1: 0, ML2: 0, ML3: 0, ML4: 0, CL1: 0, CL2: 0,
    }
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

  async getSeparatorStatus() {
    const running = Math.random() > 0.3
    return {
      feedPermit: running ? 1 : 0,
      motorRpm: running ? 4200 + Math.floor(Math.random() * 100) : 0,
      creamFlowGpm: running ? 5 + Math.random() * 3 : 0,
      skimFlowGpm: running ? 40 + Math.random() * 10 : 0,
      feedTotalLbs: running ? 100000 + Math.floor(Math.random() * 200000) : 313611,
      source: 'MSilo1',
      itemId: '300005',
      transferName: 'Separation',
      destinations: ['RawMilkSilo5', 'CSilo2'],
      creamTotalLbs: running ? Math.floor(Math.random() * 30000) : 38975,
      skimTotalLbs: running ? Math.floor(Math.random() * 250000) : 278675,
    }
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
  async getBlendTankStatus() {
    this._blendTankCycle++
    const tanks = ['BlendTank1A', 'BlendTank1B', 'BlendTank2A', 'BlendTank2B']
    const mockProducts = ['Marcels 1%', 'KS 2% org', 'Conv 3.25%', 'Horizon whole']

    return tanks.map((tankId, i) => {
      // Simulate tank 1A with a product every ~10 cycles, others idle
      const isActive = i === 0 && this._blendTankCycle % 20 >= 5 && this._blendTankCycle % 20 <= 15
      return {
        tankId,
        productName: isActive ? mockProducts[this._blendTankCycle % mockProducts.length] : '',
        weightLbs: isActive ? 20000 + Math.floor(Math.random() * 30000) : 0,
        batchSize: isActive ? 50000 : 0,
        fromEntName: isActive ? 'MSilo1' : '',
        toEntName: isActive ? 'UHT1' : '',
      }
    })
  }

  async getSiloStatus() {
    const SILO_CAPACITY_GAL = { milk: 60000, cream: 20000 }
    const silos = [
      { siloId: 'MSilo1', kind: 'milk', productName: 'Raw Conventional Milk' },
      { siloId: 'MSilo2', kind: 'milk', productName: 'Raw Conventional Milk' },
      { siloId: 'MSilo3', kind: 'milk', productName: 'Raw Conventional Milk' },
      { siloId: 'MSilo4', kind: 'milk', productName: 'Raw Organic Milk' },
      { siloId: 'MSilo5', kind: 'milk', productName: 'Raw Organic Milk' },
      { siloId: 'CSilo1', kind: 'cream', productName: 'Raw Conventional Cream' },
      { siloId: 'CSilo2', kind: 'cream', productName: 'Raw Conventional Cream' },
      { siloId: 'CSilo3', kind: 'cream', productName: 'Raw Organic Cream' },
    ]
    return silos.map(s => {
      const capacity = SILO_CAPACITY_GAL[s.kind]
      const gallons = Math.floor(Math.random() * capacity)
      const density = s.kind === 'milk' ? 8.63 : 8.3
      return {
        ...s,
        gallons,
        lbs: Math.round(gallons * density),
        capacityGal: capacity,
        levelPct: (gallons / capacity) * 100,
        tempF: 0,
        density,
      }
    })
  }

  async getUhtStatus() {
    return ['UHT1', 'UHT2'].map((uhtId, i) => {
      const running = Math.random() > 0.3
      return {
        uhtId,
        active: running,
        jobRunning: running,
        currentWO: running ? `UHT-WO-${2000 + i}` : '',
        currentItem: running ? (i === 0 ? '300015' : '300042') : '',
        galActual: running ? Math.floor(Math.random() * 50000) : 0,
        stepNum: running ? Math.floor(Math.random() * 30) + 1 : 0,
      }
    })
  }

  async getSurgeTankStatus() {
    return ['ST81', 'ST82', 'ST83', 'ST84'].map((tankId, i) => {
      const filling = Math.random() > 0.5
      const mainLevelPct = filling ? Math.floor(Math.random() * 100) : 0
      return {
        tankId,
        mainLevelPct,
        balanceLevelPct: filling ? Math.floor(Math.random() * 100) : 0,
        productDesc: filling ? ['Marcels 1%', 'KS 2% org', 'Conv 3.25%', 'Horizon whole'][i] : '',
        state: filling ? 5 + Math.floor(Math.random() * 10) : 1,
        empty: mainLevelPct < 2,
        connected: true,
        sterProdBarrOK: true,
        fillingOK: filling,
      }
    })
  }

  async getMilkLineStatus() {
    const lines = ['ML1', 'ML2', 'ML3', 'ML4', 'CL1', 'CL2']
    const mockProducts = {
      ML1: 'Conventional Fat Free', ML2: 'Raw Conventional',
      ML3: '', ML4: '',
      CL1: 'Raw Conventional Cream', CL2: '',
    }
    const mockDests = {
      ML1: 'BlendTank1A', ML2: 'BlendTank1B',
      ML3: '', ML4: 'UHT1',
      CL1: 'BlendTank1A', CL2: '',
    }
    const mockSilos = {
      ML1: 'MSilo1', ML2: 'MSilo2', ML3: '', ML4: 'MSilo3',
      CL1: 'CSilo1', CL2: '',
    }

    return lines.map(line => {
      // Simulate totalizer accumulation, occasional resets
      if (Math.random() < 0.05) {
        this._lineTotalizers[line] = 0
      } else {
        this._lineTotalizers[line] += Math.floor(Math.random() * 500)
      }
      const active = this._lineTotalizers[line] > 0
      return {
        line,
        totalizerLbs: this._lineTotalizers[line],
        productName: active ? (mockProducts[line] || '') : '',
        productCode: active ? '300015' : '',
        siloName: active ? (mockSilos[line] || '') : '',
        requestedBy: active ? (mockDests[line] || '') : '',
        requestedTargetLbs: active ? 50000 : 0,
        mode: active ? 'RUNNING' : 'NONE',
        stepName: active ? 'TRANSFER' : 'OFF',
        active,
        targetComplete: false,
        density: active ? 8.6 : 0,
      }
    })
  }
}

module.exports = MockProvider
