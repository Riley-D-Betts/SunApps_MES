const core = require('../clients/coreClient')
const itemConfig = require('./mesItemConfig')
const productParser = require('./surgeTankProductParser')
const lineMapper = require('./lineIngredientMapper')
const nsInventory = require('./nsInventoryLookup')
const config = require('../config')
const db = require('../models')

// UHT software totalizer is gallons; NS workOrder lines run in lbs. Use a
// single density constant — UHT throughput is mixed during product changes,
// and the FG mass-balance accounting doesn't need per-product precision.
const GAL_TO_LBS = 8.6

// Per-process BOM cache, keyed by nsWorkOrderId. Mirrors blendTankMesService.
const _bomCache = new Map()

async function fetchWoBomLines(nsWorkOrderId) {
  if (_bomCache.has(nsWorkOrderId)) return _bomCache.get(nsWorkOrderId)
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const lines = (wo?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id) }))
  console.log(`[SurgeTankMesService] BOM for WO ${nsWorkOrderId}: ${lines.map(l => `line${l.line}=item${l.itemId}`).join(', ') || '(empty)'}`)
  _bomCache.set(nsWorkOrderId, lines)
  return lines
}

function clearBomCache(nsWorkOrderId) {
  _bomCache.delete(nsWorkOrderId)
}

// Mirror of blendTankMesService.ensureItemOnWoBom — see that file for the
// detailed rationale. PATCHes the WO to append targetItemId at qty=0 when
// missing from the BOM, refetches for the line number, and mutates bomLines
// + cache in place.
async function ensureItemOnWoBom(nsWorkOrderId, targetItemId, bomLines) {
  const targetIdStr = String(targetItemId)
  const existing = bomLines.find(c => String(c.itemId) === targetIdStr)
  if (existing) return existing

  console.log(`[SurgeTankMesService] Item ${targetIdStr} not on WO ${nsWorkOrderId} BOM (lines: ${bomLines.map(b => b.itemId).join(', ') || '(empty)'}) — PATCHing to append`)
  const wrap = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?expandSubResources=true`)
  const wo = wrap?.body || wrap
  const merged = (wo?.item?.items || []).map(c => ({
    item: { id: String(c.item?.id) },
    quantity: c.quantity,
    ...(c.units?.id ? { units: { id: String(c.units.id) } } : {}),
  }))
  merged.push({ item: { id: targetIdStr }, quantity: 0 })
  await core.netsuitePatch(`/record/v1/workOrder/${nsWorkOrderId}`, { item: { items: merged } })

  const refetched = (await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?expandSubResources=true`))?.body
  const newLines = (refetched?.item?.items || []).map(c => ({ line: c.line, itemId: String(c.item?.id) }))
  const newRow = newLines.find(c => c.itemId === targetIdStr)
  if (!newRow) throw new Error(`PATCH appended item ${targetIdStr} to WO ${nsWorkOrderId} but it didn't appear on refetch`)
  console.log(`[SurgeTankMesService] Item ${targetIdStr} added to WO ${nsWorkOrderId} at line ${newRow.line}`)

  _bomCache.set(nsWorkOrderId, newLines)
  bomLines.length = 0
  bomLines.push(...newLines)
  return newRow
}

// Mirror of blendTankMesService.buildWoIssueBody — see that file for the
// detailed rationale. Lowercase componentinventorydetail + omit non-target
// lines + raw string IDs. Looks up tracking class (lot / bin / both) and
// allocations from NS via nsInventoryLookup.
async function buildWoIssueBody(nsWorkOrderId, targetItemId, quantity, preferredBinId, bomLines) {
  const tracking = await nsInventory.getItemTracking(targetItemId)
  const targetLine = await ensureItemOnWoBom(nsWorkOrderId, targetItemId, bomLines)

  let allocations = null
  if (tracking.isLot) {
    allocations = await nsInventory.findInventoryAllocations(targetItemId, quantity, preferredBinId)
    const allocatedQty = allocations.reduce((s, a) => s + a.qty, 0)
    if (allocatedQty + 1e-6 < quantity) {
      const err = new Error(`Insufficient inventory for item ${targetItemId}: need ${quantity}, found ${allocatedQty} across ${allocations.length} lot(s)`)
      err.code = 'INSUFFICIENT_INVENTORY'
      err.itemId = targetItemId
      err.needed = quantity
      err.available = allocatedQty
      err.allocations = allocations
      throw err
    }
  }

  const assignmentItems = nsInventory.buildAssignmentItems(tracking, quantity, allocations, preferredBinId)

  const componentEntry = { lineNumber: targetLine.line, quantity }
  if (assignmentItems && assignmentItems.length > 0) {
    componentEntry.componentinventorydetail = {
      inventoryassignment: { items: assignmentItems },
    }
  }

  return {
    body: { component: { items: [componentEntry] } },
    allocations,
    tracking,
  }
}

