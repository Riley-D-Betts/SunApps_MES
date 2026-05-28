/**
 * Sim-clock shim. Returns wall time normally; in sim mode, returns
 * accelerated historical time. Used by jobs/services that compute
 * time deltas, idle timeouts, and cooldowns so they advance with
 * plant time (not wall-clock) during a historical replay.
 *
 * Pause snapshots the current sim time; resume re-anchors so sim
 * time continues from the snapshot.
 */

let active = false
let simStartMs = 0
let speedup = 1
let bootWallMs = 0
let pausedAtSimMs = null

function now() {
  if (!active) return Date.now()
  if (pausedAtSimMs != null) return pausedAtSimMs
  return simStartMs + (Date.now() - bootWallMs) * speedup
}

function simNow() {
  return now()
}

function initSim({ start, speedup: sp }) {
  const startDate = start instanceof Date ? start : new Date(start)
  if (Number.isNaN(startDate.getTime())) {
    throw new Error(`initSim: invalid start "${start}"`)
  }
  if (!Number.isFinite(sp) || sp <= 0) {
    throw new Error(`initSim: speedup must be a positive number, got ${sp}`)
  }
  active = true
  simStartMs = startDate.getTime()
  speedup = sp
  bootWallMs = Date.now()
  pausedAtSimMs = null
}

function pause() {
  if (!active || pausedAtSimMs != null) return
  pausedAtSimMs = now()
}

function resume() {
  if (!active || pausedAtSimMs == null) return
  simStartMs = pausedAtSimMs
  bootWallMs = Date.now()
  pausedAtSimMs = null
}

function resetSim() {
  if (!active) return
  bootWallMs = Date.now()
  pausedAtSimMs = null
}

function stopSim() {
  active = false
  pausedAtSimMs = null
}

function getStatus() {
  return {
    active,
    paused: pausedAtSimMs != null,
    simStart: active ? new Date(simStartMs).toISOString() : null,
    simNow: active ? new Date(now()).toISOString() : null,
    wallNow: new Date().toISOString(),
    speedup: active ? speedup : 1,
  }
}

module.exports = { now, simNow, initSim, pause, resume, resetSim, stopSim, getStatus }
