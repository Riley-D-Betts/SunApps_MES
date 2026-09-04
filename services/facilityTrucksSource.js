/**
 * Facility trucks source — the NetSuite milk-truck queue for the facility map
 * (customrecord_milk_truck), polled once a minute through the Gateway by
 * jobs/facilityTrucksJob.js.
 *
 * The historian tells us what is physically happening at a bay (see
 * receivingJob: XFR.Source is the TRUCK NUMBER the operator keyed in); NetSuite
 * tells us who that truck is (MT record, vendor, item, load, weights, QC status)
 * and what else is on site or scheduled. The two join on truck number.
 *
 * Status list customlist_milk_truck_status: 1 Pending QC, 2 Passed QC,
 * 3 Diverted, 4 Received, 5 Failed QC, 6 Scheduled, 7 Checked in,
 * 8 Pending External Results.
 */
const core = require('../clients/coreClient')
const clock = require('../sim/clock')

const STATUS = { 1: 'Pending QC', 2: 'Passed QC', 3: 'Diverted', 4: 'Received', 5: 'Failed QC', 6: 'Scheduled', 7: 'Checked in', 8: 'Pending external results' }
const ON_SITE = new Set([7, 1, 2, 5])       // here now (checked in, in QC, passed, failed)
const DONE = new Set([4, 8])                // received (external lab may still be pending)
const ON_SITE_MAX_MS = 24 * 60 * 60_000     // an on-site status older than this is a forgotten record, not a truck
const WINDOW_DAYS = 2

const state = { trucks: [], pollAt: null, error: null }

const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null }
const toMs = (s) => (s ? new Date(String(s).replace(' ', 'T')).getTime() : null)

const QUERY = `
  SELECT
    mt.id, mt.name,
    TO_CHAR(mt.custrecord_mt_arrival, 'YYYY-MM-DD HH24:MI') AS arrival,
    mt.custrecord_mt_status AS status_id,
    BUILTIN.DF(mt.custrecord_mt_item) AS item,
    BUILTIN.DF(mt.custrecord_mt_vendor) AS vendor,
    mt.custrecord_mt_truck_number AS truck_no,
    mt.custrecord_mt_load_number AS load_no,
    mt.custrecord_mt_gweight AS gross,
    mt.custrecord_mt_tweight AS tare,
    mt.custrecord_mt_farm_weight AS farm_lb
  FROM customrecord_milk_truck mt
  WHERE mt.isinactive = 'F'
    AND mt.custrecord_mt_arrival >= SYSDATE - ${WINDOW_DAYS}
    AND mt.custrecord_mt_arrival <  SYSDATE + ${WINDOW_DAYS}
  ORDER BY mt.custrecord_mt_arrival
`

function mapRow(r) {
  const gross = num(r.gross), tare = num(r.tare), farm = num(r.farm_lb)
  const statusId = Number(r.status_id) || null
  return {
    id: String(r.id), name: r.name || `MT${r.id}`, truckNo: String(r.truck_no || '').trim(), loadNo: r.load_no || '',
    vendor: r.vendor || '', item: r.item || '', statusId, status: STATUS[statusId] || r.status || '',
    arrivalMs: toMs(r.arrival), grossLb: gross, tareLb: tare, farmLb: farm, netLb: gross && tare && gross > tare ? gross - tare : null,
  }
}

async function poll() {
  const nowMs = clock.now()
  try {
    // Proven SuiteQL path (core.suiteQL()'s route is mis-wired — see costRevaluationService).
    const res = await core.netsuitePost('/query/v1/suiteql', { q: QUERY })
    const items = res?.items || res?.body?.items || []
    state.trucks = items.map(mapRow)
    state.pollAt = new Date(nowMs).toISOString()
    state.error = null
    return true
  } catch (err) {
    state.error = err.message   // keep last-good
    return false
  }
}

/** Trucks grouped the way the map needs them at `nowMs`. */
function snapshot(nowMs = clock.now()) {
  const trucks = state.trucks
  const isToday = (ms) => ms != null && new Date(ms).toDateString() === new Date(nowMs).toDateString()
  const onSite = trucks.filter((t) => ON_SITE.has(t.statusId) && t.arrivalMs != null && nowMs - t.arrivalMs < ON_SITE_MAX_MS && nowMs - t.arrivalMs > -ON_SITE_MAX_MS)
  const scheduled = trucks.filter((t) => t.statusId === 6 && t.arrivalMs != null && t.arrivalMs > nowMs - 6 * 60 * 60_000).sort((a, b) => a.arrivalMs - b.arrivalMs)
  const receivedToday = trucks.filter((t) => DONE.has(t.statusId) && isToday(t.arrivalMs))
  // latest record per truck number — the historian's XFR.Source joins here
  const byTruckNo = {}
  for (const t of trucks.slice().sort((a, b) => (a.arrivalMs || 0) - (b.arrivalMs || 0))) if (t.truckNo) byTruckNo[t.truckNo] = t
  return { trucks, onSite, scheduled, receivedToday, byTruckNo, pollAt: state.pollAt, error: state.error }
}

function health() {
  return { pollAt: state.pollAt, error: state.error, trucks: state.trucks.length }
}

function reset() { Object.assign(state, { trucks: [], pollAt: null, error: null }) }

module.exports = { poll, snapshot, health, reset, STATUS, mapRow }
