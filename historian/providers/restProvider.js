const BaseProvider = require('./baseProvider')
const config = require('../../config')
const httpntlm = require('httpntlm')

/**
 * REST provider for the on-premise AVEVA Historian OData v2 API.
 * Uses NTLM auth against the MES domain.
 *
 * Separation batches are detected via XFR (transfer) tags on the separator IO:
 *   - Ingr_Sep_CMSep1_IO.XFR.TransferCompleteS.0  — trigger when transfer finishes
 *   - Ingr_Sep_CMSep1_IO.XFR.QTYActual            — per-batch input volume (resets to 0 between batches)
 *   - Ingr_Sep_CMSep1_IO.XFR.Source                — source silo (e.g. "MSilo1")
 *   - Ingr_Sep_CMSep1_IO.XFR.ItemID                — item ID
 *   - Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized     — per-batch cream (resets to 0 between batches)
 *   - Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized      — per-batch skim (resets to 0 between batches)
 *
 * All volume tags reset to 0 between batches, so the value at TransferComplete
 * IS the per-batch total.
 */

// Density constants (PPG — pounds per gallon)
// Flow totalizers record gallons; multiply by these to get LBS
const CREAM_DENSITY_PPG = 8.3
const SKIM_DENSITY_PPG = 8.63

// Tag name constants
const TAGS = {
  // XFR transfer tags (per-batch, reset between batches)
  SEP_XFR_TRANSFER_COMPLETE: 'Ingr_Sep_CMSep1_IO.XFR.TransferCompleteS.0',
  SEP_XFR_QTY_ACTUAL:        'Ingr_Sep_CMSep1_IO.XFR.QTYActual',
  SEP_XFR_QTY_TARGET:        'Ingr_Sep_CMSep1_IO.XFR.QTYTarget',
  SEP_XFR_SOURCE:             'Ingr_Sep_CMSep1_IO.XFR.Source',
  SEP_XFR_ITEM_ID:            'Ingr_Sep_CMSep1_IO.XFR.ItemID',
  SEP_XFR_NAME:               'Ingr_Sep_CMSep1_IO.XFR.Name',
  SEP_XFR_EU:                 'Ingr_Sep_CMSep1_IO.XFR.EU',

  // OEM destination slots (from separator control system)
  SEP_XFR_DEST_0: 'Ingr_Sep_CMSep1_IO.XFR.Destination#.0',
  SEP_XFR_DEST_1: 'Ingr_Sep_CMSep1_IO.XFR.Destination#.1',
  SEP_XFR_DEST_2: 'Ingr_Sep_CMSep1_IO.XFR.Destination#.2',
  SEP_XFR_DEST_3: 'Ingr_Sep_CMSep1_IO.XFR.Destination#.3',

  // Flow totals (per-batch, reset between batches)
  CREAM_FLOW_TOTAL: 'Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized',
  SKIM_FLOW_TOTAL:  'Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized',

  // Live separator status (SEPSTAT — real-time from SCADA)
  SEP_FEED_PERMIT:   'SEPSTAT.FEEDPERMIT',
  SEP_CREAM_FLOW:    'SEPSTAT.CREAMFLOW',       // GPM
  SEP_SKIM_FLOW:     'SEPSTAT.SKIMFLOW',         // GPM
  SEP_MOTOR_RPM:     'SEPSTAT.MOTORSPEEDPROX',   // RPM
  SEP_FEED_TOTAL:    'Product.SepFeedTotal',      // LBS — live separator feed totalizer

  // Blend tank tags (per-tank prefix substituted at query time)
  // NOTE: MES WO tags (CurrentWO, JobRunning, etc.) are stale — plant uses Atlas, not MES.
  // NOTE_STRING is the live product name written by Atlas via PLC.
  BT_NOTE_STRING:   '.NOTE_STRING',
  BT_WEIGHT_LBS:    '.100LT.SCL_LBS',
  BT_BATCH_SIZE:    '.BatchSize',
  BT_FROM_ENT:      '.FromEntName',
  BT_TO_ENT:        '.ToEntName',


  // Milk/cream line tag suffixes (per-line, identical structure across ML1-4 and CL1-2)
  // Prefixed with line name at query time (e.g. 'ML1.BATCHTOTALIZER')
  LINE_TOTALIZER:       '.BATCHTOTALIZER',
  LINE_PRODUCT_NAME:    '.CURRENTSILOPRODUCTNAME',
  LINE_PRODUCT_CODE:    '.CURRENTSILOPRODUCTCODE',
  LINE_SILO_NAME:       '.CURRENTSILONAME',
  LINE_SILO_INDEX:      '.CURRENTSILOINDEX',
  LINE_DENSITY:         '.CURRENTSILOPRODUCTDENSITY',
  LINE_REQUESTED_BY:    '.REQUESTEDBY',          // destination vessel (e.g. "BlendTank1A" or "UHT1")
  LINE_REQUESTED_TARGET:'.REQUESTEDTARGETSP',    // LBS requested
  LINE_MODE:            '.MODESTRING',
  LINE_STEP_NAME:       '.STEPNAME',
  LINE_STEP_NUM:        '.STEPNUM',
  LINE_ACTIVE:          '.STAT_ACTIVE',
  LINE_TARGET_COMPLETE: '.STAT_TARGETCOMPLETE',
  LINE_INHIBITED:       '.STAT_INHIBITED',
  LINE_MEM_TOTALIZER:   '.MEMBATCHTOTALIZER',    // previous batch totalizer

  // Silo tags — the .GALLONS/.LBS/.LevelValue/.TempValue tags exist under the
  // UPPERCASE prefix but are bad quality (OpcQuality=0). The PLC writes live
  // data to the underscore/CamelCase form: `MSilo{N}_Gallons.Value` etc.
  // Product name + density use the UPPERCASE prefix.
  SILO_GALLONS:       '_Gallons.Value',   // suffix on lowercase-name prefix (e.g. MSilo1)
  SILO_LBS:           '_LBS.Value',       // suffix on lowercase-name prefix
  SILO_PRODUCT_NAME:  '.ProductName',     // suffix on UPPERCASE prefix (e.g. MSILO1)
  SILO_DENSITY:       '.ProductDensity',  // suffix on UPPERCASE prefix (PPG)
  SILO_PRODUCT_INDEX: '.IndexSelectRead', // suffix on UPPERCASE prefix — the 1-40 code from the Standardization HMI Product Config table

  // UHT tags (per-UHT prefix, e.g. UHT1)
  UHT_ACTIVE:         '.Active',
  UHT_JOB_RUNNING:    '.JobRunning',
  UHT_CURRENT_WO:     '.CurrentWO',
  UHT_CURRENT_ITEM:   '.CurrentItem',
  UHT_GAL_ACTUAL:     '.GalActual',
  UHT_STEP_NUM:       '.StepNum',

  // Surge tank tags. Two different prefixes are used:
  //   * Status / product / state bits live under single-prefix `ThermaRoute.ST{N}_*`
  //   * The actual level-percentage and gallons readings live under the
  //     DOUBLE-prefixed `ThermaRoute.ThermaRoute.ST{N}_LT...` path — that's
  //     where the PLC writes the real "Sterile Tank Level %" values. The
  //     single-prefix `_Status` variants return 0 regardless of fill.
  // {N} is the tank number (1..4); LT8{N}01 is the main tank.
  ST_MAIN_LEVEL_FQN:  'ThermaRoute.ThermaRoute.{TID}_LT8{N}01',
  ST_MAIN_GAL_FQN:    'ThermaRoute.ThermaRoute.{TID}_LT8{N}01_Gal',
  ST_PRODUCT_DESC:    '_ProductDesc',
  ST_STATE:           '_State',
  ST_TANK_EMPTY:      '_TankEmpty_Indicator',
  ST_CONNECTED:       '_Connected',
  ST_STER_PROD_BARR:  '_SterProdBarrOK',
  ST_FILLING_OK:      '_FillingOK',
}

