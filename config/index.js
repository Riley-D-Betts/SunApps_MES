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
  EQUIPMENT_CRON: process.env.EQUIPMENT_CRON || '*/15 * * * * *',
  // Tick that fires periodic blend-tank WO issues + completions. Production cadence
  // is once every 5 minutes; sandbox can override to e.g. '*/30 * * * * *' for testing.
  TICK_CRON: process.env.TICK_CRON || '*/5 * * * *',
  // Min delta (lbs) to actually fire a workOrderIssue / workOrderCompletion. Below
  // this we just defer to the next tick so we don't spam NS with sub-pound noise.
  MES_MIN_ISSUE_LBS: parseFloat(process.env.MES_MIN_ISSUE_LBS || '10'),
  MES_MIN_COMPLETION_LBS: parseFloat(process.env.MES_MIN_COMPLETION_LBS || '1'),
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
  HISTORIAN_BASE_URL: process.env.HISTORIAN_BASE_URL,
  HISTORIAN_DOMAIN: process.env.HISTORIAN_DOMAIN || '',
  HISTORIAN_USERNAME: process.env.HISTORIAN_USERNAME,
  HISTORIAN_PASSWORD: process.env.HISTORIAN_PASSWORD,
  TEAMS_WEBHOOK_URL: process.env.TEAMS_WEBHOOK_URL,
  sequelize,
}