function extractNsIssueId(nsResult) {
  if (nsResult?.body?.id) return String(nsResult.body.id)
  if (nsResult?.id) return String(nsResult.id)
  const loc = nsResult?.headers?.location
  if (loc) {
    const m = String(loc).match(/\/(\d+)$/)
    if (m) return m[1]
  }
  return null
}

function isBlendTankRef(name) {
  return typeof name === 'string' && /^blendtank[12][ab]$/i.test(name.replace(/\s+/g, ''))
}

function isSiloRef(name) {
  if (!name) return false
  if (/^[MC]Silo\d+$/i.test(name)) return true
  return !!itemConfig.normalizeSiloName(name)
}

/**
 * Decide the single component item that the surge tank's Layer-3 WO should
 * consume, based on what's physically feeding the UHT at WO-create time, and
 * tag the (FG, component) pairing as approved or pending review by looking it
 * up in MesFgInputPairings.
 *
 * The result is pinned to MesSurgeTankBatch (componentItemId/Bin/From,
 * layerSkipReason, pairingStatus) and the component is also sent as a custom
 * one-line list on the workOrder create body — every subsequent tick issue
 * runs against this same item. Returns null if the source can't be resolved
 * yet (caller defers).
 *
 *   fgItem    — Layer-3 assembly we're about to build (FG, e.g. 4498 Kirkland 2%)
 *   data      — { feedingFromEntName, feedingUhtId } from the surge-tank job
 *   historian — provider for getMilkLineStatus()
 *
 * Pairing semantics: any (fgItemId, componentItemId) combo not present in
 * MesFgInputPairings is auto-inserted as status='pending' and the batch is
 * flagged pending_review. WO + ticks still fire — physical milk flow happened.
 * Ops reviews pending rows via the /api/mes/fg-pairings UI and either approves
 * or leaves them pending forever (no blocklist).
 */
async function resolveLayer3Component(data, historian, fgItem) {
  const resolved = await _resolveLayer3Source(data, historian)
  if (!resolved) return null

  const fgItemId = fgItem?.id ? Number(fgItem.id) : null
  if (!fgItemId) return { ...resolved, pairingStatus: null }

  const rawInputItemId = Number(resolved.itemId)
  const pair = await db.MesFgInputPairing.findOne({
    where: { fgItemId, rawInputItemId },
  })

  let pairingStatus
  if (pair?.status === 'approved') {
    pairingStatus = 'ok'
  } else {
    pairingStatus = 'pending_review'
    if (!pair) {
      try {
        await db.MesFgInputPairing.create({
          fgItemId,
          rawInputItemId,
          status: 'pending',
          fgName: fgItem.name || null,
          rawInputName: resolved.itemName || null,
          createdBy: 'auto',
        })
        console.log(`[SurgeTankMesService] New pairing flagged for review: FG ${fgItemId} (${fgItem.name}) ← raw ${rawInputItemId} (${resolved.itemName})`)
      } catch (err) {
        // Race: a concurrent batch inserted the same pairing first — fine.
        if (err.name !== 'SequelizeUniqueConstraintError') {
          console.warn(`[SurgeTankMesService] Failed to log pending pairing: ${err.message}`)
        }
      }
    } else {
      console.log(`[SurgeTankMesService] Pairing still pending review: FG ${fgItemId} ← raw ${rawInputItemId} (id=${pair.id})`)
    }
  }
  return { ...resolved, pairingStatus }
}

