const core = require('../clients/coreClient')

async function createSeparationUnbuild(data) {
  const { inputItemId, inputVolume, creamItemId, creamVolume, skimItemId, skimVolume, wasteVolume, sourceSilo, batchStart, batchEnd } = data

  if (!inputItemId) throw new Error('inputItemId is required')
  if (!inputVolume || inputVolume <= 0) throw new Error('inputVolume must be greater than 0')
  if (!creamItemId) throw new Error('creamItemId is required')
  if (!skimItemId) throw new Error('skimItemId is required')

  console.log(`[MilkService] Creating separation unbuild: input item ${inputItemId}, qty ${inputVolume}`)

  const body = {
    item: { id: inputItemId },
    quantity: inputVolume,
    custbody_milk_source_silo: sourceSilo,
    custbody_milk_batch_start: batchStart,
    custbody_milk_batch_end: batchEnd,
    custbody_milk_waste_volume: wasteVolume,
    component: {
      items: [
        { item: { id: creamItemId }, quantity: creamVolume },
        { item: { id: skimItemId }, quantity: skimVolume },
      ],
    },
  }

  try {
    const result = await core.netsuitePost('/record/v1/assemblyUnbuild', body)
    return { success: true, unbuildId: result?.id || null, response: result }
  } catch (err) {
    if (err.message?.includes('404') || err.message?.includes('not found')) {
      console.warn('[MilkService] assemblyUnbuild REST endpoint not available, trying RESTlet fallback')
      const result = await core.callRestlet('customscript_sa_milk_unbuild', 'customdeploy_sa_milk_unbuild', body)
      return { success: true, unbuildId: result?.id || result?.unbuildId || null, response: result }
    }
    throw err
  }
}

async function createBulkMilkWorkOrder(data) {
  const { assemblyItemId, quantity, locationId } = data

  if (!assemblyItemId) throw new Error('assemblyItemId is required')
  if (!quantity || quantity <= 0) throw new Error('quantity must be greater than 0')

  console.log(`[MilkService] Creating bulk milk work order: item ${assemblyItemId}, qty ${quantity}`)

  const body = {
    assemblyItem: { id: assemblyItemId },
    quantity,
    ...(locationId ? { location: { id: locationId } } : {}),
  }

  const result = await core.netsuitePost('/record/v1/workOrder', body)
  return { success: true, workOrderId: result?.id || null, workOrderNumber: result?.tranId || null, response: result }
}

async function issueBulkMilkComponents(workOrderId, data) {
  const { creamItemId, creamVolume, skimItemId, skimVolume } = data

  if (!workOrderId) throw new Error('workOrderId is required')

  console.log(`[MilkService] Issuing to WO ${workOrderId}: cream ${creamVolume}, skim ${skimVolume}`)

  const componentItems = []
  if (creamVolume > 0) componentItems.push({ item: { id: creamItemId }, quantity: creamVolume })
  if (skimVolume > 0) componentItems.push({ item: { id: skimItemId }, quantity: skimVolume })

  if (componentItems.length === 0) {
    return { success: true, issueId: null, message: 'No components to issue (zero quantities)' }
  }

  const result = await core.netsuitePost(
    `/record/v1/workOrder/${workOrderId}/!transform/workOrderIssue`,
    { component: { items: componentItems } }
  )
  return { success: true, issueId: result?.id || null, response: result }
}

async function getActiveBulkMilkWorkOrders() {
  const query = `
    SELECT wo.id, wo.tranId, wo.status, wo.quantity,
           BUILTIN.DF(wo.assemblyItem) AS assemblyItemName
    FROM workOrder wo
    WHERE wo.status = 'InProcess'
    ORDER BY wo.tranId DESC
  `
  const result = await core.suiteQL(query)
  return { success: true, workOrders: result?.items || [] }
}

module.exports = {
  createSeparationUnbuild,
  createBulkMilkWorkOrder,
  issueBulkMilkComponents,
  getActiveBulkMilkWorkOrders,
}
