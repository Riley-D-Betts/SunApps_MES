#!/usr/bin/env node
/**
 * Discover all tags from the Historian API and write scripts/all-tags.json.
 *
 * Usage:  node scripts/discoverTags.js
 */

const path = require('path')
const fs = require('fs')
const dotenv = require('dotenv')
const httpntlm = require('httpntlm')

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const BASE_URL = process.env.HISTORIAN_BASE_URL
const DOMAIN = process.env.HISTORIAN_DOMAIN || ''
const USERNAME = process.env.HISTORIAN_USERNAME
const PASSWORD = process.env.HISTORIAN_PASSWORD

if (!BASE_URL || !USERNAME || !PASSWORD) {
  console.error('Missing HISTORIAN_BASE_URL, HISTORIAN_USERNAME, or HISTORIAN_PASSWORD in .env')
  process.exit(1)
}

function ntlmGet(url) {
  return new Promise((resolve, reject) => {
    httpntlm.get({
      url,
      domain: DOMAIN,
      username: USERNAME,
      password: PASSWORD,
      headers: { 'Accept': 'application/json' },
    }, (err, res) => {
      if (err) return reject(err)
      if (res.statusCode !== 200) {
        return reject(new Error(`Historian API ${res.statusCode}: ${String(res.body).slice(0, 300)}`))
      }
      try {
        const body = String(res.body).replace(/^﻿/, '')
        resolve(JSON.parse(body))
      } catch (e) {
        reject(new Error(`Invalid JSON: ${String(res.body).slice(0, 300)}`))
      }
    })
  })
}

async function main() {
  const allTags = []
  let url = `${BASE_URL}/Tags?$select=FQN,Description,TagType,EngUnit`
  let page = 1

  while (url) {
    console.log(`Fetching page ${page}...`)
    const data = await ntlmGet(url)
    allTags.push(...data.value)
    url = data['@odata.nextLink'] || null
    page++
  }

  console.log(`\nTotal tags: ${allTags.length}\n`)

  // Group by prefix and print summary
  const prefixes = {}
  allTags.forEach(t => {
    const p = t.FQN.split('.')[0]
    if (!prefixes[p]) prefixes[p] = []
    prefixes[p].push(t)
  })

  console.log('=== EQUIPMENT PREFIXES ===')
  Object.entries(prefixes)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([name, tags]) => {
      console.log(`\n${name} (${tags.length} tags):`)
      tags.forEach(t => {
        console.log(`  ${t.FQN.padEnd(55)} ${t.TagType.padEnd(10)} ${(t.EngUnit || '').padEnd(12)} ${t.Description}`)
      })
    })

  const outPath = path.resolve(__dirname, 'all-tags.json')
  fs.writeFileSync(outPath, JSON.stringify(allTags, null, 2))
  console.log(`\nSaved full tag list to ${outPath}`)
}

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