// Inner: resolve which NS item feeds the surge WO, agnostic of pairing status.
// Returns { itemId, itemName, binId, resolvedFrom, layerSkipReason } or null.
async function _resolveLayer3Source(data, historian) {
  const feedingFromEntName = data.feedingFromEntName
  const feedingUhtId = data.feedingUhtId
  if (!feedingFromEntName) return null

  if (isBlendTankRef(feedingFromEntName)) {
    let blendBatch = await db.MesBlendTankBatch.findOne({
      where: { tankId: feedingFromEntName, status: 'active' },
      order: [['detectedAt', 'DESC']],
    })
    if (!blendBatch?.mesItem) {
      // Blend tank may have finished before the surge batch resolved. Fall back
      // to the most recent batch on that tank within 48 h that actually completed
      // some product (cumulativeCompletedLbs > 0). Phantom batches (9-second
      // NOTE_STRING transients with 0 lbs) are explicitly excluded — they have
      // no NS inventory and would cause every surge tick to fail with
      // "Insufficient inventory".
      blendBatch = await db.MesBlendTankBatch.findOne({
        where: {
          tankId: feedingFromEntName,
          status: 'completed',
          mesItem: { [db.Sequelize.Op.ne]: null },
          cumulativeCompletedLbs: { [db.Sequelize.Op.gt]: 0 },
          detectedAt: { [db.Sequelize.Op.gte]: new Date(Date.now() - 72 * 60 * 60 * 1000) },
        },
        order: [['detectedAt', 'DESC']],
      })
    }
    if (!blendBatch?.mesItem) {
      console.warn(`[SurgeTankMesService] _resolveLayer3Source: no blend batch (active or recent with completions) on ${feedingFromEntName} — deferring`)
      return null
    }
    const resolvedFrom = blendBatch.status === 'active' ? 'blend-tank' : 'blend-tank-recent'
    return {
      itemId: String(blendBatch.mesItem),
      itemName: blendBatch.productName,
      binId: itemConfig.getBinId(feedingFromEntName),
      resolvedFrom,
      layerSkipReason: null,
    }
  }

  if (isSiloRef(feedingFromEntName)) {
    const silo = itemConfig.normalizeSiloName(feedingFromEntName) || feedingFromEntName
    if (feedingUhtId) {
      try {
        const lineReadings = await historian.getMilkLineStatus()
        const feedingLine = lineReadings.find(r => {
          const dest = String(r.requestedBy || '').toUpperCase()
          return dest.includes(feedingUhtId.toUpperCase())
        })
        if (feedingLine?.productName) {
          const lineItem = lineMapper.resolveLineProduct(feedingLine.productName)
          if (lineItem?.id) {
            const skipReason = itemConfig.isBulkRawId(lineItem.id) ? 'layer-1-and-2-skip' : 'layer-2-skip'
            return {
              itemId: String(lineItem.id),
              itemName: lineItem.name,
              binId: itemConfig.getBinId(feedingLine.siloName || silo),
              resolvedFrom: 'silo-line-product',
              layerSkipReason: skipReason,
            }
          }
        }
      } catch (err) {
        console.warn(`[SurgeTankMesService] _resolveLayer3Source: line lookup failed — ${err.message}`)
      }
    }
    const fallback = itemConfig.SILO_ITEM_MAP[silo]
    if (!fallback) {
      console.warn(`[SurgeTankMesService] _resolveLayer3Source: no SILO_ITEM_MAP entry for ${silo}`)
      return null
    }
    return {
      itemId: String(fallback.id),
      itemName: fallback.name,
      binId: itemConfig.getBinId(silo),
      resolvedFrom: 'silo-bulk-fallback',
      layerSkipReason: 'layer-1-and-2-skip',
    }
  }

  console.warn(`[SurgeTankMesService] _resolveLayer3Source: unknown feeding source: ${feedingFromEntName}`)
  return null
}

/**
 * Resolve the NS component item to issue against the surge-tank WO.
 *
 * Two paths:
 *   - feedingFromEntName is a blend tank → fetch active MesBlendTankBatch and
 *     use its `mesItem`. Source bin is TANK_BIN_MAP[blendTankId].
 *   - feedingFromEntName is a silo → fetch the milk-line reading whose
 *     destination contains the UHT, then run lineMapper.resolveLineProduct
 *     on that line's productName. Falls back to SILO_ITEM_MAP if no line
 *     is currently feeding the UHT.
 *
 * Returns { itemId, itemName, binId, resolvedFrom } or null when nothing
 * resolves (caller will defer the tick and try again next time).
 */
