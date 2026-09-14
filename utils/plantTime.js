'use strict'

/**
 * Plant wall-clock helpers (SD-729). The MES stores every timestamp in UTC;
 * the plant (Suntado, Idaho) runs on America/Boise. Reports bucket by plant
 * day, so "yesterday" and "last week" must be computed in that zone — not in
 * the host's zone (prod runs on a Windows box that may or may not be set to
 * Mountain time). No date library in package.json; Intl does the offset math
 * and handles DST.
 */

const PLANT_TZ = process.env.PLANT_TZ || 'America/Boise'

const _fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: PLANT_TZ,
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
})

/** { year, month, day, hour, minute, second, weekday(0=Sun) } of `d` in plant time. */
function plantParts(d = new Date()) {
  const parts = {}
  for (const p of _fmt.formatToParts(d)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  const local = new Date(Date.UTC(parts.year, parts.month - 1, parts.day))
  return { ...parts, weekday: local.getUTCDay() }
}

/** 'YYYY-MM-DD' plant-local date of `d`. */
function plantDateString(d = new Date()) {
  const p = plantParts(d)
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`
}

/**
 * UTC instant of plant-local midnight for the given plant date
 * ('YYYY-MM-DD' or a Date whose plant date is used). Two-pass: guess the
 * offset at the date's UTC midnight, then re-derive it at the guessed instant
 * so DST transition days land right.
 */
function startOfPlantDay(day = new Date()) {
  const [y, m, d] = (typeof day === 'string' ? day : plantDateString(day)).split('-').map(Number)
  let guess = Date.UTC(y, m - 1, d)
  for (let i = 0; i < 2; i++) {
    const p = plantParts(new Date(guess))
    const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
    const offsetMs = localAsUtc - guess
    guess = Date.UTC(y, m - 1, d) - offsetMs
  }
  return new Date(guess)
}

/** Plant-local date string shifted by `days` (calendar days, DST-safe). */
function addPlantDays(day, days) {
  const [y, m, d] = day.split('-').map(Number)
  const shifted = new Date(Date.UTC(y, m - 1, d + days))
  return shifted.toISOString().slice(0, 10)
}

/**
 * Half-open UTC window [from, to) covering the last N whole plant days ending
 * yesterday (today is still open). N=7 → the seven days before today.
 */
function lastWholeDays(n, now = new Date()) {
  const today = plantDateString(now)
  return {
    from: startOfPlantDay(addPlantDays(today, -n)),
    to: startOfPlantDay(today),
    fromDay: addPlantDays(today, -n),
    toDay: addPlantDays(today, -1),
  }
}

/**
 * Half-open UTC window of the most recent COMPLETE ISO week (Monday 00:00 →
 * next Monday 00:00, plant time). On a Monday morning this is last week.
 */
function lastIsoWeek(now = new Date()) {
  const p = plantParts(now)
  const today = plantDateString(now)
  const daysSinceMonday = (p.weekday + 6) % 7      // Mon=0 … Sun=6
  const thisMonday = addPlantDays(today, -daysSinceMonday)
  const lastMonday = addPlantDays(thisMonday, -7)
  return {
    from: startOfPlantDay(lastMonday),
    to: startOfPlantDay(thisMonday),
    fromDay: lastMonday,
    toDay: addPlantDays(thisMonday, -1),
  }
}

module.exports = {
  PLANT_TZ,
  plantParts,
  plantDateString,
  startOfPlantDay,
  addPlantDays,
  lastWholeDays,
  lastIsoWeek,
}
