const config = require('../config')

/**
 * Send a Teams alert for MES_Service connection failures.
 * This service only handles infrastructure-level alerts (e.g., Historian or API unreachable).
 * Business-level alerts (waste thresholds, etc.) are handled by SunApps_API.
 */
async function sendAlert(title, message) {
  const webhookUrl = config.TEAMS_WEBHOOK_URL

  if (!webhookUrl) {
    console.warn('[NotifyService] TEAMS_WEBHOOK_URL not set — skipping alert')
    return
  }

  const payload = {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.4',
        body: [
          { type: 'TextBlock', text: title, weight: 'Bolder', size: 'Medium', color: 'Attention' },
          { type: 'TextBlock', text: message, wrap: true, spacing: 'Small' },
        ],
      },
    }],
  }

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!response.ok) {
      console.error(`[NotifyService] Teams webhook failed (${response.status})`)
    }
  } catch (err) {
    console.error('[NotifyService] Failed to send alert:', err.message)
  }
}

module.exports = { sendAlert }