async function resolveSurgeTankComponent(batch, historian) {
  // New path: tick uses the component pinned at WO-create. Skip every
  // historian/blend-batch lookup the legacy resolver did — the answer is on
  // the row already, and the WO's BOM has exactly this item.
  if (batch.componentItemId) {
    return {
      itemId: String(batch.componentItemId),
      itemName: batch.productName,
      binId: batch.componentBinId != null ? Number(batch.componentBinId) : null,
      resolvedFrom: batch.componentResolvedFrom || 'pinned',
    }
  }

  let feedingFromEntName = batch.feedingFromEntName
  const feedingUhtId = batch.feedingUhtId
  if (!feedingFromEntName) {
    // Retroactive recovery: batches started before the feedingFromEntName fix
    // have null here. Try the live valve-based value from the current UHT status.
    if (!feedingUhtId || !historian) return null
    try {
      const uhtList = await historian.getUhtStatus()
      const uhtStatus = uhtList.find(u => u.uhtId === feedingUhtId)
      feedingFromEntName = uhtStatus?.fromEntName || null
    } catch (err) {
      console.warn(`[SurgeTankMesService] resolveSurgeTankComponent: live UHT lookup failed — ${err.message}`)
    }
    if (!feedingFromEntName) return null
    // Pin it so future ticks skip this lookup.
    await batch.update({ feedingFromEntName })
    console.log(`[SurgeTankMesService] Retroactively pinned feedingFromEntName="${feedingFromEntName}" on batch ${batch.id} (${batch.tankId})`)
  }

  if (isBlendTankRef(feedingFromEntName)) {
    let blendBatch = await db.MesBlendTankBatch.findOne({
      where: { tankId: feedingFromEntName, status: 'active' },
      order: [['detectedAt', 'DESC']],
    })
    if (!blendBatch?.mesItem) {
      // Same phantom-exclusion filter as _resolveLayer3Source: require > 0 lbs
      // completed and extend to 48h so real older batches aren't missed.
      blendBatch = await db.MesBlendTankBatch.findOne({
        where: {
          tankId: feedingFromEntName,
          status: 'completed',
          mesItem: { [db.Sequelize.Op.ne]: null },
          cumulativeCompletedLbs: { [db.Sequelize.Op.gt]: 0 },
          detectedAt: { [db.Sequelize.Op.gte]: new Date(Date.now() - 72 * 60 * 60 * 1000) },
        },
        order: [['detectedAt', 'DESC']],
      })
    }
    if (!blendBatch?.mesItem) {
      console.warn(`[SurgeTankMesService] No blend-tank batch (active or recent with completions) on ${feedingFromEntName} — cannot resolve component`)
      return null
    }
    const resolvedFrom = blendBatch.status === 'active' ? 'blend-tank-batch' : 'blend-tank-batch-recent'
    return {
      itemId: String(blendBatch.mesItem),
      itemName: blendBatch.productName,
      binId: itemConfig.getBinId(feedingFromEntName),
      resolvedFrom,
    }
  }

  if (isSiloRef(feedingFromEntName)) {
    const silo = itemConfig.normalizeSiloName(feedingFromEntName) || feedingFromEntName
    let resolved = null
    if (feedingUhtId) {
      try {
        const lineReadings = await historian.getMilkLineStatus()
        const feedingLine = lineReadings.find(r => {
          const dest = String(r.requestedBy || '').toUpperCase()
          return dest.includes(feedingUhtId.toUpperCase())
        })
        if (feedingLine?.productName) {
          const lineItem = lineMapper.resolveLineProduct(feedingLine.productName)
          if (lineItem?.id) {
            resolved = {
              itemId: String(lineItem.id),
              itemName: lineItem.name,
              binId: itemConfig.getBinId(feedingLine.siloName || silo),
              resolvedFrom: 'silo-line-product',
            }
          }
        }
      } catch (err) {
        console.warn(`[SurgeTankMesService] resolveSurgeTankComponent: line lookup failed — ${err.message}`)
      }
    }
    if (resolved) return resolved
    // Last-resort fallback — silo's static raw item (whole milk).
    const fallback = itemConfig.SILO_ITEM_MAP[silo]
    if (!fallback) {
      console.warn(`[SurgeTankMesService] No SILO_ITEM_MAP entry for ${silo}`)
      return null
    }
    return {
      itemId: String(fallback.id),
      itemName: fallback.name,
      binId: itemConfig.getBinId(silo),
      resolvedFrom: 'silo-static',
    }
  }

  console.warn(`[SurgeTankMesService] Unknown feeding source: ${feedingFromEntName}`)
  return null
}

