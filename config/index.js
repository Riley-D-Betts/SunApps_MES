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
  PORT: process.env.PORT || 4300,
  CORE_API_URL: process.env.CORE_API_URL || 'http://localhost:4000',
  MES_DRY_RUN: process.env.MES_DRY_RUN === 'true',
  HISTORIAN_PROVIDER: process.env.HISTORIAN_PROVIDER || 'mock',
  SEPARATION_CRON: process.env.SEPARATION_CRON || '*/10 * * * * *',
  BULK_MILK_CRON: process.env.BULK_MILK_CRON || '*/1 * * * *',
  BLEND_TANK_CRON: process.env.BLEND_TANK_CRON || '*/10 * * * * *',
  HISTORIAN_BASE_URL: process.env.HISTORIAN_BASE_URL,
  HISTORIAN_DOMAIN: process.env.HISTORIAN_DOMAIN || '',
  HISTORIAN_USERNAME: process.env.HISTORIAN_USERNAME,
  HISTORIAN_PASSWORD: process.env.HISTORIAN_PASSWORD,
  TEAMS_WEBHOOK_URL: process.env.TEAMS_WEBHOOK_URL,
  sequelize,
}
