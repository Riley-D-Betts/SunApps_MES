/**
 * Runtime Teams alerts are disabled by request: the only Teams notifications we
 * want come from the deploy scripts (the GitHub Actions workflows, which post to
 * TEAMS_SOFTWARE_DEPLOYMENT_HOOK on their own). No waste/infrastructure alerts
 * should be sent from the running app.
 *
 * sendAlert is kept as a no-op so the existing call sites (which still log
 * locally via console.error + statusStore.pushEvent) continue to work without
 * emitting Teams messages. To re-enable, restore the webhook POST here.
 */
async function sendAlert(_title, _message) {
  // Intentionally a no-op — see note above.
}

module.exports = { sendAlert }