async function processWOStart(data, historian) {
  const { tankId, productName, fgItemId, feedingUhtId, feedingFromEntName, detectedAt } = data

  if (!tankId) throw new Error('tankId is required')
  if (!productName) throw new Error('productName is required')

  const existing = await db.MesSurgeTankBatch.findOne({
    where: { tankId, productName, status: ['active', 'dry_run'] },
  })
  if (existing) {
    console.log(`[SurgeTankMesService] "${productName}" on ${tankId} already active (status: ${existing.status}, nsWO: ${existing.nsWorkOrderId || 'none'}) — skipping`)
    return { success: true, duplicate: true, tankId, productName, status: existing.status }
  }

  const COOLDOWN_MINUTES = 5
  const recentBatch = await db.MesSurgeTankBatch.findOne({
    where: {
      tankId,
      detectedAt: { [db.Sequelize.Op.gte]: new Date(Date.now() - COOLDOWN_MINUTES * 60 * 1000) },
    },
    order: [['detectedAt', 'DESC']],
  })
  if (recentBatch) {
    const ageSec = Math.round((Date.now() - new Date(recentBatch.detectedAt).getTime()) / 1000)
    console.warn(`[SurgeTankMesService] COOLDOWN: "${productName}" on ${tankId} rejected — last batch "${recentBatch.productName}" was ${ageSec}s ago (min ${COOLDOWN_MINUTES * 60}s)`)
    return { success: true, cooldown: true, tankId, productName, lastBatchAge: ageSec }
  }

  // Override path — config or caller can pin an FG item ID directly, skipping
  // the parser (used by SURGE_TANK_OVERRIDES for sandbox testing).
  const overrideItemId = fgItemId || config.SURGE_TANK_OVERRIDES?.[tankId]
  let parsed, assemblyItem
  if (overrideItemId) {
    const overrideCatalog = productParser.getProductByNsId(overrideItemId)
    const overrideName = overrideCatalog?.name || `NS item ${overrideItemId}`
    console.log(`[SurgeTankMesService] OVERRIDE: ${tankId} → NS item ${overrideItemId} (${overrideName}) — skipping parser`)
    parsed = { nsId: overrideItemId, name: overrideName, confidence: 'override', score: 0, parsed: { override: true, productName } }
    assemblyItem = { id: overrideItemId, name: overrideName, confidence: 'override' }
  } else {
    parsed = productParser.parseProductName(productName)
    assemblyItem = parsed
      ? { id: parsed.nsId, name: parsed.name, confidence: parsed.confidence }
      : { id: null, name: `Unrecognized: "${productName}"`, confidence: 'none' }
  }

  console.log(`[SurgeTankMesService] Processing batch start: ${tankId} / "${productName}"`)
  console.log(`  Parsed: ${assemblyItem.name} (NS ${assemblyItem.id}, confidence: ${assemblyItem.confidence})`)
  console.log(`  Feeding: ${feedingFromEntName || '?'} via ${feedingUhtId || '?'}`)

  // Resolve the Layer-3 component (the single raw FG / silo-direct item this WO
  // will consume). Pinning at create-time means the tick never re-resolves and
  // the WO body carries a custom one-line component list scoped to exactly this.
  let resolvedComponent = null
  if (assemblyItem.id && historian) {
    try {
      resolvedComponent = await resolveLayer3Component(data, historian, assemblyItem)
    } catch (err) {
      console.warn(`[SurgeTankMesService] resolveLayer3Component threw — proceeding without pin: ${err.message}`)
    }
  }
  if (resolvedComponent) {
    console.log(`  Layer-3 component: NS ${resolvedComponent.itemId} (${resolvedComponent.itemName}) from ${resolvedComponent.resolvedFrom}${resolvedComponent.layerSkipReason ? ` [${resolvedComponent.layerSkipReason}]` : ''} (pairing: ${resolvedComponent.pairingStatus || 'n/a'})`)
  }

  const record = await db.MesSurgeTankBatch.create({
    tankId,
    productName,
    mesItem: parsed?.nsId ? String(parsed.nsId) : null,
    feedingUhtId: feedingUhtId || null,
    feedingFromEntName: feedingFromEntName || null,
    componentItemId: resolvedComponent?.itemId || null,
    componentBinId: resolvedComponent?.binId || null,
    componentResolvedFrom: resolvedComponent?.resolvedFrom || null,
    layerSkipReason: resolvedComponent?.layerSkipReason || null,
    pairingStatus: resolvedComponent?.pairingStatus || null,
    parserConfidence: assemblyItem.confidence,
    status: 'active',
    detectedAt: detectedAt || new Date(),
  })

  let nsResult = null
  try {
    if (config.MES_DRY_RUN) {
      console.log(`[SurgeTankMesService] DRY RUN — "${productName}" saved, skipping NS creation`)
      await record.update({ status: 'dry_run' })
      await db.MesProcessingLog.create({
        eventType: 'surge_tank_wo_create', sourceId: `${tankId}:${productName}`,
        nsTransactionType: 'workOrder', payload: JSON.stringify(data),
        result: JSON.stringify({ dryRun: true, parsed }), success: true,
      })
      return { success: true, duplicate: false, tankId, productName, status: 'dry_run', parsed }
    }

    if (!assemblyItem.id) {
      console.log(`[SurgeTankMesService] No NS item for "${productName}" — skipping NS WO creation`)
      await record.update({ status: 'pending_ns' })
      await db.MesProcessingLog.create({
        eventType: 'surge_tank_wo_create', sourceId: `${tankId}:${productName}`,
        nsTransactionType: 'workOrder', payload: JSON.stringify(data),
        result: JSON.stringify({ skipped: 'product not recognized', parsed }), success: true,
      })
      return { success: true, duplicate: false, tankId, productName, status: 'pending_ns', parsed }
    }

    const body = {
      assemblyItem: { id: assemblyItem.id },
      quantity: 1,
      location: { id: 23 },
      subsidiary: { id: 2 },
      // isWip MUST be true — see blendTankMesService.processWOStart for the
      // discovery context. NS rejects every workOrderIssue against a WO with
      // isWip=false ("the work order does not use WIP, or the work order is
      // already closed").
      isWip: true,
      custbody_mes_tank_id: tankId,
      custbody_mes_product_name: productName,
      custbody_mes_source_entity: feedingFromEntName || null,
      custbody_mes_dest_entity: tankId,
    }
    // Custom one-line component list pins the WO's BOM to the resolved Layer-3
    // component (raw FG / silo-direct). Without this, NS would default-populate
    // the assembly's static BOM, which won't match in skip-paths.
    if (resolvedComponent?.itemId) {
      body.item = {
        items: [{
          item: { id: Number(resolvedComponent.itemId) },
          quantity: 1,
        }],
      }
    }

    console.log(`[SurgeTankMesService] Creating NS WO for "${productName}" on ${tankId}`)
    nsResult = await core.netsuitePost('/record/v1/workOrder', body)
    console.log(`[SurgeTankMesService] NS WO response: status=${nsResult?.status}`)

    let nsWorkOrderId = nsResult?.id || null
    let nsWorkOrderNumber = nsResult?.tranid || null

    if (!nsWorkOrderId && nsResult?.headers?.location) {
      const match = nsResult.headers.location.match(/\/(\d+)$/)
      if (match) {
        nsWorkOrderId = match[1]
        try {
          const woDetail = await core.netsuiteGet(`/record/v1/workOrder/${nsWorkOrderId}?fields=tranId`)
          const woBody = woDetail?.body || woDetail
          nsWorkOrderNumber = woBody?.tranId || woBody?.tranid || null
        } catch (e) {
          console.warn(`[SurgeTankMesService] Could not fetch WO details: ${e.message}`)
        }
      }
    }

    await record.update({ nsWorkOrderId, nsWorkOrderNumber, status: 'active' })
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_wo_create', sourceId: `${tankId}:${productName}`,
      nsTransactionType: 'workOrder', nsTransactionId: nsWorkOrderId,
      payload: JSON.stringify(data), result: JSON.stringify(nsResult), success: true,
    })

    console.log(`[SurgeTankMesService] "${productName}" → NS WO ${nsWorkOrderNumber} (${nsWorkOrderId})`)
    return { success: true, duplicate: false, tankId, productName, nsWorkOrderId, nsWorkOrderNumber, status: 'active', parsed }

  } catch (err) {
    console.error(`[SurgeTankMesService] Failed to create NS WO for "${productName}":`, err.message)
    await record.update({ status: 'error', errorMessage: err.message })
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_wo_create', sourceId: `${tankId}:${productName}`,
      nsTransactionType: 'workOrder', payload: JSON.stringify(data), success: false, errorMessage: err.message,
    })
    throw err
  }
}