class RestProvider extends BaseProvider {
  constructor() {
    super()
    this.baseUrl = config.HISTORIAN_BASE_URL
    this.domain = config.HISTORIAN_DOMAIN
    this.username = config.HISTORIAN_USERNAME
    this.password = config.HISTORIAN_PASSWORD

    // Track previous totalized flow readings for delta calculation (bulk milk)
    this._prevCreamTotal = null
    this._prevSkimTotal = null
  }

  // ── OData helpers ──────────────────────────────────────────────────

  /**
   * NTLM-authenticated GET returning parsed JSON.
   * @param {string} url
   * @param {{ verbose?: boolean }} opts - verbose=true logs request/response details (default: false)
   */
  _get(url, { verbose = true } = {}) {
    if (verbose) console.log(`[RestProvider] --> GET ${url}`)
    return new Promise((resolve, reject) => {
      httpntlm.get({
        url,
        domain: this.domain,
        username: this.username,
        password: this.password,
        headers: { 'Accept': 'application/json' },
      }, (err, res) => {
        if (err) {
          if (verbose) console.error(`[RestProvider] <-- ERROR:`, err.message)
          return reject(err)
        }
        if (verbose) {
          console.log(`[RestProvider] <-- HTTP ${res.statusCode}, body length: ${res.body?.length ?? 0} chars`)
          console.log(`[RestProvider] <-- RAW BODY (first 500 chars): ${res.body?.slice(0, 500)}`)
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`Historian API ${res.statusCode}: ${res.body?.slice(0, 300)}`))
        }
        try {
          // Historian sometimes prepends a BOM
          const body = res.body.replace(/^\uFEFF/, '')
          const parsed = JSON.parse(body)
          if (verbose) console.log(`[RestProvider] <-- PARSED: keys=${Object.keys(parsed).join(', ')}, value.length=${parsed.value?.length ?? 'N/A'}, nextLink=${parsed['@odata.nextLink'] ?? 'none'}`)
          resolve(parsed)
        } catch (e) {
          reject(new Error(`Invalid JSON from Historian: ${res.body?.slice(0, 300)}`))
        }
      })
    })
  }

  /**
   * Query ProcessValues for one tag, optionally filtered by time range.
   * Follows @odata.nextLink to collect all pages (server caps each page).
   * AVEVA on-prem uses bare ISO datetimes (NOT datetimeoffset'...' wrapper).
   */
  async _queryProcessValues(fqn, since, until, { maxRecords = 50000, verbose = true } = {}) {
    if (verbose) console.log(`[RestProvider] _queryProcessValues: fqn=${fqn}, since=${since?.toISOString() ?? 'none'}, until=${until?.toISOString() ?? 'none'}`)
    let filter = `FQN eq '${fqn}'`
    if (since) filter += ` and DateTime ge ${since.toISOString()}`
    if (until) filter += ` and DateTime le ${until.toISOString()}`
    let url = `${this.baseUrl}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime`

    const all = []
    let page = 0
    while (url && all.length < maxRecords) {
      page++
      if (verbose) console.log(`[RestProvider] _queryProcessValues: fetching page ${page}, collected so far: ${all.length}`)
      const data = await this._get(url, { verbose })
      all.push(...(data.value || []))
      url = all.length < maxRecords ? (data['@odata.nextLink'] || null) : null
    }
    if (verbose) console.log(`[RestProvider] _queryProcessValues: done — ${all.length} total records across ${page} page(s)`)
    return all
  }

  /**
   * Get the latest (current) value of a single tag.
   * Uses Tags('fqn')/Raw endpoint which returns real-time data with correct timestamps.
   * The ProcessValues endpoint is cached/delayed (~1h behind due to Historian DST skew).
   */
  async _getCurrentValue(fqn, { verbose = true } = {}) {
    const url = `${this.baseUrl}/Tags('${encodeURIComponent(fqn)}')/Raw?$orderby=DateTime%20desc&$top=1`
    const data = await this._get(url, { verbose })
    return data.value?.[0] || null
  }

  /**
   * Get the value of a tag at or just before a specific timestamp.
   * Queries a 30-minute window and returns the last recorded value.
   */
  async _getValueAt(fqn, timestamp) {
    const windowStart = new Date(timestamp.getTime() - 30 * 60 * 1000)
    const values = await this._queryProcessValues(fqn, windowStart, timestamp)
    return values.length > 0 ? values[values.length - 1] : null
  }

  /**
   * Get historical values for multiple tags at a timestamp in parallel.
   * Returns a map of FQN → ProcessValue.
   */
  async _getValuesAt(fqns, timestamp) {
    const results = await Promise.all(fqns.map(fqn => this._getValueAt(fqn, timestamp)))
    const map = {}
    fqns.forEach((fqn, i) => { map[fqn] = results[i] })
    return map
  }

  // ── Separation batches ─────────────────────────────────────────────

  /**
   * Detect completed separation batches by watching the XFR TransferComplete
   * trigger. All volume tags (QTYActual, Cream/Skim_Flow_Totalized) reset
   * to 0 between batches, so the value at TransferComplete is the per-batch total.
   */
  async getSeparatorBatches(since) {
    const now = new Date()

    const xfrEvents = await this._queryProcessValues(
      TAGS.SEP_XFR_TRANSFER_COMPLETE, since, now, { verbose: false }
    )

    const completedEvents = xfrEvents.filter(e => e.Value === 1)

    if (completedEvents.length === 0) return []

    console.log(`[RestProvider] Found ${completedEvents.length} transfer complete event(s)`)

    const batches = []
    for (const event of completedEvents) {
      const transferTime = new Date(event.DateTime)
      try {
        const batch = await this._buildBatchFromTransfer(transferTime)
        if (batch) batches.push(batch)
      } catch (err) {
        console.error(`[RestProvider] Failed to read batch at ${transferTime.toISOString()}:`, err.message)
      }
    }

    return batches
  }

  async getSeparatorStatus() {
    const fqns = [
      // Live SCADA status
      TAGS.SEP_FEED_PERMIT, TAGS.SEP_MOTOR_RPM,
      TAGS.SEP_CREAM_FLOW, TAGS.SEP_SKIM_FLOW,
      TAGS.SEP_FEED_TOTAL,
      // XFR config (source, destinations, item)
      TAGS.SEP_XFR_SOURCE, TAGS.SEP_XFR_ITEM_ID, TAGS.SEP_XFR_NAME,
      TAGS.SEP_XFR_DEST_0, TAGS.SEP_XFR_DEST_1, TAGS.SEP_XFR_DEST_2, TAGS.SEP_XFR_DEST_3,
      // Batch totals
      TAGS.CREAM_FLOW_TOTAL, TAGS.SKIM_FLOW_TOTAL,
    ]
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))
    const map = {}
    fqns.forEach((fqn, i) => { map[fqn] = values[i] })

    const txt = (tag) => map[tag]?.Text ?? ''
    const val = (tag) => map[tag]?.Value ?? 0

    const creamTotalGal = val(TAGS.CREAM_FLOW_TOTAL)
    const skimTotalGal = val(TAGS.SKIM_FLOW_TOTAL)

    const destinations = [
      TAGS.SEP_XFR_DEST_0, TAGS.SEP_XFR_DEST_1,
      TAGS.SEP_XFR_DEST_2, TAGS.SEP_XFR_DEST_3,
    ].map(t => txt(t)).filter(Boolean)

    return {
      feedPermit: val(TAGS.SEP_FEED_PERMIT),
      motorRpm: val(TAGS.SEP_MOTOR_RPM),
      creamFlowGpm: val(TAGS.SEP_CREAM_FLOW),
      skimFlowGpm: val(TAGS.SEP_SKIM_FLOW),
      feedTotalLbs: val(TAGS.SEP_FEED_TOTAL),
      source: txt(TAGS.SEP_XFR_SOURCE),
      itemId: txt(TAGS.SEP_XFR_ITEM_ID),
      transferName: txt(TAGS.SEP_XFR_NAME),
      destinations,
      creamTotalLbs: creamTotalGal * CREAM_DENSITY_PPG,
      skimTotalLbs: skimTotalGal * SKIM_DENSITY_PPG,
    }
  }

  /**
   * Read all batch-related tags at the TransferComplete timestamp.
   * Volume tags reset to 0 between batches, so the value at this moment
   * is the per-batch total.
   */
  async _buildBatchFromTransfer(transferTime) {
    const tagMap = await this._getValuesAt([
      TAGS.SEP_XFR_QTY_ACTUAL,
      TAGS.SEP_XFR_QTY_TARGET,
      TAGS.SEP_XFR_SOURCE,
      TAGS.SEP_XFR_ITEM_ID,
      TAGS.SEP_XFR_NAME,
      TAGS.SEP_XFR_EU,
      TAGS.SEP_XFR_DEST_0,
      TAGS.SEP_XFR_DEST_1,
      TAGS.SEP_XFR_DEST_2,
      TAGS.SEP_XFR_DEST_3,
      TAGS.CREAM_FLOW_TOTAL,
      TAGS.SKIM_FLOW_TOTAL,
    ], transferTime)

    const val = (tag) => tagMap[tag]?.Value ?? 0
    const txt = (tag) => tagMap[tag]?.Text ?? ''

    const source = txt(TAGS.SEP_XFR_SOURCE)
    if (!source) {
      console.log(`[RestProvider] No source at ${transferTime.toISOString()}, skipping`)
      return null
    }

    const batchId = `XFR-${transferTime.getTime()}`
    const inputVolume = val(TAGS.SEP_XFR_QTY_ACTUAL)
    const creamGallons = val(TAGS.CREAM_FLOW_TOTAL)
    const skimGallons = val(TAGS.SKIM_FLOW_TOTAL)
    const creamVolume = creamGallons * CREAM_DENSITY_PPG
    const skimVolume = skimGallons * SKIM_DENSITY_PPG

    const destinations = [
      TAGS.SEP_XFR_DEST_0, TAGS.SEP_XFR_DEST_1,
      TAGS.SEP_XFR_DEST_2, TAGS.SEP_XFR_DEST_3,
    ].map(t => txt(t)).filter(Boolean)

    // Pull the 1-40 product index + name for every silo that shows up on this
    // batch — the Standardization HMI writes whatever the operator selected to
    // each silo's IndexSelectRead tag, so this is how we resolve "what got
    // produced into MSilo1 this run" (can be raw skim, 1%, 2%, whole, etc.).
    const siloProductConfig = await this._readSiloProductConfigRaw([source, ...destinations])

    console.log(`[RestProvider] Batch ${batchId}: ${source}[${siloProductConfig[source]?.productIndex || '?'}] → ${destinations.map(d => `${d}[${siloProductConfig[d]?.productIndex || '?'}]`).join(', ') || '?'}, input=${inputVolume.toFixed(1)} LBS, cream=${creamGallons.toFixed(1)} gal (${creamVolume.toFixed(1)} LBS), skim=${skimGallons.toFixed(1)} gal (${skimVolume.toFixed(1)} LBS)`)

    return {
      batchId,
      sourceSilo: source,
      destinations,
      siloProductConfig,
      inputVolume,
      creamVolume,
      skimVolume,
      batchStart: new Date(transferTime.getTime() - 30 * 60 * 1000),
      batchEnd: transferTime,
      itemId: txt(TAGS.SEP_XFR_ITEM_ID),
      transferName: txt(TAGS.SEP_XFR_NAME),
      unit: txt(TAGS.SEP_XFR_EU),
      targetVolume: val(TAGS.SEP_XFR_QTY_TARGET),
    }
  }

  /**
   * Read IndexSelectRead + ProductName for each silo name. Accepts raw SCADA
   * names (MSilo1, MSILO1, RawMilkSilo5, CreamSilo2, etc.) and folds them all
   * onto the canonical MSilo#/CSilo# form before querying. Non-silo names
   * (UHT1, BlendTank1A) are skipped. The returned map is keyed by every
   * variant that was passed in so callers can look up by either raw or
   * canonical form — e.g. `out['RawMilkSilo5']` and `out['MSilo5']` both
   * resolve to the same config object.
   */
  async _readSiloProductConfigRaw(siloNames) {
    // canonical → list of raw variants that collapse onto it
    const byCanonical = {}
    for (const raw of siloNames || []) {
      if (typeof raw !== 'string') continue
      const trimmed = raw.trim()
      if (!trimmed) continue
      let canon = null
      const direct = trimmed.match(/^([mc])silo(\d+)$/i)
      if (direct) {
        canon = `${direct[1].toUpperCase()}Silo${direct[2]}`
      } else {
        const n = trimmed.match(/(\d+)\s*$/)?.[1]
        if (!n) continue
        const low = trimmed.toLowerCase()
        if (low.includes('cream')) canon = `CSilo${n}`
        else if (low.includes('milk') || low.includes('skim')) canon = `MSilo${n}`
        else continue
      }
      ;(byCanonical[canon] = byCanonical[canon] || []).push(trimmed)
    }
    const canonList = Object.keys(byCanonical)
    if (canonList.length === 0) return {}
    const fqns = canonList.flatMap(c => [
      `${c.toUpperCase()}${TAGS.SILO_PRODUCT_INDEX}`,
      `${c.toUpperCase()}${TAGS.SILO_PRODUCT_NAME}`,
    ])
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))
    const out = {}
    canonList.forEach((c, i) => {
      const cfg = {
        productIndex: values[i * 2]?.Value || 0,
        productName: values[i * 2 + 1]?.Text || '',
      }
      out[c] = cfg
      for (const raw of byCanonical[c]) out[raw] = cfg
    })
    return out
  }

  // ── Bulk milk flow ─────────────────────────────────────────────────

  /**
   * Read the cream/skim flow counters and compute deltas since the
   * previous poll. These counters accumulate within a batch and reset
   * between batches, so a negative delta indicates a batch boundary —
   * we skip that reading and re-seed.
   */
  async getBulkMilkFlowData(since) {
    const [creamPv, skimPv] = await Promise.all([
      this._getCurrentValue(TAGS.CREAM_FLOW_TOTAL, { verbose: false }),
      this._getCurrentValue(TAGS.SKIM_FLOW_TOTAL, { verbose: false }),
    ])

    const creamTotal = creamPv?.Value ?? 0
    const skimTotal = skimPv?.Value ?? 0

    // First poll — seed the baseline, don't emit a reading
    if (this._prevCreamTotal === null) {
      this._prevCreamTotal = creamTotal
      this._prevSkimTotal = skimTotal
      return []
    }

    const creamDelta = creamTotal - this._prevCreamTotal
    const skimDelta = skimTotal - this._prevSkimTotal

    // Update baseline
    this._prevCreamTotal = creamTotal
    this._prevSkimTotal = skimTotal

    // Counter reset (batch boundary) — re-seed, skip this reading
    if (creamDelta < 0 || skimDelta < 0) {
      console.log('[RestProvider] Flow counter reset (batch boundary), re-seeding')
      return []
    }

    // No change = no flow = nothing to report
    if (creamDelta === 0 && skimDelta === 0) return []

    return [{
      timestamp: new Date(creamPv?.DateTime || Date.now()),
      creamVolume: creamDelta,
      skimVolume: skimDelta,
      creamTotal,
      skimTotal,
    }]
  }
  // ── Blend tank status ─────────────────────────────────────────────

  /**
   * Read current blend tank status for all 4 tanks.
   * Uses NOTE_STRING (product name from Atlas) + tank weight for activity detection.
   * MES WO tags (CurrentWO, JobRunning) are stale and not used.
   */
  async getBlendTankStatus() {
    const tanks = ['BlendTank1A', 'BlendTank1B', 'BlendTank2A', 'BlendTank2B']
    const suffixes = [
      TAGS.BT_NOTE_STRING, TAGS.BT_WEIGHT_LBS, TAGS.BT_BATCH_SIZE,
      TAGS.BT_FROM_ENT, TAGS.BT_TO_ENT,
    ]

    const results = await Promise.all(tanks.map(async (tankId) => {
      const fqns = suffixes.map(s => `${tankId}${s}`)
      const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))
      const val = (i) => values[i]?.Value ?? 0
      const txt = (i) => values[i]?.Text ?? ''

      return {
        tankId,
        productName: txt(0),       // NOTE_STRING — Atlas product name
        weightLbs: val(1),          // 100LT.SCL_LBS — tank weight
        batchSize: val(2),
        fromEntName: txt(3),
        toEntName: txt(4),
      }
    }))

    return results
  }

  // ── Milk/cream line totalizers ──────────────────────────────────────

  /**
   * Read current status for all milk and cream lines.
   * Includes totalizer, product info, source silo, destination, mode, and status flags.
   */
  async getMilkLineStatus() {
    const lineNames = ['ML1', 'ML2', 'ML3', 'ML4', 'CL1', 'CL2']
    const suffixes = [
      TAGS.LINE_TOTALIZER,        // 0  - batch totalizer (LBS)
      TAGS.LINE_PRODUCT_NAME,     // 1  - product name from silo
      TAGS.LINE_PRODUCT_CODE,     // 2  - product code
      TAGS.LINE_SILO_NAME,        // 3  - source silo name
      TAGS.LINE_REQUESTED_BY,     // 4  - destination vessel
      TAGS.LINE_REQUESTED_TARGET, // 5  - LBS requested
      TAGS.LINE_MODE,             // 6  - mode string
      TAGS.LINE_STEP_NAME,        // 7  - batch step name
      TAGS.LINE_ACTIVE,           // 8  - is active
      TAGS.LINE_TARGET_COMPLETE,  // 9  - target complete flag
      TAGS.LINE_DENSITY,          // 10 - product density PPG
    ]

    // Build all FQNs and fetch in parallel
    const fqns = lineNames.flatMap(ln => suffixes.map(s => `${ln}${s}`))
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))

    const perLine = suffixes.length
    return lineNames.map((line, i) => {
      const offset = i * perLine
      const val = (idx) => values[offset + idx]?.Value ?? 0
      const txt = (idx) => values[offset + idx]?.Text ?? ''

      return {
        line,
        totalizerLbs: val(0),
        productName: txt(1),
        productCode: txt(2),
        siloName: txt(3),
        requestedBy: txt(4),       // destination vessel (e.g. "BlendTank1A", "UHT1")
        requestedTargetLbs: val(5),
        mode: txt(6),
        stepName: txt(7),
        active: !!val(8),
        targetComplete: !!val(9),
        density: val(10),
      }
    })
  }

  // ── Silos, UHTs, Surge tanks — live status for the dashboard ────────

  /**
   * Read current gallons, lbs, and product info for every silo.
   * Covers 5 raw milk silos (MSILO1-5) + 3 cream silos (CSILO1-3).
   *
   * Level % is derived from gallons / capacity since the canonical `LevelValue`
   * tag on these silos returns bad OPC quality. Capacities below are plausible
   * defaults — adjust if the real values differ.
   *
   * CreamBalance is excluded because all four of its Historian tags
   * (.GALLONS, .LBS, .LevelValue, .TempValue) return OpcQuality=0.
   */
  async getSiloStatus() {
    // prefixLower is used for the underscore-suffix tags (Gallons.Value / LBS.Value)
    // prefixUpper is used for ProductName / ProductDensity
    const SILO_CAPACITY_GAL = { milk: 60000, cream: 20000 }
    const silos = [
      { siloId: 'MSilo1', prefixLower: 'MSilo1', prefixUpper: 'MSILO1', kind: 'milk' },
      { siloId: 'MSilo2', prefixLower: 'MSilo2', prefixUpper: 'MSILO2', kind: 'milk' },
      { siloId: 'MSilo3', prefixLower: 'MSilo3', prefixUpper: 'MSILO3', kind: 'milk' },
      { siloId: 'MSilo4', prefixLower: 'MSilo4', prefixUpper: 'MSILO4', kind: 'milk' },
      { siloId: 'MSilo5', prefixLower: 'MSilo5', prefixUpper: 'MSILO5', kind: 'milk' },
      { siloId: 'CSilo1', prefixLower: 'CSilo1', prefixUpper: 'CSILO1', kind: 'cream' },
      { siloId: 'CSilo2', prefixLower: 'CSilo2', prefixUpper: 'CSILO2', kind: 'cream' },
      { siloId: 'CSilo3', prefixLower: 'CSilo3', prefixUpper: 'CSILO3', kind: 'cream' },
    ]

    const fqnsPerSilo = s => [
      `${s.prefixLower}${TAGS.SILO_GALLONS}`,      // 0 — e.g. MSilo1_Gallons.Value
      `${s.prefixLower}${TAGS.SILO_LBS}`,          // 1 — e.g. MSilo1_LBS.Value
      `${s.prefixUpper}${TAGS.SILO_PRODUCT_NAME}`, // 2 — e.g. MSILO1.ProductName
      `${s.prefixUpper}${TAGS.SILO_DENSITY}`,      // 3 — e.g. MSILO1.ProductDensity
      `${s.prefixUpper}${TAGS.SILO_PRODUCT_INDEX}`,// 4 — e.g. MSILO1.IndexSelectRead
    ]
    const perSilo = 5

    const fqns = silos.flatMap(fqnsPerSilo)
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))

    return silos.map((s, i) => {
      const offset = i * perSilo
      const val = (idx) => values[offset + idx]?.Value ?? 0
      const txt = (idx) => values[offset + idx]?.Text ?? ''
      const capacity = SILO_CAPACITY_GAL[s.kind] ?? 0
      const gallons = Math.max(0, val(0))  // PLC sometimes reports small negative calibration values
      const lbs = Math.max(0, val(1))

      return {
        siloId: s.siloId,
        kind: s.kind,
        gallons,
        lbs,
        capacityGal: capacity,
        levelPct: capacity > 0 ? (gallons / capacity) * 100 : 0,
        tempF: 0,  // TempValue tag returns bad quality; kept in shape for future use
        productName: txt(2),
        density: val(3),
        productIndex: val(4) || 0,
      }
    })
  }


  /**
   * Read current status for both UHT pasteurizers.
   * Exposes the run/step state plus the current WO and item.
   */
  async getUhtStatus() {
    const uhts = ['UHT1', 'UHT2']
    const suffixes = [
      TAGS.UHT_ACTIVE,        // 0 — Discrete
      TAGS.UHT_JOB_RUNNING,   // 1 — Discrete
      TAGS.UHT_CURRENT_WO,    // 2 — String
      TAGS.UHT_CURRENT_ITEM,  // 3 — String
      TAGS.UHT_GAL_ACTUAL,    // 4 — Analog (gal)
      TAGS.UHT_STEP_NUM,      // 5 — Analog (step number)
    ]

    const fqns = uhts.flatMap(u => suffixes.map(s => `${u}${s}`))
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))

    const perUht = suffixes.length
    return uhts.map((uhtId, i) => {
      const offset = i * perUht
      const val = (idx) => values[offset + idx]?.Value ?? 0
      const txt = (idx) => values[offset + idx]?.Text ?? ''

      return {
        uhtId,
        active: !!val(0),
        jobRunning: !!val(1),
        currentWO: txt(2),
        currentItem: txt(3),
        galActual: val(4),
        stepNum: val(5),
      }
    })
  }

  /**
   * Read current status for the four aseptic surge tanks (ST81-84).
   * Each tank has a main level transmitter (LT8{N}01) and a small balance-tank
   * transmitter (LT8{N}66) — we expose both since they're both on the HMI.
   */
  async getSurgeTankStatus() {
    const tanks = [
      { tankId: 'ST81', num: 1 },
      { tankId: 'ST82', num: 2 },
      { tankId: 'ST83', num: 3 },
      { tankId: 'ST84', num: 4 },
    ]
    // Per-tank FQN list. Level + gallons use the double-`ThermaRoute.` path;
    // everything else is under single-prefix `ThermaRoute.ST{TID}_*`.
    const fqnsPerTank = t => {
      const sub = s => s.replace('{TID}', t.tankId).replace('{N}', t.num)
      return [
        sub(TAGS.ST_MAIN_LEVEL_FQN),                       // 0 — main %
        sub(TAGS.ST_MAIN_GAL_FQN),                         // 1 — main gal
        `ThermaRoute.${t.tankId}${TAGS.ST_PRODUCT_DESC}`,  // 2 — string
        `ThermaRoute.${t.tankId}${TAGS.ST_STATE}`,         // 3 — state number
        `ThermaRoute.${t.tankId}${TAGS.ST_TANK_EMPTY}`,    // 4 — discrete
        `ThermaRoute.${t.tankId}${TAGS.ST_CONNECTED}`,     // 5 — discrete
        `ThermaRoute.${t.tankId}${TAGS.ST_STER_PROD_BARR}`,// 6 — discrete
        `ThermaRoute.${t.tankId}${TAGS.ST_FILLING_OK}`,    // 7 — discrete
      ]
    }
    const perTank = 8

    const fqns = tanks.flatMap(fqnsPerTank)
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))

    return tanks.map((t, i) => {
      const offset = i * perTank
      const val = (idx) => values[offset + idx]?.Value ?? 0
      const txt = (idx) => values[offset + idx]?.Text ?? ''

      return {
        tankId: t.tankId,
        mainLevelPct: val(0),
        mainGallons: val(1),
        productDesc: txt(2),
        state: val(3),
        empty: !!val(4),
        connected: !!val(5),
        sterProdBarrOK: !!val(6),
        fillingOK: !!val(7),
      }
    })
  }
}

module.exports = RestProvider
