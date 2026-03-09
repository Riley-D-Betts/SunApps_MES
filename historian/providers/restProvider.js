const BaseProvider = require('./baseProvider')
const config = require('../../config')
const httpntlm = require('httpntlm')

/**
 * REST provider for the on-premise AVEVA Historian OData v2 API.
 * Uses NTLM auth against the MES domain.
 *
 * Separation batches are detected via XFR (transfer) tags on the separator IO:
 *   - Ingr_Sep_CMSep1_IO.XFR.TransferCompleteS.0  — trigger when transfer finishes
 *   - Ingr_Sep_CMSep1_IO.XFR.QTYActual            — per-batch input volume (resets to 0)
 *   - Ingr_Sep_CMSep1_IO.XFR.Source                — source silo (e.g. "MSilo1")
 *   - Ingr_Sep_CMSep1_IO.XFR.ItemID                — item ID
 *   - Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized     — per-batch cream (resets between batches)
 *   - Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized      — per-batch skim (resets between batches)
 *
 * Bulk milk flow is computed as deltas on the cream/skim flow counters between polls.
 */

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
    return new Promise((resolve, reject) => {
      httpntlm.get({
        url,
        domain: this.domain,
        username: this.username,
        password: this.password,
        headers: { 'Accept': 'application/json' },
      }, (err, res) => {
        if (err) return reject(err)
        if (res.statusCode !== 200) {
          return reject(new Error(`Historian API ${res.statusCode}: ${res.body?.slice(0, 300)}`))
        }
        try {
          // Historian sometimes prepends a BOM
          const body = res.body.replace(/^\uFEFF/, '')
          resolve(JSON.parse(body))
        } catch (e) {
          reject(new Error(`Invalid JSON from Historian: ${res.body?.slice(0, 300)}`))
        }
      })
    })
  }

  /**
   * Query ProcessValues for one tag, optionally filtered by time range.
   * AVEVA on-prem uses bare ISO datetimes (NOT datetimeoffset'...' wrapper).
   */
  async _queryProcessValues(fqn, since, until) {
    let filter = `FQN eq '${fqn}'`
    if (since) filter += ` and DateTime ge ${since.toISOString()}`
    if (until) filter += ` and DateTime le ${until.toISOString()}`
    const url = `${this.baseUrl}/ProcessValues?$filter=${encodeURIComponent(filter)}`
    const data = await this._get(url)
    return data.value || []
  }

  /**
   * Get the latest (current) value of a single tag.
   */
  async _getCurrentValue(fqn) {
    const values = await this._queryProcessValues(fqn)
    return values[0] || null
  }

  /**
   * Get the historical value of a tag at or just before a specific timestamp.
   * Queries a small window ending at the target time and returns the last value.
   */
  async _getValueAt(fqn, timestamp) {
    const from = new Date(timestamp.getTime() - 1000)
    const values = await this._queryProcessValues(fqn, from, timestamp)
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
   * trigger on the separator IO. This fires when the physical transfer finishes
   * and is the most reliable moment to read per-batch quantities, since:
   *   - XFR.QTYActual holds the batch input volume (resets to 0 after)
   *   - Cream/Skim_Flow_Totalized hold per-batch cream/skim (reset after)
   *   - XFR.Source holds the source silo name
   *   - The MES work order tags still hold the active WO info
   */
  async getSeparatorBatches(since) {
    const now = new Date()

    // Look for TransferComplete trigger events since last poll
    const xfrEvents = await this._queryProcessValues(
      TAGS.SEP_XFR_TRANSFER_COMPLETE, since, now
    )

    // Filter to only "fired" events (value = 1)
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
   * Read all batch-related tags at the TransferComplete timestamp and
   * assemble the batch object. At this moment:
   *   - XFR.QTYActual = total input volume for this batch
   *   - Cream_Flow_Totalized = total cream produced this batch
   *   - Skim_Flow_Totalized = total skim produced this batch
   *   - WO tags = active work order info (clears ~5s later at EndJob)
   */
  async _buildBatchFromTransfer(transferTime) {
    const tagMap = await this._getValuesAt([
      // XFR transfer data (per-batch quantities)
      TAGS.SEP_XFR_QTY_ACTUAL,
      TAGS.SEP_XFR_SOURCE,
      TAGS.SEP_XFR_ITEM_ID,
      TAGS.SEP_XFR_EU,
      // Flow totals (per-batch, reset between batches)
      TAGS.CREAM_FLOW_TOTAL,
      TAGS.SKIM_FLOW_TOTAL,
      // MES work order context
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

    // Need at least a work order or source to identify the batch
    if (!workOrder && !xfrSource) {
      console.log(`[RestProvider] No WO or source at ${transferTime.toISOString()}, skipping`)
      return null
    }

    // Use work order as batchId; fall back to timestamp-based ID
    const batchId = workOrder || `XFR-${transferTime.getTime()}`

    return {
      batchId,
      sourceSilo: xfrSource || txt(TAGS.WO_FROM_ENT),
      inputVolume: val(TAGS.SEP_XFR_QTY_ACTUAL),
      creamVolume: val(TAGS.CREAM_FLOW_TOTAL),
      skimVolume: val(TAGS.SKIM_FLOW_TOTAL),
      batchStart: new Date(transferTime.getTime() - 30 * 60 * 1000), // approximate
      batchEnd: transferTime,
      // XFR metadata
      xfrItemId: txt(TAGS.SEP_XFR_ITEM_ID),
      xfrUnit: txt(TAGS.SEP_XFR_EU),
      // MES work order context
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
}

module.exports = RestProvider