/**
 * End-of-batch — fired when the surge tank product clears or empties out.
 * Flush any final issue + completion delta, then close.
 */
async function processWOEnd(data, historian) {
  const { tankId, productName, detectedAt } = data
  if (!tankId) throw new Error('tankId is required')

  const where = { tankId, status: 'active' }
  if (productName) where.productName = productName

  const record = await db.MesSurgeTankBatch.findOne({ where })
  if (!record) {
    console.log(`[SurgeTankMesService] No active batch for ${tankId}${productName ? ` / "${productName}"` : ''} — ignoring end event`)
    return { success: true, message: 'No active batch found' }
  }

  // Final flush — pull any last UHT-totalizer delta into NS, then close.
  let flushedIssue = false
  let flushedCompletion = false
  try {
    flushedIssue = await tickIssueForBatch(record, historian)
    if (flushedIssue) await record.reload()
    flushedCompletion = await tickCompletionForBatch(record)
  } catch (err) {
    console.error(`[SurgeTankMesService] Final flush failed for ${tankId}:`, err.message)
  }
  await record.reload()

  await record.update({ status: 'completed', completedAt: detectedAt || new Date() })
  if (record.nsWorkOrderId) clearBomCache(record.nsWorkOrderId)
  await db.MesProcessingLog.create({
    eventType: 'surge_tank_wo_complete',
    sourceId: `${tankId}:${record.productName}`,
    nsTransactionType: 'workOrderCompletion',
    nsTransactionId: record.nsWorkOrderId,
    payload: JSON.stringify(data),
    result: JSON.stringify({
      completed: true,
      cumulativeIssuedLbs: parseFloat(record.cumulativeIssuedLbs) || 0,
      cumulativeCompletedLbs: parseFloat(record.cumulativeCompletedLbs) || 0,
      flushedIssue,
      flushedCompletion,
    }),
    success: true,
  })

  console.log(`[SurgeTankMesService] Batch "${record.productName}" on ${tankId} closed — issued ${parseFloat(record.cumulativeIssuedLbs).toFixed(0)} lb, completed ${parseFloat(record.cumulativeCompletedLbs).toFixed(0)} lb`)
  return {
    success: true,
    tankId,
    productName: record.productName,
    status: 'completed',
    cumulativeIssuedLbs: parseFloat(record.cumulativeIssuedLbs) || 0,
    cumulativeCompletedLbs: parseFloat(record.cumulativeCompletedLbs) || 0,
  }
}

/**
 * Read the UHT software totalizer, compute delta vs the last fire baseline,
 * and POST a workOrderIssue for the new flow. Component is resolved per-tick
 * because the UHT may swap from one blend tank to another mid-batch (uncommon,
 * but the architecture supports it).
 */
