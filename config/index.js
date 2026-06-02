const path = require('path')
const dotenv = require('dotenv')
const { Sequelize } = require('sequelize')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const sequelize = new Sequelize(
  process.env.SQL_DATABASE,
  process.env.SQL_USER,
  process.env.SQL_PASSWORD,
  {
    host: process.env.SQL_SERVER,
    dialect: 'mssql',
    dialectOptions: {
      options: {
        encrypt: true,
        trustServerCertificate: true
      }
    },
    logging: false
  }
)

module.exports = {
  PORT: process.env.PORT || 4005,
  CORE_API_URL: process.env.CORE_API_URL || 'http://localhost:4000',
  MES_DRY_RUN: process.env.MES_DRY_RUN === 'true',
  HISTORIAN_PROVIDER: process.env.HISTORIAN_PROVIDER || 'mock',
  SEPARATION_CRON: process.env.SEPARATION_CRON || '*/10 * * * * *',
  BULK_MILK_CRON: process.env.BULK_MILK_CRON || '*/1 * * * *',
  BLEND_TANK_CRON: process.env.BLEND_TANK_CRON || '*/10 * * * * *',
  SURGE_TANK_CRON: process.env.SURGE_TANK_CRON || '*/10 * * * * *',
  EQUIPMENT_CRON: process.env.EQUIPMENT_CRON || '*/15 * * * * *',
  // Tick that fires periodic blend-tank WO issues + completions. Production cadence
  // is once every 5 minutes; sandbox can override to e.g. '*/30 * * * * *' for testing.
  TICK_CRON: process.env.TICK_CRON || '*/5 * * * *',
  // Tank-at-rest inventory adjustment sweep. Same 5-min cadence as the tick —
  // matches the 5-min average window the sweep service uses to denoise the
  // ~±800 lb level sensor jitter on idle tanks.
  INVENTORY_ADJUSTMENT_CRON: process.env.INVENTORY_ADJUSTMENT_CRON || '*/5 * * * *',
  // Min delta (lbs) to actually fire a workOrderIssue / workOrderCompletion. Below
  // this we just defer to the next tick so we don't spam NS with sub-pound noise.
  MES_MIN_ISSUE_LBS: parseFloat(process.env.MES_MIN_ISSUE_LBS || '10'),
  MES_MIN_COMPLETION_LBS: parseFloat(process.env.MES_MIN_COMPLETION_LBS || '1'),
  // Waste-tracking noise floors (lbs). Completion is driven by measured arrival
  // into the destination vessel; issued − arrival = waste (NS shrinkage). These
  // floors keep load-cell / level sensor jitter from fabricating phantom
  // arrivals, drains, or residuals (analogous to FILL_NOISE_GAL on the surge job).
  //   RESIDUAL_FLOOR: a tank reading below this at batch close counts as empty.
  //   RISE_FLOOR:     a per-tick destination level RISE below this is ignored.
  //   DROP_FLOOR:     a per-tick source silo level DROP below this is ignored (Phase 2).
  MES_WASTE_RESIDUAL_FLOOR_LBS: parseFloat(process.env.MES_WASTE_RESIDUAL_FLOOR_LBS || '200'),
  MES_WASTE_RISE_FLOOR_LBS: parseFloat(process.env.MES_WASTE_RISE_FLOOR_LBS || '20'),
  MES_WASTE_DROP_FLOOR_LBS: parseFloat(process.env.MES_WASTE_DROP_FLOOR_LBS || '20'),
  // How far back a freshly-opened blend-tank batch will sweep for line flows
  // that completed BEFORE the batch existed (operators named the tank hours
  // after the fill). Those flows were saved as status='unmatched'; on batch
  // open we attach + issue + complete any within this window. Bounded so a new
  // batch doesn't vacuum up day-old orphans from an unrelated run.
  MES_INFLOW_BACKFILL_LOOKBACK_HOURS: parseFloat(process.env.MES_INFLOW_BACKFILL_LOOKBACK_HOURS || '18'),
  // Test-input override for blend tank product selection. JSON object mapping
  // tankId → raw NS item ID (e.g. '{"BlendTank1A":8344,"BlendTank2A":8347}').
  // When set for a tank, processWOStart uses that item ID directly and skips
  // the fuzzy product parser. Temporary scaffolding until the AVEVA tag for
  // batch product is wired up; replace the env-var read with a historian-tag
  // read at that point.
  BLEND_TANK_OVERRIDES: (() => {
    if (!process.env.BLEND_TANK_OVERRIDES) return {}
    try {
      return JSON.parse(process.env.BLEND_TANK_OVERRIDES)
    } catch (e) {
      console.warn(`[Config] Failed to parse BLEND_TANK_OVERRIDES: ${e.message}`)
      return {}
    }
  })(),
  // Test-input override for surge tank FG product selection. JSON object mapping
  // tankId → finished-goods NS item ID (e.g. '{"ST81":4498,"ST83":3228}').
  // When set, processWOStart uses that FG item ID directly and skips the parser.
  // Temporary scaffolding for sandbox testing until the AVEVA standardized
  // surge-tank product tag is wired up.
  // When true, blend + surge tank product parsers only resolve via their
  // exact-match tables (RAW_FG_ITEM_MAP / FG_ITEM_MAP) and skip the fuzzy
  // brand/fat/modifier scoring. Flip this on once AVEVA delivers the
  // constrained select-tag values and both maps are populated — unmatched
  // batches will land as pending_ns rather than silently scoring against the
  // wrong item.
  MES_PARSER_STRICT_MODE: process.env.MES_PARSER_STRICT_MODE === 'true',
  SURGE_TANK_OVERRIDES: (() => {
    if (!process.env.SURGE_TANK_OVERRIDES) return {}
    try {
      return JSON.parse(process.env.SURGE_TANK_OVERRIDES)
    } catch (e) {
      console.warn(`[Config] Failed to parse SURGE_TANK_OVERRIDES: ${e.message}`)
      return {}
    }
  })(),
  HISTORIAN_BASE_URL: process.env.HISTORIAN_BASE_URL,
  HISTORIAN_DOMAIN: process.env.HISTORIAN_DOMAIN || '',
  HISTORIAN_USERNAME: process.env.HISTORIAN_USERNAME,
  HISTORIAN_PASSWORD: process.env.HISTORIAN_PASSWORD,
  TEAMS_WEBHOOK_URL: process.env.TEAMS_WEBHOOK_URL,
  // Historical-replay defaults. SIM_START is the wall-clock moment the sim
  // clock begins ticking from; SPEEDUP is the multiplier (60 = sim time
  // advances 60x faster than wall). Only consumed when HISTORIAN_PROVIDER
  // is 'historical' — for live/mock providers these are ignored.
  SIM_START: process.env.SIM_START || null,
  SPEEDUP: parseFloat(process.env.SPEEDUP || '60'),
  sequelize,
}
