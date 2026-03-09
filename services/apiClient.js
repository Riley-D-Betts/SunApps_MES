const config = require('../config')

const baseUrl = config.SUNAPPS_API_URL

/**
 * POST raw data to SunApps_API.
 * @param {string} path - API path (e.g., '/api/mes/separation/batch')
 * @param {object} data - Raw data payload
 * @returns {Promise<object>} Parsed JSON response
 */
async function post(path, data) {
  const url = `${baseUrl}${path}`
  console.log(`[ApiClient] POST ${url}`)

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })

  const body = await response.text()
  let parsed
  try {
    parsed = JSON.parse(body)
  } catch {
    parsed = { raw: body }
  }

  if (!response.ok) {
    const errMsg = parsed?.error || parsed?.message || `HTTP ${response.status}`
    throw new Error(`API error: ${errMsg}`)
  }

  return parsed
}

module.exports = { post }
