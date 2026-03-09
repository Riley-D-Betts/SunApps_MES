const path = require('path')
const dotenv = require('dotenv')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

module.exports = {
  PORT: process.env.PORT || 4100,
  SUNAPPS_API_URL: process.env.SUNAPPS_API_URL || 'http://localhost:4000',
  HISTORIAN_PROVIDER: process.env.HISTORIAN_PROVIDER || 'mock',
  SEPARATION_CRON: process.env.SEPARATION_CRON || '*/5 * * * *',
  BULK_MILK_CRON: process.env.BULK_MILK_CRON || '*/1 * * * *',
  HISTORIAN_BASE_URL: process.env.HISTORIAN_BASE_URL,
  HISTORIAN_DOMAIN: process.env.HISTORIAN_DOMAIN || '',
  HISTORIAN_USERNAME: process.env.HISTORIAN_USERNAME,
  HISTORIAN_PASSWORD: process.env.HISTORIAN_PASSWORD,
  TEAMS_WEBHOOK_URL: process.env.TEAMS_WEBHOOK_URL,
}
