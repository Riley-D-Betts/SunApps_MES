// OpenAPI spec, built from @openapi JSDoc annotations that live next to each
// route. swagger-ui-express serves it at /api-docs (see server.js), and
// `npm run build:openapi` writes it to openapi.json for the docs catalog.
const path = require('path')
const swaggerJsdoc = require('swagger-jsdoc')
const pkg = require('../package.json')

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'SunApps MES',
      version: pkg.version,
      description:
        'Plant-floor MES service for the IdaMilk creamery. Cron jobs poll the AVEVA ' +
        'Historian for separator batches, bulk milk intake, blend tanks, surge tanks and ' +
        'equipment state, turn them into NetSuite work orders / issues / completions / ' +
        'inventory adjustments, and record every batch locally. On top of that it exposes ' +
        'a rich read-only /api/historian query gateway over the plant historian, live ' +
        'status and analytics feeds for the SunApps UI, operator review endpoints for ' +
        'batches that failed to post to NetSuite, a BOM admin surface, and a replay ' +
        '(time-travel simulation) control panel.',
    },
    servers: [
      { url: 'http://localhost:4005', description: 'Local / on-prem (default PORT)' },
    ],
    // No authentication middleware exists on this service — it is an internal,
    // network-isolated plant-floor service reached only from the LAN (and via
    // SunApps_Gateway). Every route below is reachable unauthenticated.
    security: [],
    tags: [
      { name: 'Health', description: 'Liveness and poller freshness' },
      {
        name: 'Historian',
        description:
          'Read-only query gateway over the AVEVA Historian (OData v2 REST API). ' +
          'Tag search and metadata, current values, raw and aggregated history, ' +
          'alarm/event history, and the in-memory poll store. `fqn` path params are ' +
          'fully-qualified tag names, e.g. `ColdMilkSeparator1.CurrentWO`.',
      },
      { name: 'Live Status', description: 'Live snapshot of what the pollers are currently seeing' },
      { name: 'Separation', description: 'Cold-milk separator batches — ingest, review, retry/reject' },
      { name: 'Bulk Milk', description: 'Bulk milk intake runs and their NetSuite work orders' },
      { name: 'Blend Tanks', description: 'Blend tank batches — WO events, components, ingredient issues, review' },
      { name: 'Surge Tanks', description: 'Surge tank batches and their review queue' },
      { name: 'FG Pairings', description: 'Finished-good ⇐ raw-input pairing approvals' },
      { name: 'Analytics', description: 'Batch history, trends, and per-batch detail for the analytics UI' },
      { name: 'Inventory Adjustments', description: 'Historian-driven inventory adjustments, their NetSuite correlations, and review' },
      { name: 'BOM Admin', description: 'Read/preview/commit NetSuite assembly BOM revisions' },
      { name: 'Filler Hours', description: 'Historical filler time-in-state for the Machine Efficiency report' },
      { name: 'Replay', description: 'Time-travel simulation control (replay mode, sim clock, dev reset)' },
    ],
  },
  // Scan the route files (and server.js, which owns /health) for @openapi blocks.
  apis: [
    path.join(__dirname, '..', 'routes', '*.js'),
    path.join(__dirname, '..', 'server.js'),
  ],
}

const openapiSpec = swaggerJsdoc(options)

module.exports = { openapiSpec }
