const notifyService = require('../services/notifyService')
const separatorStateMachine = require('../services/separatorStateMachine')

let lastPollTime = new Date()

async function run(historian) {
  try {
    await separatorStateMachine.tick(historian)
    lastPollTime = new Date()
  } catch (err) {
    console.error('[SeparationJob] Tick error:', err.message)
    await notifyService.sendAlert(
      'SunApps MES: Separation Tick Failed',
      `Separation state machine tick failed: ${err.message}`
    )
  }
}

function getLastPollTime() {
  return lastPollTime
}

function reset() {
  separatorStateMachine.reset()
}

module.exports = { run, getLastPollTime, reset }
