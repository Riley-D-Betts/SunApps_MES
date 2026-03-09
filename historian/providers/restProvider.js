const BaseProvider = require('./baseProvider')
const config = require('../../config')
const httpntlm = require('httpntlm')

/**
 * REST provider for the on-premise AVEVA Historian OData v2 API.
 * Uses NTLM auth against the MES domain.
 *
 * Separation batches are detected by watching ColdMilkSeparator1.EndJob triggers.
 * Bulk milk flow is computed as deltas on the totalized cream/skim flow counters.
 */
class RestProvider extends BaseProvider {
  constructor() {
    super()
    this.baseUrl = config.HISTORIAN_BASE_URL
    this.domain = config.HISTORIAN_DOMAIN
    this.username = config.HISTORIAN_USERNAME
    this.password = config.HISTORIAN_PASSWORD

    // Track previous totalized flow readings for delta calculation
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
   * Get current values for multiple tags in parallel.
   * Returns a map of FQN → ProcessValue.
   */
  async _getCurrentValues(fqns) {
    const results = await Promise.all(fqns.map(fqn => this._getCurrentValue(fqn)))
    const map = {}
    fqns.forEach((fqn, i) => { map[fqn] = results[i] })
    return map
  }

  /**
   * Get the historical value of a tag at or just before a specific timestamp.
   * Queries a small window ending at the target time and returns the last value.
   */
  async _getValueAt(fqn, timestamp) {
    // Query a 1-second window ending at the timestamp
    const from = new Date(timestamp.getTime() - 1000)
    const values = await this._queryProcessValues(fqn, from, timestamp)
    return values.length > 0 ? values[values.length - 1] : null
  }

  // ── Separation batches ─────────────────────────────────────────────

  /**
   * Detect completed separation batches by watching ColdMilkSeparator1.EndJob.
   *
   * Strategy: query EndJob trigger values since the last poll. Each value=1
   * event represents a completed batch. For each, read the batch tags at
   * that timestamp (before the WO clears).
   */
  async getSeparatorBatches(since) {
    const now = new Date()

    // Look for EndJob trigger events since last poll
    const endJobEvents = await this._queryProcessValues(
      'ColdMilkSeparator1.EndJob', since, now
    )

    // Filter to only "fired" events (value = 1 / true)
    const completedEvents = endJobEvents.filter(e => e.Value === 1)

    if (completedEvents.length === 0) return []

    // For each completed batch, read the state AT the end-job timestamp.
    // The WO and quantities are valid at the moment EndJob fires; they
    // get cleared shortly after.
    const batches = []
    for (const event of completedEvents) {
      const endTime = new Date(event.DateTime)
      try {
        const batch = await this._buildBatchFromTimestamp(endTime)
        if (batch) batches.push(batch)
      } catch (err) {
        console.error(`[RestProvider] Failed to read batch at ${endTime.toISOString()}:`, err.message)
      }
    }

    return batches
  }

  /**
   * Read all batch-related tags at the given timestamp and assemble
   * the batch object.
   */
  async _buildBatchFromTimestamp(endTime) {
    const batchTags = [
      'ColdMilkSeparator1.CurrentWO',
      'ColdMilkSeparator1.FromEntName',
      'ColdMilkSeparator1.ToEntName',
      'ColdMilkSeparator1.ConsQty',
      'ColdMilkSeparator1.ProdQty',
      'ColdMilkSeparator1.ProdItem',
      'ColdMilkSeparator1.ProdLot',
      'ColdMilkSeparator1.ConsItem',
      'ColdMilkSeparator1.ConsLot',
      'Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized',
      'Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized',
    ]

    const results = await Promise.all(
      batchTags.map(fqn => this._getValueAt(fqn, endTime))
    )

    const tagMap = {}
    batchTags.forEach((fqn, i) => { tagMap[fqn] = results[i] })

    const val = (fqn) => tagMap[fqn]?.Value ?? 0
    const txt = (fqn) => tagMap[fqn]?.Text ?? ''

    const workOrder = txt('ColdMilkSeparator1.CurrentWO')
    if (!workOrder) {
      console.log(`[RestProvider] No work order found at ${endTime.toISOString()}, skipping`)
      return null
    }

    return {
      batchId: workOrder,
      sourceSilo: txt('ColdMilkSeparator1.FromEntName'),
      inputVolume: val('ColdMilkSeparator1.ConsQty'),
      creamVolume: val('Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized'),
      skimVolume: val('Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized'),
      batchStart: new Date(endTime.getTime() - 30 * 60 * 1000), // approximate
      batchEnd: endTime,
      // Extra fields for SunApps_API
      workOrder,
      destinationEntity: txt('ColdMilkSeparator1.ToEntName'),
      prodItem: txt('ColdMilkSeparator1.ProdItem'),
      prodLot: txt('ColdMilkSeparator1.ProdLot'),
      prodQty: val('ColdMilkSeparator1.ProdQty'),
      consItem: txt('ColdMilkSeparator1.ConsItem'),
      consLot: txt('ColdMilkSeparator1.ConsLot'),
      consQty: val('ColdMilkSeparator1.ConsQty'),
    }
  }

  // ── Bulk milk flow ─────────────────────────────────────────────────

  /**
   * Read the totalized cream/skim flow counters and compute deltas
   * since the previous poll. Returns a single reading if the flow
   * has changed, or an empty array if idle.
   */
  async getBulkMilkFlowData(since) {
    const [creamPv, skimPv] = await Promise.all([
      this._getCurrentValue('Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized'),
      this._getCurrentValue('Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized'),
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

    // Counter reset (new batch started) — skip this reading
    if (creamDelta < 0 || skimDelta < 0) {
      console.log('[RestProvider] Flow counter reset detected, skipping reading')
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
