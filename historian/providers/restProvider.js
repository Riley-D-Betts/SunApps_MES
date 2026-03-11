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

  // Flow totals (per-batch, reset between batches)
  CREAM_FLOW_TOTAL: 'Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized',
  SKIM_FLOW_TOTAL:  'Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized',

  // Blend tank MES tags (per-tank prefix substituted at query time)
  BT_CURRENT_WO:    '.CurrentWO',
  BT_CURRENT_ITEM:  '.CurrentItem',
  BT_WO_STATE:      '.CurrentWOState',
  BT_JOB_RUNNING:   '.JobRunning',
  BT_BATCH_SIZE:    '.BatchSize',
  BT_FROM_ENT:      '.FromEntName',
  BT_TO_ENT:        '.ToEntName',

  // Milk line batch totalizers (already in LBS, reset per batch)
  ML1_TOTALIZER: 'ML1.BATCHTOTALIZER',
  ML2_TOTALIZER: 'ML2.BATCHTOTALIZER',
  ML3_TOTALIZER: 'ML3.BATCHTOTALIZER',
  ML4_TOTALIZER: 'ML4.BATCHTOTALIZER',
  CL1_TOTALIZER: 'CL1.BATCHTOTALIZER',
  CL2_TOTALIZER: 'CL2.BATCHTOTALIZER',

  // MES work order tags (from ColdMilkSeparator1)
  WO_CURRENT:    'ColdMilkSeparator1.CurrentWO',
  WO_FROM_ENT:   'ColdMilkSeparator1.FromEntName',
  WO_TO_ENT:     'ColdMilkSeparator1.ToEntName',
  WO_PROD_ITEM:  'ColdMilkSeparator1.ProdItem',
  WO_PROD_LOT:   'ColdMilkSeparator1.ProdLot',
  WO_PROD_QTY:   'ColdMilkSeparator1.ProdQty',
  WO_CONS_ITEM:  'ColdMilkSeparator1.ConsItem',
  WO_CONS_LOT:   'ColdMilkSeparator1.ConsLot',
  WO_CONS_QTY:   'ColdMilkSeparator1.ConsQty',
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
   */
  _get(url) {
    console.log(`[RestProvider] --> GET ${url}`)
    return new Promise((resolve, reject) => {
      httpntlm.get({
        url,
        domain: this.domain,
        username: this.username,
        password: this.password,
        headers: { 'Accept': 'application/json' },
      }, (err, res) => {
        if (err) {
          console.error(`[RestProvider] <-- ERROR:`, err.message)
          return reject(err)
        }
        console.log(`[RestProvider] <-- HTTP ${res.statusCode}, body length: ${res.body?.length ?? 0} chars`)
        console.log(`[RestProvider] <-- RAW BODY (first 500 chars): ${res.body?.slice(0, 500)}`)
        if (res.statusCode !== 200) {
          return reject(new Error(`Historian API ${res.statusCode}: ${res.body?.slice(0, 300)}`))
        }
        try {
          // Historian sometimes prepends a BOM
          const body = res.body.replace(/^\uFEFF/, '')
          const parsed = JSON.parse(body)
          console.log(`[RestProvider] <-- PARSED: keys=${Object.keys(parsed).join(', ')}, value.length=${parsed.value?.length ?? 'N/A'}, nextLink=${parsed['@odata.nextLink'] ?? 'none'}`)
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
  async _queryProcessValues(fqn, since, until, { maxRecords = 50000 } = {}) {
    console.log(`[RestProvider] _queryProcessValues: fqn=${fqn}, since=${since?.toISOString() ?? 'none'}, until=${until?.toISOString() ?? 'none'}`)
    let filter = `FQN eq '${fqn}'`
    if (since) filter += ` and DateTime ge ${since.toISOString()}`
    if (until) filter += ` and DateTime le ${until.toISOString()}`
    let url = `${this.baseUrl}/ProcessValues?$filter=${encodeURIComponent(filter)}&$orderby=DateTime`

    const all = []
    let page = 0
    while (url && all.length < maxRecords) {
      page++
      console.log(`[RestProvider] _queryProcessValues: fetching page ${page}, collected so far: ${all.length}`)
      const data = await this._get(url)
      all.push(...(data.value || []))
      url = all.length < maxRecords ? (data['@odata.nextLink'] || null) : null
    }
    console.log(`[RestProvider] _queryProcessValues: done — ${all.length} total records across ${page} page(s)`)
    return all
  }

  /**
   * Get the latest (current) value of a single tag.
   */
  async _getCurrentValue(fqn) {
    const values = await this._queryProcessValues(fqn)
    return values[0] || null
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
      TAGS.SEP_XFR_TRANSFER_COMPLETE, since, now
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

  /**
   * Read all batch-related tags at the TransferComplete timestamp.
   * Volume tags reset to 0 between batches, so the value at this moment
   * is the per-batch total.
   */
  async _buildBatchFromTransfer(transferTime) {
    const tagMap = await this._getValuesAt([
      TAGS.SEP_XFR_QTY_ACTUAL,
      TAGS.SEP_XFR_SOURCE,
      TAGS.SEP_XFR_ITEM_ID,
      TAGS.SEP_XFR_EU,
      TAGS.CREAM_FLOW_TOTAL,
      TAGS.SKIM_FLOW_TOTAL,
      TAGS.WO_CURRENT,
      TAGS.WO_FROM_ENT,
      TAGS.WO_TO_ENT,
      TAGS.WO_PROD_ITEM,
      TAGS.WO_PROD_LOT,
      TAGS.WO_PROD_QTY,
      TAGS.WO_CONS_ITEM,
      TAGS.WO_CONS_LOT,
      TAGS.WO_CONS_QTY,
    ], transferTime)

    const val = (tag) => tagMap[tag]?.Value ?? 0
    const txt = (tag) => tagMap[tag]?.Text ?? ''

    const workOrder = txt(TAGS.WO_CURRENT)
    const xfrSource = txt(TAGS.SEP_XFR_SOURCE)

    if (!workOrder && !xfrSource) {
      console.log(`[RestProvider] No WO or source at ${transferTime.toISOString()}, skipping`)
      return null
    }

    const batchId = workOrder || `XFR-${transferTime.getTime()}`
    const inputVolume = val(TAGS.SEP_XFR_QTY_ACTUAL) // already in LBS
    const creamGallons = val(TAGS.CREAM_FLOW_TOTAL)
    const skimGallons = val(TAGS.SKIM_FLOW_TOTAL)
    const creamVolume = creamGallons * CREAM_DENSITY_PPG  // gallons → LBS
    const skimVolume = skimGallons * SKIM_DENSITY_PPG     // gallons → LBS

    console.log(`[RestProvider] Batch ${batchId}: input=${inputVolume.toFixed(1)} LBS, cream=${creamGallons.toFixed(1)} gal (${creamVolume.toFixed(1)} LBS), skim=${skimGallons.toFixed(1)} gal (${skimVolume.toFixed(1)} LBS)`)

    return {
      batchId,
      sourceSilo: xfrSource || txt(TAGS.WO_FROM_ENT),
      inputVolume,
      creamVolume,
      skimVolume,
      batchStart: new Date(transferTime.getTime() - 30 * 60 * 1000),
      batchEnd: transferTime,
      xfrItemId: txt(TAGS.SEP_XFR_ITEM_ID),
      xfrUnit: txt(TAGS.SEP_XFR_EU),
      workOrder,
      destinationEntity: txt(TAGS.WO_TO_ENT),
      prodItem: txt(TAGS.WO_PROD_ITEM),
      prodLot: txt(TAGS.WO_PROD_LOT),
      prodQty: val(TAGS.WO_PROD_QTY),
      consItem: txt(TAGS.WO_CONS_ITEM),
      consLot: txt(TAGS.WO_CONS_LOT),
      consQty: val(TAGS.WO_CONS_QTY),
    }
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
      this._getCurrentValue(TAGS.CREAM_FLOW_TOTAL),
      this._getCurrentValue(TAGS.SKIM_FLOW_TOTAL),
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
   * Read current MES work order tags for all 4 blend tanks.
   */
  async getBlendTankStatus() {
    const tanks = ['BlendTank1A', 'BlendTank1B', 'BlendTank2A', 'BlendTank2B']
    const suffixes = [
      TAGS.BT_CURRENT_WO, TAGS.BT_CURRENT_ITEM, TAGS.BT_WO_STATE,
      TAGS.BT_JOB_RUNNING, TAGS.BT_BATCH_SIZE, TAGS.BT_FROM_ENT, TAGS.BT_TO_ENT,
    ]

    const results = await Promise.all(tanks.map(async (tankId) => {
      const fqns = suffixes.map(s => `${tankId}${s}`)
      const values = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn)))
      const val = (i) => values[i]?.Value ?? 0
      const txt = (i) => values[i]?.Text ?? ''

      return {
        tankId,
        currentWO: txt(0),
        currentItem: txt(1),
        currentWOState: txt(2),
        jobRunning: val(3),
        batchSize: val(4),
        fromEntName: txt(5),
        toEntName: txt(6),
      }
    }))

    return results
  }

  // ── Milk/cream line totalizers ──────────────────────────────────────

  /**
   * Read current batch totalizer values for all milk and cream lines.
   * Totalizers are already in LBS and reset to 0 per batch.
   */
  async getMilkLineStatus() {
    const lines = [
      { line: 'ML1', fqn: TAGS.ML1_TOTALIZER },
      { line: 'ML2', fqn: TAGS.ML2_TOTALIZER },
      { line: 'ML3', fqn: TAGS.ML3_TOTALIZER },
      { line: 'ML4', fqn: TAGS.ML4_TOTALIZER },
      { line: 'CL1', fqn: TAGS.CL1_TOTALIZER },
      { line: 'CL2', fqn: TAGS.CL2_TOTALIZER },
    ]

    const values = await Promise.all(lines.map(l => this._getCurrentValue(l.fqn)))

    return lines.map((l, i) => ({
      line: l.line,
      totalizerLbs: values[i]?.Value ?? 0,
    }))
  }
}

module.exports = RestProvider