async function tickIssueForBatch(batch, historian) {
  if (!batch.feedingUhtId) {
    console.warn(`[SurgeTankMesService] batch ${batch.id} (${batch.tankId}) has no feedingUhtId — skip`)
    return false
  }

  const currentGal = await historian.getUhtMilkTotalizer(batch.feedingUhtId)
  const observedAt = new Date()

  let state = await db.MesSurgeTankIssueState.findOne({
    where: { surgeTankBatchId: batch.id, uhtId: batch.feedingUhtId },
  })
  if (!state) {
    // Baseline on the current totalizer so the first tick only issues the
    // delta that accumulates AFTER this batch started, not the entire UHT
    // run history since the last IDLE→PROCESS reset. The accumulator
    // (_uhtMilkGal) is in-memory and never resets between consecutive surge
    // batches, so initialising to 0 would try to issue hundreds of thousands
    // of gallons on the very first tick and always fail for insufficient inventory.
    state = await db.MesSurgeTankIssueState.create({
      surgeTankBatchId: batch.id,
      uhtId: batch.feedingUhtId,
      lastIssuedUhtGal: currentGal,
      lastTotalizerGal: currentGal,
      lastObservedAt: observedAt,
      lastFromEntName: batch.feedingFromEntName || null,
    })
  }

  const lastIssued = parseFloat(state.lastIssuedUhtGal) || 0
  let deltaGal
  if (currentGal >= lastIssued) {
    deltaGal = currentGal - lastIssued
  } else {
    // UHT totalizer reset (IDLE→PROCESS). Pre-reset milk is lost; only issue post-reset.
    deltaGal = currentGal
    console.warn(`[SurgeTankMesService] tick: UHT ${batch.feedingUhtId} totalizer reset (was ${lastIssued.toFixed(1)} gal, now ${currentGal.toFixed(1)} gal) — issuing post-reset value only`)
  }

  await state.update({ lastTotalizerGal: currentGal, lastObservedAt: observedAt })

  const deltaLbs = deltaGal * GAL_TO_LBS
  if (deltaLbs < config.MES_MIN_ISSUE_LBS) return false

  if (config.MES_DRY_RUN) {
    await state.update({ lastIssuedUhtGal: currentGal, lastIssueAt: observedAt })
    await batch.increment({ cumulativeIssuedLbs: deltaLbs })
    await batch.update({ lastIssueAt: observedAt })
    console.log(`[SurgeTankMesService] DRY RUN tick issue UHT ${batch.feedingUhtId} → ${batch.tankId}: ${deltaLbs.toFixed(1)} lb (${deltaGal.toFixed(1)} gal)`)
    return true
  }

  if (!batch.nsWorkOrderId) {
    console.log(`[SurgeTankMesService] tick: batch ${batch.id} (${batch.tankId}) has no NS WO — skipping ${deltaLbs.toFixed(1)} lb delta`)
    return false
  }

  const component = await resolveSurgeTankComponent(batch, historian)
  if (!component?.itemId) {
    console.warn(`[SurgeTankMesService] tick: cannot resolve component for ${batch.tankId} (from ${batch.feedingFromEntName}) — deferring`)
    return false
  }
  if (!component.binId) {
    console.warn(`[SurgeTankMesService] tick: no bin for component source on ${batch.tankId} — deferring (${deltaLbs.toFixed(1)} lb)`)
    return false
  }

  const bomLines = await fetchWoBomLines(batch.nsWorkOrderId)
  // Membership check intentionally removed: the WO was created with a custom
  // one-line component list scoped to component.itemId in processWOStart, so
  // by construction the BOM contains exactly this item. Legacy batches without
  // a pinned component fall through to today's re-resolver path above.

  let body, allocations
  try {
    const built = await buildWoIssueBody(batch.nsWorkOrderId, component.itemId, deltaLbs, component.binId, bomLines)
    body = built.body
    allocations = built.allocations
  } catch (err) {
    console.error(`[SurgeTankMesService] tick issue ${batch.tankId} → WO ${batch.nsWorkOrderId}: buildWoIssueBody failed — ${err.message}`)
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_tick_issue',
      sourceId: batch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue',
      payload: JSON.stringify({ batchId: batch.id, uhtId: batch.feedingUhtId, deltaGal, deltaLbs, component }),
      success: false,
      errorMessage: err.message,
    })
    return false
  }

  try {
    const allocSummary = allocations
      ? ` via ${allocations.map(a => `lot ${a.lotName}@${a.binName} ${a.qty.toFixed(1)}`).join(' + ')}`
      : ''
    console.log(`[SurgeTankMesService] tick issue UHT ${batch.feedingUhtId} → WO ${batch.nsWorkOrderId} (${batch.tankId}): ${deltaLbs.toFixed(1)} lb "${component.itemName}" (NS ${component.itemId}, ${component.resolvedFrom})${allocSummary}`)
    const nsResult = await core.netsuitePost(`/record/v1/workOrder/${batch.nsWorkOrderId}/!transform/workOrderIssue`, body)
    const nsIssueId = extractNsIssueId(nsResult)

    await state.update({
      lastIssuedUhtGal: currentGal,
      lastIssueAt: observedAt,
      lastFromEntName: batch.feedingFromEntName || null,
      lastProductName: component.itemName,
    })
    await batch.increment({ cumulativeIssuedLbs: deltaLbs })
    await batch.update({ lastIssueAt: observedAt })

    await db.MesProcessingLog.create({
      eventType: 'surge_tank_tick_issue',
      sourceId: batch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue',
      nsTransactionId: nsIssueId,
      payload: JSON.stringify({ batchId: batch.id, uhtId: batch.feedingUhtId, deltaGal, deltaLbs, currentGal, component }),
      result: JSON.stringify({ nsIssueId }),
      success: true,
    })
    return true
  } catch (err) {
    console.error(`[SurgeTankMesService] tick issue failed for ${batch.tankId} (WO ${batch.nsWorkOrderId}):`, err.message)
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_tick_issue',
      sourceId: batch.nsWorkOrderId,
      nsTransactionType: 'workOrderIssue',
      payload: JSON.stringify({ batchId: batch.id, uhtId: batch.feedingUhtId, deltaGal, deltaLbs, currentGal }),
      success: false,
      errorMessage: err.message,
    })
    // Don't advance lastIssuedUhtGal — same delta retries next tick.
    return false
  }
}

