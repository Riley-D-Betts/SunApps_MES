// Writes the OpenAPI spec (built from @openapi route annotations) to
// openapi.json at the repo root, where the docs catalog extractor reads it.
// Run after changing any route annotation: `npm run build:openapi`.
const fs = require('fs')
const path = require('path')
const { openapiSpec } = require('../config/swagger')

const out = path.join(__dirname, '..', 'openapi.json')
fs.writeFileSync(out, JSON.stringify(openapiSpec, null, 2) + '\n')

const pathCount = Object.keys(openapiSpec.paths || {}).length
const opCount = Object.values(openapiSpec.paths || {}).reduce(
  (n, methods) => n + Object.keys(methods).length,
  0
)
console.log(`Wrote ${path.relative(process.cwd(), out)} — ${pathCount} paths, ${opCount} operations.`)
