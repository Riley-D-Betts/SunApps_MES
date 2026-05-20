const BaseProvider = require('./baseProvider')
const { PROCESS_STEP_NAMES, CIP_STEP_NAMES } = require('./uhtStepNames')

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
    const batchStart = new Date(now.getTime() - 30 * 60 * 1000)
    const inputVolume = 5000 + Math.floor(Math.random() * 2000)
    const creamVolume = Math.floor(inputVolume * (0.08 + Math.random() * 0.04)) // ~8-12% (realistic cream yield)
    const skimVolume = Math.floor(inputVolume * (0.85 + Math.random() * 0.04))  // ~85-89% normalized output

    // Three realistic scenarios: pure conventional raw → conv cream + raw skim;
    // organic → org cream + raw org skim; and a normalization run where the
    // skim side is standardized to 2%. Exercising all three makes the product-
    // index → NS item lookup path visible in dev.
    const scenarios = [
      { source: 'MSilo1', sourceIdx: 15, sourceName: 'Raw Conventional',
        creamSilo: 'CSilo1', creamIdx: 11, creamName: 'Conventional Cream 40%',
        skimSilo:  'MSilo2', skimIdx:  5, skimName:  'Conventional Fat Free' },
      { source: 'MSilo4', sourceIdx: 16, sourceName: 'Raw Organic',
        creamSilo: 'CSilo3', creamIdx: 12, creamName: 'Organic Cream 40%',
        skimSilo:  'MSilo5', skimIdx: 10, skimName: 'Organic Fat Free' },
      { source: 'MSilo1', sourceIdx: 15, sourceName: 'Raw Conventional',
        creamSilo: 'CSilo2', creamIdx: 11, creamName: 'Conventional Cream 40%',
        skimSilo:  'MSilo3', skimIdx:  3, skimName:  'Conventional Reduced Fat 2%' },
    ]
    const s = scenarios[Math.floor(Math.random() * scenarios.length)]

    return [{
      batchId: `SEP-${this._batchCounter}`,
      sourceSilo: s.source,
      destinations: [s.creamSilo, s.skimSilo],
      siloProductConfig: {
        [s.source]:    { productIndex: s.sourceIdx, productName: s.sourceName },
        [s.creamSilo]: { productIndex: s.creamIdx,  productName: s.creamName  },
        [s.skimSilo]:  { productIndex: s.skimIdx,   productName: s.skimName   },
      },
      inputVolume,
      creamVolume,
      skimVolume,
      batchStart,
      batchEnd: now,
      itemId: String(300000 + s.sourceIdx),
      transferName: `Separation ${s.source} → ${s.creamSilo}/${s.skimSilo}`,
      unit: 'LBS',
      targetVolume: inputVolume,
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

  async getSeparatorTickSnapshot() {
    const running = Math.random() > 0.3
    const feedTotalLbs = running ? 100000 + Math.floor(Math.random() * 200000) : 313611
    const creamTotalGal = running ? Math.floor(Math.random() * 3500) : 4520
    const skimTotalGal = running ? Math.floor(Math.random() * 29000) : 32325
    return {
      pollTime: new Date(),
      feedPermit: running,
      motorRpm: running ? 4200 + Math.floor(Math.random() * 100) : 0,
      cipChemReq: false,
      cipRinseReq: false,
      feedTotalLbs,
      creamFlowGpm: running ? 5 + Math.random() * 3 : 0,
      skimFlowGpm: running ? 40 + Math.random() * 10 : 0,
      creamTotalGal,
      skimTotalGal,
      creamTotalLbs: creamTotalGal * 8.62,
      skimTotalLbs: skimTotalGal * 8.63,
      xfrSource: 'MSilo1',
      xfrItemId: '300005',
      xfrTransferName: 'Separation',
      xfrUnit: 'LBS',
      xfrQtyTarget: 350000,
      xfrDestinations: ['RawMilkSilo5', 'CSilo2', '', ''],
      xfrTransferCompleteRising: false,
      siloProductConfig: {
        MSilo1: { productIndex: 15, productName: 'Raw Conventional' },
        MSilo5: { productIndex: 5, productName: 'Conventional Fat Free' },
        CSilo2: { productIndex: 11, productName: 'Conventional Cream 40%' },
      },
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
        currentWOState: isActive ? 'Running' : 'Complete',
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
      const isCip = !running && Math.random() > 0.5
      const mode = running ? 'PROCESS' : (isCip ? 'CIP' : 'IDLE')
      const stepNum = mode === 'PROCESS' ? 4 + Math.floor(Math.random() * 8)
        : mode === 'CIP' ? 1 + Math.floor(Math.random() * 6)
        : 0
      const stepName = mode === 'CIP'
        ? (CIP_STEP_NAMES[stepNum] ?? `CIP Step ${stepNum}`)
        : (PROCESS_STEP_NAMES[stepNum] ?? `Step ${stepNum}`)

      return {
        uhtId,
        active: running,
        jobRunning: running,
        currentWO: running ? `UHT-WO-${2000 + i}` : '',
        currentItem: running ? (i === 0 ? '300015' : '300042') : '',
        galActual: running ? Math.floor(Math.random() * 50000) : 0,
        flowGpm: running ? 50 + Math.random() * 30 : 0,
        stepNum,
        stepName,
        mode,
        recipeText: running ? ['White Milk', '1% Low Fat', '2% Reduced Fat', 'Heavy Whip'][i % 4] : '',
        woState: running ? 'RUNNING' : '',
        fromEntName: running ? (i === 0 ? 'BlendTank1A' : 'BlendTank2A') : '',
        toEntName: running ? (i === 0 ? 'ST81' : 'ST83') : '',
      }
    })
  }

  async getUhtSurgeTankRouting() {
    return {
      UHT1: ['ST81', 'ST82'],
      UHT2: ['ST83', 'ST84'],
    }
  }

  async getSurgeTankStatus() {
    if (!this._prevSurgeGal) this._prevSurgeGal = { ST81: null, ST82: null, ST83: null, ST84: null }
    return ['ST81', 'ST82', 'ST83', 'ST84'].map((tankId, i) => {
      const filling = Math.random() > 0.5
      const mainLevelPct = filling ? Math.floor(Math.random() * 100) : 0
      const mainGallons = Math.round(mainLevelPct * 50)  // ~5000 gal capacity per surge tank
      const prev = this._prevSurgeGal[tankId]
      const pollDeltaGal = prev == null ? null : mainGallons - prev
      this._prevSurgeGal[tankId] = mainGallons
      return {
        tankId,
        mainLevelPct,
        mainGallons,
        pollDeltaGal,
        productDesc: filling ? ['Marcels 1%', 'KS 2% org', 'Conv 3.25%', 'Horizon whole'][i] : '',
        state: filling ? 5 + Math.floor(Math.random() * 10) : 1,
        empty: mainLevelPct < 2,
        connected: true,
        sterProdBarrOK: true,
        fillingOK: filling,
      }
    })
  }

  async getUhtMilkTotalizer(uhtId) {
    // Monotonic per-UHT accumulator that drifts up while the mock is "running".
    // Resets every ~40 cycles to simulate an IDLE→PROCESS transition.
    if (!this._uhtMilkGal) this._uhtMilkGal = { UHT1: 0, UHT2: 0 }
    if (!this._uhtMilkGalCycle) this._uhtMilkGalCycle = { UHT1: 0, UHT2: 0 }
    this._uhtMilkGalCycle[uhtId] = (this._uhtMilkGalCycle[uhtId] || 0) + 1
    if (this._uhtMilkGalCycle[uhtId] % 40 === 0) this._uhtMilkGal[uhtId] = 0
    this._uhtMilkGal[uhtId] += 50 + Math.floor(Math.random() * 200)
    return this._uhtMilkGal[uhtId]
  }

  async getUhtFromEntName(uhtId) {
    // UHT1 pulls from BlendTank1A in the mock; UHT2 pulls from MSilo1 (a
    // direct-from-silo run). Exercises both component-resolution code paths.
    if (uhtId === 'UHT1') return 'BlendTank1A'
    if (uhtId === 'UHT2') return 'MSilo1'
    return ''
  }

  async getUhtDestinationSurgeTank(uhtId) {
    if (!/^UHT[12]$/i.test(uhtId)) return null
    // UHT1 → ST81/82, UHT2 → ST83/84 deterministically per cycle so dev sees
    // the routing exercise both halves of the matrix. Real plant routes are
    // operator-driven and read from the Connection_Code tags by RestProvider.
    const cycle = this._blendTankCycle % 4
    const choices = uhtId.toUpperCase() === 'UHT1' ? ['ST81', 'ST82'] : ['ST83', 'ST84']
    const surgeTankId = choices[cycle % choices.length]
    return {
      surgeTankId,
      connectionCode: 1,
      productDesc: ['Marcels 1%', 'Kirkland Whole', 'Horizon Organic 2%', 'Conventional 3.25%'][cycle],
      mainLevelPct: 30 + Math.floor(Math.random() * 50),
    }
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
        memRequestedBy: mockDests[line] || '',
        memSiloName: mockSilos[line] || '',
        memProductName: mockProducts[line] || '',
        memTotalizerLbs: this._lineTotalizers[line],
      }
    })
  }
}

module.exports = MockProvider