async function tickCompletionForBatch(batch) {
  const cumulativeIssued = parseFloat(batch.cumulativeIssuedLbs) || 0
  const cumulativeCompleted = parseFloat(batch.cumulativeCompletedLbs) || 0
  const target = cumulativeIssued - cumulativeCompleted

  if (target < config.MES_MIN_COMPLETION_LBS) return false
  if (config.MES_DRY_RUN) {
    await batch.update({ cumulativeCompletedLbs: cumulativeIssued, lastCompletionAt: new Date() })
    console.log(`[SurgeTankMesService] DRY RUN tick completion ${batch.tankId}: ${target.toFixed(1)} lb`)
    return true
  }
  if (!batch.nsWorkOrderId) return false

  const completionBinId = itemConfig.getBinId(batch.tankId)
  const now = new Date()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  const yy = String(now.getFullYear()).slice(-2)
  const woNum = String(batch.nsWorkOrderNumber || '').replace(/\D/g, '')
  const lotNumber = `${mm}${dd}${yy}${woNum}`
  const roundedTarget = Math.round(target * 1000) / 1000
  const assignmentEntry = { quantity: roundedTarget, receiptInventoryNumber: lotNumber }
  if (completionBinId) assignmentEntry.binnumber = String(completionBinId)

  const body = {
    quantity: roundedTarget,
    inventorydetail: {
      inventoryassignment: { items: [assignmentEntry] },
    },
  }

  try {
    console.log(`[SurgeTankMesService] tick completion WO ${batch.nsWorkOrderId} (${batch.tankId}): ${target.toFixed(1)} lb → bin ${completionBinId || 'none'} (cumulative ${cumulativeCompleted.toFixed(1)} → ${cumulativeIssued.toFixed(1)})`)
    const nsResult = await core.netsuitePost(
      `/record/v1/workOrder/${batch.nsWorkOrderId}/!transform/workOrderCompletion`,
      body
    )

    let nsCompletionId = nsResult?.id || null
    if (!nsCompletionId && nsResult?.headers?.location) {
      const m = nsResult.headers.location.match(/\/(\d+)$/)
      if (m) nsCompletionId = m[1]
    }

    await batch.update({
      cumulativeCompletedLbs: cumulativeIssued,
      lastCompletionAt: new Date(),
    })

    await db.MesProcessingLog.create({
      eventType: 'surge_tank_tick_completion',
      sourceId: batch.nsWorkOrderId,
      nsTransactionType: 'workOrderCompletion',
      nsTransactionId: nsCompletionId,
      payload: JSON.stringify({ batchId: batch.id, target, cumulativeIssued, cumulativeCompleted }),
      result: JSON.stringify({ nsCompletionId }),
      success: true,
    })
    return true
  } catch (err) {
    console.error(`[SurgeTankMesService] tick completion failed for WO ${batch.nsWorkOrderId}:`, err.message)
    await db.MesProcessingLog.create({
      eventType: 'surge_tank_tick_completion',
      sourceId: batch.nsWorkOrderId,
      nsTransactionType: 'workOrderCompletion',
      payload: JSON.stringify({ batchId: batch.id, target, cumulativeIssued, cumulativeCompleted }),
      success: false,
      errorMessage: err.message,
    })
    return false
  }
}

async function tickAllActiveBatches(historian) {
  const activeBatches = await db.MesSurgeTankBatch.findAll({ where: { status: 'active' } })
  const summary = { batchesProcessed: 0, issuesFired: 0, completionsFired: 0, errors: [] }
  if (activeBatches.length === 0) return summary

  for (const batch of activeBatches) {
    summary.batchesProcessed++
    try {
      const issued = await tickIssueForBatch(batch, historian)
      if (issued) summary.issuesFired++
    } catch (err) {
      console.error(`[SurgeTankMesService] tick issue failed for batch ${batch.id} (${batch.tankId}):`, err.message)
      summary.errors.push({ phase: 'issues', batchId: batch.id, error: err.message })
    }
    try {
      await batch.reload()
      const completed = await tickCompletionForBatch(batch)
      if (completed) summary.completionsFired++
    } catch (err) {
      console.error(`[SurgeTankMesService] tick completion failed for batch ${batch.id} (${batch.tankId}):`, err.message)
      summary.errors.push({ phase: 'completion', batchId: batch.id, error: err.message })
    }
  }

  return summary
}

module.exports = {
  processWOStart,
  processWOEnd,
  tickIssueForBatch,
  tickCompletionForBatch,
  tickAllActiveBatches,
  resolveSurgeTankComponent,
}
