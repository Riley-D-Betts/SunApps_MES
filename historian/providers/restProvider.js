const BaseProvider = require('./baseProvider')
const config = require('../../config')
const httpntlm = require('httpntlm')
const { PROCESS_STEP_NAMES, CIP_STEP_NAMES } = require('./uhtStepNames')

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

// PROCESS step 24 — the only step where the UHT is actually pushing sterile
// product downstream into a surge tank. FT1102 still reads ~100 GPM during the
// "Sterile on Water" / phase-change steps, but that flow is recirculating water
// bound for drain, not milk reaching the tank. Milk integration is gated on
// this step so the totalizer (and the surge WO issues built off it) only counts
// real product. Matches the batch-start gate in surgeTankJob.
const STERILE_ON_PRODUCT_STEP = 'Sterile on Product'

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
  SEP_FEED_PERMIT:    'SEPSTAT.FEEDPERMIT',
  SEP_CREAM_FLOW:     'SEPSTAT.CREAMFLOW',       // GPM
  SEP_SKIM_FLOW:      'SEPSTAT.SKIMFLOW',         // GPM
  SEP_MOTOR_RPM:      'SEPSTAT.MOTORSPEEDPROX',   // RPM
  SEP_FEED_TOTAL:     'Product.SepFeedTotal',      // LBS — live separator feed totalizer
  SEP_CIPCHEM_REQ:    'SEPSTAT.CIPCHEMMODE_REQ',   // bool — operator/recipe is requesting CIP chemical mode
  SEP_CIPRINSE_REQ:   'SEPSTAT.CIPRINSEMODE_REQ',  // bool — operator/recipe is requesting CIP rinse mode

  // Blend tank tags (per-tank prefix substituted at query time)
  // NOTE: MES WO tags (CurrentWO, JobRunning, etc.) are stale — plant uses Atlas, not MES.
  // NOTE_STRING is the live product name written by Atlas via PLC.
  BT_NOTE_STRING:      '.NOTE_STRING',
  BT_WEIGHT_LBS:       '.100LT.SCL_LBS',
  BT_BATCH_SIZE:       '.BatchSize',
  BT_FROM_ENT:         '.FromEntName',
  BT_TO_ENT:           '.ToEntName',
  // String — Atlas WO lifecycle state. Observed values: "Running" (active),
  // "Complete" (between batches). CIP/Idle values not yet sampled. Treat
  // "Running" as the only production-eligible state. Confirmed working on
  // all four tanks; the Proc_Proc1_BT*_IO.* namespace is missing on BT2A/2B.
  BT_CURRENT_WO_STATE: '.CurrentWOState',


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
  // Memory ("MEM") tags — SCADA latches the just-completed flow's values on
  // these after the live tags clear to "None". Reliable source for tail-catcher
  // routing after a totalizer reset, when the live REQUESTEDBY/SILONAME are
  // already empty.
  LINE_MEM_REQUESTED_BY:   '.MEMREQUESTEDBY',
  LINE_MEM_SILO_NAME:      '.MEMSILONAME',
  LINE_MEM_PRODUCT_NAME:   '.MEMSILOPRODUCTNAME',

  // Silo tags — the .GALLONS/.LBS/.LevelValue/.TempValue tags exist under the
  // UPPERCASE prefix but are bad quality (OpcQuality=0). The PLC writes live
  // data to the underscore/CamelCase form: `MSilo{N}_Gallons.Value` etc.
  // Product name + density use the UPPERCASE prefix.
  SILO_GALLONS:       '_Gallons.Value',   // suffix on lowercase-name prefix (e.g. MSilo1)
  SILO_LBS:           '_LBS.Value',       // suffix on lowercase-name prefix
  SILO_PRODUCT_NAME:  '.ProductName',     // suffix on UPPERCASE prefix (e.g. MSILO1)
  SILO_DENSITY:       '.ProductDensity',  // suffix on UPPERCASE prefix (PPG)
  SILO_PRODUCT_INDEX: '.IndexSelectRead', // suffix on UPPERCASE prefix — the 1-40 code from the Standardization HMI Product Config table

  // UHT tags (per-UHT prefix, e.g. UHT1).
  // NOTE: UHT1 separates Mode bits with `.` (Mode.CIP) while UHT2 uses `_`
  // (Mode_CIP). The mode FQN list is built per-UHT in getUhtStatus().
  UHT_ACTIVE:         '.Active',
  UHT_JOB_RUNNING:    '.JobRunning',
  UHT_CURRENT_WO:     '.CurrentWO',
  UHT_CURRENT_ITEM:   '.CurrentItem',
  UHT_STEP_NUM:       '.StepNum',
  UHT_PROD_STEP:      '.Prod_Step',
  UHT_CIP_STEP:       '.CIP_Step',
  UHT_FROM_ENT:       '.FromEntName',
  UHT_TO_ENT:         '.ToEntName',
  UHT_RECIPE_TEXT:    '.Recipe_Text',           // string — recipe name e.g. "White Milk"
  UHT_WO_STATE:       '.CurrentWOState',        // string — WO state text from PLC
  UHT_PROD_TOTAL:     '.FT1202TotalProd',       // analog — process WATER totalizer during production (not milk)
  UHT_CIP_TOTAL:      '.FT1202TotalCIP',        // analog — CIP water gallons totalizer
  UHT_INLET_FLOW:     '.FT1102_Output',          // analog — timing flow meter, milk inlet GPM

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

  // UHT → Surge tank routing. The plant exposes one Connection_Code per
  // (UHT, ST) pair. A non-zero code means the operator has routed that UHT
  // to that surge tank — i.e. the FG from a UHT-direct run will land there.
  UHT_ST_CONNECTION_FQN: 'ThermaRoute.{UHT}_{ST}_Connection_Code',
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

    // Per-surge-tank previous gallons for inflow delta tracking. Populated on
    // first poll, then each subsequent poll computes (current - prev) so the
    // dashboard can show "+X gal this tick" per tank.
    this._prevSurgeGal = { ST81: null, ST82: null, ST83: null, ST84: null }

    // Previous value of the XFR TransferComplete bit. Used to detect the 0→1
    // rising edge that signals a completed separation batch. Null on first poll
    // so a TransferComplete=1 at startup also triggers batch building (handles
    // batches that completed while the service was down).
    this._prevTransferComplete = null

    // Software milk-flow totalizer per UHT. Since FT1102 only exposes a live
    // GPM rate (no hardware totalizer exists), we integrate it over time while
    // the UHT is in PROCESS mode. Resets to 0 on each IDLE→PROCESS transition
    // so galActual reflects the current run only.
    this._uhtMilkGal  = { UHT1: 0, UHT2: 0 }
    this._uhtPollMs   = { UHT1: null, UHT2: null }
    this._uhtPrevMode = { UHT1: 'IDLE', UHT2: 'IDLE' }
  }

  // Current time hook. HistoricalProvider overrides to return sim time so the
  // UHT software-totalizer integrates against sim-elapsed intervals.
  _now() { return Date.now() }

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
          const tail = (res.body && res.body.length > 0) ? ` body=${res.body.slice(0, 300)}` : ''
          return reject(new Error(`Historian API ${res.statusCode} on ${url}${tail}`))
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
   * trigger via the Real-time Raw endpoint (0→1 rising-edge detection).
   *
   * ProcessValues has a ~1h DST timestamp lag that places recent events
   * outside the lastPollTime query window, causing them to be silently
   * missed. The Raw endpoint returns the current tag value without that lag.
   * We track the previous value between calls and fire when we see 0→1.
   * A null previous value (first poll / service start) also triggers if the
   * bit is already 1, handling batches that completed while the service was
   * down before the PLC reset the bit.
   */
  async getSeparatorBatches(since) {
    const xfrPv = await this._getCurrentValue(TAGS.SEP_XFR_TRANSFER_COMPLETE, { verbose: false })
    const currentXfr = xfrPv?.Value ?? 0
    const prevXfr = this._prevTransferComplete
    this._prevTransferComplete = currentXfr

    const risingEdge = currentXfr === 1 && (prevXfr === 0 || prevXfr === null)
    if (!risingEdge) return []

    const transferTime = xfrPv?.DateTime ? new Date(xfrPv.DateTime) : new Date()
    const reason = prevXfr === null ? 'startup (TransferComplete already 1)' : '0→1 edge'
    console.log(`[RestProvider] TransferComplete detected (${reason}) at ${transferTime.toISOString()}`)

    try {
      const batch = await this._buildBatchFromCurrentValues(transferTime)
      return batch ? [batch] : []
    } catch (err) {
      console.error(`[RestProvider] Failed to build batch from current tags:`, err.message)
      return []
    }
  }

  /**
   * Build a separation batch record from the CURRENT values of the XFR tags.
   * Called immediately when TransferComplete goes 1 — the XFR tags still hold
   * the just-completed batch's data and won't reset until the next batch starts.
   * Uses _getCurrentValue (Raw endpoint) so there is no DST-lag concern.
   */
  async _buildBatchFromCurrentValues(transferTime) {
    const fqns = [
      TAGS.SEP_XFR_QTY_ACTUAL,   // 0
      TAGS.SEP_XFR_QTY_TARGET,   // 1
      TAGS.SEP_XFR_SOURCE,       // 2
      TAGS.SEP_XFR_ITEM_ID,      // 3
      TAGS.SEP_XFR_NAME,         // 4
      TAGS.SEP_XFR_EU,           // 5
      TAGS.SEP_XFR_DEST_0,       // 6
      TAGS.SEP_XFR_DEST_1,       // 7
      TAGS.SEP_XFR_DEST_2,       // 8
      TAGS.SEP_XFR_DEST_3,       // 9
      TAGS.CREAM_FLOW_TOTAL,     // 10
      TAGS.SKIM_FLOW_TOTAL,      // 11
    ]
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))
    const val = (i) => values[i]?.Value ?? 0
    const txt = (i) => values[i]?.Text ?? ''

    const source = txt(2)
    if (!source) {
      console.log(`[RestProvider] _buildBatchFromCurrentValues: no XFR source — skipping`)
      return null
    }

    const batchId = `XFR-${transferTime.getTime()}`
    const inputVolume = val(0)
    const creamGallons = val(10)
    const skimGallons = val(11)
    const creamVolume = creamGallons * CREAM_DENSITY_PPG
    const skimVolume = skimGallons * SKIM_DENSITY_PPG
    const destinations = [txt(6), txt(7), txt(8), txt(9)].filter(Boolean)
    const siloProductConfig = await this._readSiloProductConfigRaw([source, ...destinations])

    console.log(`[RestProvider] Batch ${batchId}: ${source} → ${destinations.join(', ') || '?'}, input=${inputVolume.toFixed(1)} LBS, cream=${creamGallons.toFixed(1)} gal (${creamVolume.toFixed(1)} LBS), skim=${skimGallons.toFixed(1)} gal (${skimVolume.toFixed(1)} LBS)`)

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
      itemId: txt(3),
      transferName: txt(4),
      unit: txt(5),
      targetVolume: val(1),
    }
  }

  /**
   * Single-tick snapshot of every separator signal the state machine needs.
   * Replaces the old getSeparatorBatches+getSeparatorStatus pair: the
   * TransferComplete rising edge becomes one of several end signals rather
   * than the sole trigger. See BATCH_LIFECYCLE_PLAN.md §2 for the state
   * machine that consumes this.
   */
  async getSeparatorTickSnapshot() {
    const xfrPv = await this._getCurrentValue(TAGS.SEP_XFR_TRANSFER_COMPLETE, { verbose: false })
    const currentXfr = xfrPv?.Value ?? 0
    const prevXfr = this._prevTransferComplete
    this._prevTransferComplete = currentXfr
    const xfrRising = currentXfr === 1 && (prevXfr === 0 || prevXfr === null)

    const fqns = [
      TAGS.SEP_FEED_PERMIT,      // 0
      TAGS.SEP_MOTOR_RPM,        // 1
      TAGS.SEP_CIPCHEM_REQ,      // 2
      TAGS.SEP_CIPRINSE_REQ,     // 3
      TAGS.SEP_FEED_TOTAL,       // 4
      TAGS.SEP_CREAM_FLOW,       // 5
      TAGS.SEP_SKIM_FLOW,        // 6
      TAGS.CREAM_FLOW_TOTAL,     // 7
      TAGS.SKIM_FLOW_TOTAL,      // 8
      TAGS.SEP_XFR_SOURCE,       // 9
      TAGS.SEP_XFR_ITEM_ID,      // 10
      TAGS.SEP_XFR_NAME,         // 11
      TAGS.SEP_XFR_EU,           // 12
      TAGS.SEP_XFR_QTY_TARGET,   // 13
      TAGS.SEP_XFR_DEST_0,       // 14
      TAGS.SEP_XFR_DEST_1,       // 15
      TAGS.SEP_XFR_DEST_2,       // 16
      TAGS.SEP_XFR_DEST_3,       // 17
    ]
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))
    const val = (i) => values[i]?.Value ?? 0
    const txt = (i) => values[i]?.Text ?? ''

    const xfrSource = txt(9)
    const xfrDestinations = [txt(14), txt(15), txt(16), txt(17)]
    const populatedSilos = [xfrSource, ...xfrDestinations].filter(Boolean)
    const siloProductConfig = populatedSilos.length > 0
      ? await this._readSiloProductConfigRaw(populatedSilos)
      : {}

    const creamTotalGal = val(7)
    const skimTotalGal = val(8)

    return {
      pollTime: new Date(),
      feedPermit: !!val(0),
      motorRpm: val(1),
      cipChemReq: !!val(2),
      cipRinseReq: !!val(3),
      feedTotalLbs: val(4),
      creamFlowGpm: val(5),
      skimFlowGpm: val(6),
      creamTotalGal,
      skimTotalGal,
      creamTotalLbs: creamTotalGal * CREAM_DENSITY_PPG,
      skimTotalLbs: skimTotalGal * SKIM_DENSITY_PPG,
      xfrSource,
      xfrItemId: txt(10),
      xfrTransferName: txt(11),
      xfrUnit: txt(12),
      xfrQtyTarget: val(13),
      xfrDestinations,
      xfrTransferCompleteRising: xfrRising,
      siloProductConfig,
    }
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
      TAGS.BT_FROM_ENT, TAGS.BT_TO_ENT, TAGS.BT_CURRENT_WO_STATE,
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
        currentWOState: txt(5),     // CurrentWOState — "Running" (active) | "Complete" | …
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
      TAGS.LINE_TOTALIZER,         // 0  - batch totalizer (LBS)
      TAGS.LINE_PRODUCT_NAME,      // 1  - product name from silo
      TAGS.LINE_PRODUCT_CODE,      // 2  - product code
      TAGS.LINE_SILO_NAME,         // 3  - source silo name
      TAGS.LINE_REQUESTED_BY,      // 4  - destination vessel (live)
      TAGS.LINE_REQUESTED_TARGET,  // 5  - LBS requested
      TAGS.LINE_MODE,              // 6  - mode string
      TAGS.LINE_STEP_NAME,         // 7  - batch step name
      TAGS.LINE_ACTIVE,            // 8  - is active
      TAGS.LINE_TARGET_COMPLETE,   // 9  - target complete flag
      TAGS.LINE_DENSITY,           // 10 - product density PPG
      TAGS.LINE_MEM_REQUESTED_BY,  // 11 - destination latched after flow ended
      TAGS.LINE_MEM_SILO_NAME,     // 12 - source silo latched after flow ended
      TAGS.LINE_MEM_PRODUCT_NAME,  // 13 - product latched after flow ended
      TAGS.LINE_MEM_TOTALIZER,     // 14 - previous batch total LBS
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
        memRequestedBy: txt(11),
        memSiloName: txt(12),
        memProductName: txt(13),
        memTotalizerLbs: val(14),
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
   * Exposes the run/step state, current WO/item, the routed source/destination
   * vessels (FromEntName/ToEntName), and a derived mode label (PROCESS/CIP/
   * DD_INH/IDLE) computed from the three Mode discrete bits.
   *
   * UHT1 names mode bits as `Mode.CIP` (dot); UHT2 uses `Mode_CIP` (underscore).
   * The suffix list is built per-UHT so the right separator is used.
   *
   * galActual: in PROCESS mode this is a software-integrated milk gallon total
   * (FT1102_Output × elapsed time), reset on each new run. In CIP mode it is
   * the hardware FT1202TotalCIP water counter. FT1202TotalProd is process water
   * (not milk) so it is fetched but not exposed.
   */
  async getUhtStatus() {
    const uhts = ['UHT1', 'UHT2']

    // Per-UHT FQN list. Slots 0-13 are shared shape; slots 14-16 are the
    // three Mode discrete bits whose separator differs per UHT (`.` on UHT1,
    // `_` on UHT2).
    const fqnsForUht = (u) => {
      const sep = u === 'UHT2' ? '_' : '.'
      return [
        `${u}${TAGS.UHT_ACTIVE}`,        // 0
        `${u}${TAGS.UHT_JOB_RUNNING}`,   // 1
        `${u}${TAGS.UHT_CURRENT_WO}`,    // 2
        `${u}${TAGS.UHT_CURRENT_ITEM}`,  // 3
        `${u}${TAGS.UHT_STEP_NUM}`,      // 4
        `${u}${TAGS.UHT_PROD_STEP}`,     // 5
        `${u}${TAGS.UHT_CIP_STEP}`,      // 6
        `${u}${TAGS.UHT_FROM_ENT}`,      // 7
        `${u}${TAGS.UHT_TO_ENT}`,        // 8
        `${u}${TAGS.UHT_RECIPE_TEXT}`,   // 9
        `${u}${TAGS.UHT_WO_STATE}`,      // 10
        `${u}${TAGS.UHT_PROD_TOTAL}`,    // 11 — process water, fetched but not used for milk
        `${u}${TAGS.UHT_CIP_TOTAL}`,     // 12 — CIP water totalizer
        `${u}${TAGS.UHT_INLET_FLOW}`,    // 13 — FT1102_Output, milk inlet GPM
        `${u}.Mode${sep}Process`,         // 14
        `${u}.Mode${sep}CIP`,             // 15
        `${u}.Mode${sep}DD${sep}INH`,     // 16
      ]
    }
    const perUht = 17

    // Blend-tank → TSTAT outlet valve state tags. TSTAT-1 feeds UHT1; TSTAT-2
    // feeds UHT2. UHT1 valves are at indices 0-3, UHT2 valves at indices 4-7.
    const BT_NAMES  = ['BlendTank1A', 'BlendTank1B', 'BlendTank2A', 'BlendTank2B']
    const valveFqns = [
      'BlendSystem.VG_8014MP_Y1_STA',  // BT1A → TSTAT-1 → UHT1
      'BlendSystem.VG_8024MP_Y1_STA',  // BT1B → TSTAT-1 → UHT1
      'BlendSystem.VG_8034MP_Y1_STA',  // BT2A → TSTAT-1 → UHT1
      'BlendSystem.VG_8044MP_Y1_STA',  // BT2B → TSTAT-1 → UHT1
      'BlendSystem.VG_8013MP_Y1_STA',  // BT1A → TSTAT-2 → UHT2
      'BlendSystem.VG_8023MP_Y1_STA',  // BT1B → TSTAT-2 → UHT2
      'BlendSystem.VG_8033MP_Y1_STA',  // BT2A → TSTAT-2 → UHT2
      'BlendSystem.VG_8043MP_Y1_STA',  // BT2B → TSTAT-2 → UHT2
    ]

    const fqns = [...uhts.flatMap(fqnsForUht), ...valveFqns]
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))
    const valveOffset = uhts.length * perUht

    return uhts.map((uhtId, i) => {
      const offset = i * perUht
      const val = (idx) => values[offset + idx]?.Value ?? 0
      const txt = (idx) => values[offset + idx]?.Text ?? ''

      const modeProcess = !!val(14)
      const modeCip     = !!val(15)
      const modeDdInh   = !!val(16)
      let mode = 'IDLE'
      if (modeCip)          mode = 'CIP'
      else if (modeProcess) mode = 'PROCESS'
      else if (modeDdInh)   mode = 'DD_INH'

      // Pick the step number that matches the active mode so the UI never
      // shows a stale CIP step while running production (and vice versa).
      const stepNum = mode === 'CIP' ? val(6) : (mode === 'PROCESS' ? val(5) : val(4))

      const stepName = mode === 'CIP'
        ? (CIP_STEP_NAMES[stepNum] ?? `CIP Step ${stepNum}`)
        : (PROCESS_STEP_NAMES[stepNum] ?? `Step ${stepNum}`)

      // Software-integrate milk flow (FT1102_Output, slot 13) ONLY while the
      // UHT is on "Sterile on Product" — the step where milk actually reaches
      // the surge tank. Accumulating across every PROCESS step counted the
      // ~100 GPM water recirculation during "Sterile on Water" / phase-change
      // and divert as milk, inflating the totalizer indefinitely (WO 1573 hit
      // >1M lb on a 10k-gal tank). We still advance lastPollMs every poll, so
      // when product flow resumes only one poll-interval is added — never the
      // whole gap. Reset on each IDLE/CIP→PROCESS transition so galActual
      // reflects only the current run's milk volume.
      //
      // Floor each contribution at a strictly-positive (gpm, elapsed): a
      // milk-consumed totalizer must be monotonic. getUhtStatus() is called
      // concurrently by several jobs (equipment/surge/tank-at-rest) that share
      // this instance, so a racing call can stamp _uhtPollMs newer than this
      // call's nowMs and make elapsedMin negative — left unguarded that drove
      // the totalizer to large NEGATIVE values (observed -394k gal), which the
      // surge issue baseline then read as a huge positive delta.
      const nowMs = this._now()
      const prevMode   = this._uhtPrevMode[uhtId]
      const lastPollMs = this._uhtPollMs[uhtId]
      const sterileOnProduct = mode === 'PROCESS' && stepName === STERILE_ON_PRODUCT_STEP
      if (mode === 'PROCESS') {
        if (prevMode !== 'PROCESS') {
          this._uhtMilkGal[uhtId] = 0
        } else if (sterileOnProduct && lastPollMs != null) {
          const elapsedMin = (nowMs - lastPollMs) / 60000
          const gpm = val(13)
          if (gpm > 0 && elapsedMin > 0) this._uhtMilkGal[uhtId] += gpm * elapsedMin
        }
      }
      this._uhtPollMs[uhtId]   = nowMs
      this._uhtPrevMode[uhtId] = mode

      const galActual = mode === 'CIP' ? val(12) : this._uhtMilkGal[uhtId]

      // UHT{N}.FromEntName tag is often unpopulated (PLC writes null).
      // Fall back to reading which blend-tank→TSTAT outlet valve is open.
      // Valve index group: UHT1 uses slots 0-3, UHT2 uses slots 4-7.
      let fromEntName = txt(7)
      if (!fromEntName) {
        const groupOffset = valveOffset + (i * 4)
        fromEntName = BT_NAMES.find((_, vi) => !!values[groupOffset + vi]?.Value) || ''
      }

      return {
        uhtId,
        active: !!val(0),
        jobRunning: !!val(1),
        currentWO: txt(2),
        currentItem: txt(3),
        galActual,
        flowGpm: val(13),
        stepNum,
        stepName,
        mode,
        recipeText: txt(9),
        woState: txt(10),
        fromEntName,
        toEntName: txt(8),
      }
    })
  }

  /**
   * Resolve the current UHT → Surge tank routing for both UHTs in a single
   * batch of 8 tag reads. Connection_Code === 1 means the UHT is physically
   * plumbed to that surge tank. UHT1 connects to ST81+ST82; UHT2 to ST83+ST84.
   *
   * Returns: { UHT1: string[] | null, UHT2: string[] | null }
   * e.g. { UHT1: ['ST81','ST82'], UHT2: ['ST83','ST84'] }
   *
   * The caller is responsible for determining which of the connected tanks is
   * actively being filled (use level-delta from getSurgeTankStatus pollDeltaGal).
   */
  async getUhtSurgeTankRouting() {
    const uhts = ['UHT1', 'UHT2']
    const sts = ['ST81', 'ST82', 'ST83', 'ST84']
    const fqns = uhts.flatMap(u => sts.map(st =>
      TAGS.UHT_ST_CONNECTION_FQN.replace('{UHT}', u).replace('{ST}', st)
    ))
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))

    const out = {}
    uhts.forEach((u, ui) => {
      const connected = sts.filter((_, si) => (values[ui * 4 + si]?.Value ?? 0) === 1)
      out[u] = connected.length > 0 ? connected : null
    })
    return out
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
        // 8..12 — Sel{1-5}_Filling latch: tank is routed to filler line 1..5.
        // The latch holds for the whole run (set on connect, cleared on
        // disconnect/CIP), so it identifies WHICH filler is consuming this tank,
        // not the moment-to-moment draw. Used to detect concurrent fill+drain.
        ...[1, 2, 3, 4, 5].map(s => `ThermaRoute.${t.tankId}_Sel${s}_Filling_Indicator`),
      ]
    }
    const perTank = 13

    const fqns = tanks.flatMap(fqnsPerTank)
    const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))

    return tanks.map((t, i) => {
      const offset = i * perTank
      const val = (idx) => values[offset + idx]?.Value ?? 0
      const txt = (idx) => values[offset + idx]?.Text ?? ''

      const mainGallons = val(1)
      // Inflow delta — positive means UHT pushed more milk in since last
      // poll, negative means filler pulled more out. Null on first poll.
      const prevGal = this._prevSurgeGal[t.tankId]
      const pollDeltaGal = prevGal == null ? null : mainGallons - prevGal
      this._prevSurgeGal[t.tankId] = mainGallons

      // Filler lines this tank is routed to (Sel{1-5} latch === 1). When any is
      // set a filler is plumbed to the tank and may draw product out the bottom
      // while the UHT fills the top — the concurrent fill+drain that makes the
      // net-level-rise arrival under-count.
      const fillerLines = [1, 2, 3, 4, 5].filter(s => val(7 + s) === 1)

      return {
        tankId: t.tankId,
        mainLevelPct: val(0),
        mainGallons,
        pollDeltaGal,
        productDesc: txt(2),
        state: val(3),
        empty: !!val(4),
        connected: !!val(5),
        sterProdBarrOK: !!val(6),
        fillingOK: !!val(7),
        fillerLines,
        drainingToFiller: fillerLines.length > 0,
      }
    })
  }

  /**
   * Resolve which surge tank a given UHT is actively filling right now.
   *
   * Reads Connection_Code for all four (UHT, ST) pairs to find which tanks
   * are plumbed to this UHT (code === 1). Then fetches current gallons for
   * each connected tank and uses level-delta vs the last known reading to
   * identify the one that is rising — that's the active fill tank. Falls back
   * to the first connected tank if none is rising (e.g. between runs).
   *
   * Also returns the full connectedTanks list and the active tank's productDesc
   * so the caller can use it as the FG product name for a UHT-direct WO.
   * Returns null if no surge tank is connected to this UHT.
   */
  async getUhtDestinationSurgeTank(uhtId) {
    if (!/^UHT[12]$/i.test(uhtId)) return null
    const sts = ['ST81', 'ST82', 'ST83', 'ST84']
    const codeFqns = sts.map(st =>
      TAGS.UHT_ST_CONNECTION_FQN.replace('{UHT}', uhtId.toUpperCase()).replace('{ST}', st)
    )
    const codeValues = await Promise.all(codeFqns.map(fqn => this._getCurrentValue(fqn, { verbose: false })))

    const connectedTanks = sts.filter((_, i) => (codeValues[i]?.Value ?? 0) === 1)
    if (connectedTanks.length === 0) return null

    // Fetch current gallons for each connected tank
    const galValues = await Promise.all(connectedTanks.map(tid => {
      const n = sts.indexOf(tid) + 1
      const fqn = TAGS.ST_MAIN_GAL_FQN.replace('{TID}', tid).replace('{N}', n)
      return this._getCurrentValue(fqn, { verbose: false })
    }))

    // Active tank = connected tank with the highest positive level delta
    let activeTank = connectedTanks[0]
    let bestDelta = -Infinity
    connectedTanks.forEach((tid, i) => {
      const currentGal = galValues[i]?.Value ?? 0
      const delta = this._prevSurgeGal[tid] == null ? 0 : currentGal - this._prevSurgeGal[tid]
      this._prevSurgeGal[tid] = currentGal
      if (delta > bestDelta) { bestDelta = delta; activeTank = tid }
    })
    const surgeTankId = bestDelta > 0 ? activeTank : connectedTanks[0]

    const tankN = sts.indexOf(surgeTankId) + 1
    const [productPv, levelPv] = await Promise.all([
      this._getCurrentValue(`ThermaRoute.${surgeTankId}${TAGS.ST_PRODUCT_DESC}`, { verbose: false }),
      this._getCurrentValue(TAGS.ST_MAIN_LEVEL_FQN.replace('{TID}', surgeTankId).replace('{N}', tankN), { verbose: false }),
    ])
    return {
      surgeTankId,
      connectedTanks,
      productDesc: productPv?.Text || '',
      mainLevelPct: levelPv?.Value || 0,
    }
  }

  /**
   * Read the current value of the per-UHT software milk-flow totalizer (gal).
   * Note: this returns the cached accumulator, which is only updated when
   * getUhtStatus() runs. Callers that need a fresh value must await
   * getUhtStatus() first (equipment job polls every 5 s; surgeTankJob every
   * 10 s — combined update interval is ~5 s).
   */
  async getUhtMilkTotalizer(uhtId) {
    return this._uhtMilkGal?.[uhtId] || 0
  }

  /**
   * Read the current FromEntName tag for a UHT. This drives surge-tank
   * component resolution — value is either a silo (MSiloN or CSiloN) or
   * a blend tank (BlendTankNA/B).
   */
  async getUhtFromEntName(uhtId) {
    if (!/^UHT[12]$/i.test(uhtId)) return ''
    const fqn = `${uhtId.toUpperCase()}${TAGS.UHT_FROM_ENT}`
    const pv = await this._getCurrentValue(fqn, { verbose: false })
    return pv?.Text || ''
  }
}

module.exports = RestProvider
