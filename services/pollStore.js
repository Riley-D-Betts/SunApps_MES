/**
 * In-memory poll store — records every tag value fetched via the live polling
 * endpoints so they can be queried as historical data later.
 *
 * Data structure:
 *   store = Map<fqn, Array<{ DateTime: string, Value, Text, OpcQuality }>>
 *
 * Entries are kept for MAX_AGE_MS (default 7 days).
 * MAX_POINTS_PER_TAG caps memory per tag (default 50,000 points — ~5.8 days at 10s).
 */

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000   // 7 days
const MAX_POINTS_PER_TAG = 50_000

// Map<fqn: string, points: Array<{DateTime, Value, Text, OpcQuality}>>
const store = new Map()

/**
 * Record a batch of tag values returned from a live poll.
 * @param {Array<{ fqn: string, value: object|null }>} tagResults
 */
function record(tagResults) {
  const now = Date.now()
  for (const { fqn, value } of tagResults) {
    if (!value) continue

    if (!store.has(fqn)) store.set(fqn, [])
    const points = store.get(fqn)

    points.push({
      DateTime: value.DateTime || new Date().toISOString(),
      Value: value.Value,
      Text: value.Text,
      OpcQuality: value.OpcQuality,
      _polled: true,
    })

    // Trim old entries beyond max age
    const cutoff = now - MAX_AGE_MS
    let i = 0
    while (i < points.length && new Date(points[i].DateTime).getTime() < cutoff) i++
    if (i > 0) points.splice(0, i)

    // Cap max points (keep newest)
    if (points.length > MAX_POINTS_PER_TAG) {
      points.splice(0, points.length - MAX_POINTS_PER_TAG)
    }
  }
}

/**
 * Query stored points for a tag within a time range.
 * @param {string} fqn
 * @param {Date} [since]
 * @param {Date} [until]
 * @returns {Array<{DateTime, Value, Text, OpcQuality, _polled}>}
 */
function query(fqn, since, until) {
  const points = store.get(fqn) || []
  return points.filter(p => {
    const t = new Date(p.DateTime).getTime()
    if (since && t < since.getTime()) return false
    if (until && t > until.getTime()) return false
    return true
  })
}

/**
 * List all FQNs currently in the store.
 * @returns {string[]}
 */
function listFqns() {
  return [...store.keys()]
}

/**
 * Return point counts per FQN (useful for /health debugging).
 */
function stats() {
  const result = {}
  for (const [fqn, points] of store.entries()) {
    result[fqn] = points.length
  }
  return result
}

module.exports = { record, query, listFqns, stats }
