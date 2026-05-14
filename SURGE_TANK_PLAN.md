# Surge tank batch flow — implementation plan

_Branch: `SD-597` (prod NS). Written 2026-05-13 to pick up next session._

## TL;DR

Build a new surge-tank batch flow that mirrors the blend-tank flow but creates a NS Work Order for the **finished** product when a surge tank starts filling, issues components for whatever flows in through the UHT (raw direct from silo OR raw from a blend tank), and completes the FG total. Replaces the existing UHT-direct logic in `blendTankJob.js:147-214`.

## What exists today

- **Surge tank historian tags** (`historian/providers/restProvider.js:111-131`):
  - `ThermaRoute.ST{N}_ProductDesc` — surge tank product description (operator-set, currently free-text; AVEVA standardized tag coming "soon")
  - `ThermaRoute.ThermaRoute.ST{N}_LT8{N}01` / `_LT8{N}01_Gal` — level % and gallons
  - `ThermaRoute.ST{N}_State`, `_TankEmpty_Indicator`, `_Connected`, `_SterProdBarrOK`, `_FillingOK`
  - `ThermaRoute.{UHT}_{ST}_Connection_Code` — 1 if UHT routed to that ST
- **UHT inflow proxy** — no hardware totalizer on FT1102; restProvider integrates GPM over time into `_uhtMilkGal[UHT1|UHT2]` (`restProvider.js:150-156`). Resets on IDLE→PROCESS. **This is the surge tank inflow source we'll use** (UHT→ST is 1:1 during a run, decided in conversation 2026-05-13).
- **Surge tank bins** (`mesItemConfig.js:92-97`): ST81→1011, ST82→1012, ST83→1014, ST84→1015
- **`getUhtDestinationSurgeTank(uhtId)`** (`restProvider.js:846-886`) — returns the actively-filling ST for a given UHT
- **`getSurgeTankStatus()`** (`restProvider.js:779-831`) — reads all 4 STs, used by equipmentJob for dashboard only (no WO creation)
- **`equipmentJob.js`** — polls surge tanks every 15s, dashboard-only
- **Existing UHT-direct logic** (`blendTankJob.js:147-214`) — creates a WO keyed on `"${line}→${requestedBy}"` (e.g., "ML1→UHT1") with FG as the assembly. Handles line→UHT→ST directly, but not from-blend-tank flows. **To be removed once new flow is live.**
- **Blend tank flow** — already produces WOs for raw items (e.g., Raw Kirkland 2% Organic Milk, item 8344). The blend tank's `mesItem` field stores the raw NS item ID.

## Decisions already made (don't re-debate)

1. **Inflow source**: use the existing `_uhtMilkGal` software totalizer (FT1102 GPM integrated over time). When/if MES guy ships a hardware inflow totalizer for ST, swap the read.
2. **Remove `blendTankJob.js:147-214`** UHT-direct logic — superseded by the new surge tank flow.
3. **From-blend-tank component lookup**: join on `MesBlendTankBatch` where `tankId === UHT.FromEntName` and `status='active'`. Use that batch's `mesItem` as the component to issue.
4. **From-silo (UHT-direct) component lookup**: UHT.FromEntName matches `MSilo*`/`CSilo*` → look up via `mesItemConfig.HISTORIAN_ITEM_MAP` or the silo item map. The line's current product name resolves the raw separated item (1%, 2%, etc.).
5. **Catalog for finished products**: need a NEW catalog separate from `blendTankProductParser` since that one now points at **raw** items. Either (a) add a new `surgeTankProductParser.js` keyed at the FG items, or (b) re-add finished IDs as a parallel field on the existing catalog. Lean toward (a) — keep them cleanly separated.
6. **Test scaffold**: add `SURGE_TANK_OVERRIDES` env var, same shape as `BLEND_TANK_OVERRIDES` (`{tankId: nsFgItemId}`). Skips the parser when set.

## Open questions (resolve in conversation before coding)

1. **Detection signal for batch start** — three options:
   - (a) Product description change in `_ProductDesc` (mirrors blend tank's NOTE_STRING approach)
   - (b) Level rises above a threshold while product is set
   - (c) UHT connected (`Connection_Code === 1`) AND inflow > 0 for first time
   - **Tentative**: (a) primary + (b) as confirmation fallback, same as blendTankJob.
2. **Detection signal for batch end** — product clears, OR level drops below threshold and batch is mature (≥2 min, like blend tank's MIN_BATCH_DURATION_MS).
3. **Completion accounting** — FG completed = total inflow (assume no UHT loss). Future: add waste model.
4. **Concurrent fillers draining** — confirmed irrelevant for completion accounting since we use inflow totalizer, not level delta.

## Architecture

```
Silo  ──┐
        ├──► UHT ──► Surge Tank ──► Filler
Blend ──┘
Tank
```

**Per surge tank batch:**
- WO assembly = FG NS item (e.g., 4498 Kirkland 2% Organic Milk — the non-raw version)
- Component issued = whatever the UHT is currently pulling from (raw from silo OR raw from blend tank)
- Quantity issued per tick = delta of UHT software totalizer (`_uhtMilkGal[uhtId]`)
- Quantity completed per tick = same as issued (1:1 UHT throughput, no waste model yet)
- Completion goes to surge tank bin (`SURGE_TANK_BIN_MAP[tankId]`)
- Source bin for issue:
  - From silo: `SILO_BIN_MAP[siloName]`
  - From blend tank: `TANK_BIN_MAP[blendTankName]`

## Files to create

### 1. `models/MesSurgeTankBatch.js`

Mirror `MesBlendTankBatch.js`. Fields:
- `id`, `tankId` (ST81-ST84), `productName`, `mesItem` (FG NS item ID), `parserConfidence`
- `nsWorkOrderId`, `nsWorkOrderNumber`, `status` (active/dry_run/pending_ns/error/completed)
- `cumulativeIssuedLbs`, `cumulativeCompletedLbs`
- `lastIssueAt`, `lastCompletionAt`, `detectedAt`, `completedAt`
- `feedingUhtId` (UHT1/UHT2) — needed to know which `_uhtMilkGal` to track
- `feedingFromEntName` (silo name or blend tank ID) — for issue source bin
- `errorMessage`, `createdAt`
- Index on `(tankId, productName, status)`

Then add it to `models/index.js` so sequelize picks it up.

### 2. `models/MesSurgeTankIssueState.js`

Tracks per-tick UHT totalizer baseline for delta calculation. Like `MesPipeIssueState` but keyed on surge tank batch + UHT.
- `id`, `surgeTankBatchId` (FK), `uhtId`, `lastIssuedUhtGal`, `lastObservedAt`
- Index on `(surgeTankBatchId, uhtId)`

### 3. `services/surgeTankMesService.js`

Mirror structure of `blendTankMesService.js`:
- `processWOStart({tankId, productName, fgItemId?, feedingUhtId, feedingFromEntName, detectedAt})` — create WO for FG
  - Check duplicate (active batch on same tank+product)
  - Check cooldown (5 min)
  - Check `config.SURGE_TANK_OVERRIDES[tankId]` first; if set, use that FG item ID
  - Else call `surgeTankProductParser.parseProductName(productName)` (see file #5)
  - POST `/record/v1/workOrder` with assemblyItem={id: fgItemId}, location: 23, subsidiary: 2, custbody_mes_tank_id: tankId, custbody_mes_product_name, custbody_mes_source_entity (= feedingFromEntName), custbody_mes_dest_entity (= tankId)
  - Save MesSurgeTankBatch with status='active'
- `processWOEnd({tankId, productName, detectedAt})` — flush final issue/completion, set status='completed'
- `tickIssueAndCompleteForBatch(batch)`:
  - Read current `_uhtMilkGal[batch.feedingUhtId]` via historian
  - Compute delta vs `MesSurgeTankIssueState.lastIssuedUhtGal`
  - Convert gal → lbs (`GAL_TO_LBS = 8.6` from restProvider — confirm constant)
  - If delta ≥ `config.MES_MIN_ISSUE_LBS`:
    - Resolve component item (see component resolution below)
    - Build workOrderIssue body (use existing `buildWoIssueBody` from blendTankMesService or copy)
    - POST `/record/v1/workOrder/{id}/!transform/workOrderIssue`
    - Update issue state + batch.cumulativeIssuedLbs
  - If batch.cumulativeIssuedLbs - batch.cumulativeCompletedLbs ≥ `MES_MIN_COMPLETION_LBS`:
    - POST `/record/v1/workOrder/{id}/!transform/workOrderCompletion`
    - Quantity = delta. Bin = SURGE_TANK_BIN_MAP[tankId]. Lot = MMDDYY{woNum}
    - Update batch.cumulativeCompletedLbs
- `tickAllActiveBatches()` — iterate all active surge tank batches, call tickIssueAndCompleteForBatch

**Component resolution helper:**
```
async function resolveSurgeTankComponent(feedingFromEntName, lineProductName) {
  // If from silo (MSilo*/CSilo*):
  //   - return raw separated item via lineIngredientMapper.resolveLineProduct(lineProductName)
  //     OR via itemConfig (whichever is cleaner — likely lineIngredientMapper since
  //     it already maps SCADA product strings to NS raw items)
  //
  // If from blend tank (BlendTank*):
  //   - SELECT * FROM MesBlendTankBatches WHERE tankId = feedingFromEntName AND status = 'active'
  //   - Return { id: batch.mesItem, name: batch.productName, bin: TANK_BIN_MAP[feedingFromEntName] }
  //
  // Return { itemId, itemName, binId } for use in buildWoIssueBody
}
```

### 4. `jobs/surgeTankJob.js`

Mirror `blendTankJob.js`:
- Constants: `WEIGHT_THRESHOLD_GAL` (~50 gal?), `EMPTY_THRESHOLD_GAL` (~10 gal), `MIN_BATCH_DURATION_MS = 120_000`
- `tankState` object for ST81-ST84 (productName, batchActive, seeded, batchStartedAt, feedingUhtId, feedingFromEntName)
- `run(historian)`:
  - Call `historian.getSurgeTankStatus()` (already exists)
  - For each tank: detect product change → batch start; product clear / empty + mature → batch end
  - On start: resolve feedingUhtId via `getUhtSurgeTankRouting()` (already exists, returns connections per UHT), then resolve feedingFromEntName via UHT FromEntName tag (need to add `getUhtFromEntName(uhtId)` to provider, or read directly from `ThermaRoute.{UHT}.FromEntName`)
  - On start: call `surgeTankMesService.processWOStart()`
  - On end: call `surgeTankMesService.processWOEnd()`
- Push events to `statusStore` for dashboard parity

Then register in the job runner (look at how blendTankJob is registered — `historian/index.js` or a startup file).

### 5. `services/surgeTankProductParser.js`

New parser for FG (finished) products. Two options:
- (a) Full fuzzy parser like `blendTankProductParser`, but with `nsId` pointing at the FG NS IDs (the OLD ones from the original blend tank catalog — 4498 Kirkland 2% Organic Milk, 3228 DFI Marcels 1% Milk, etc.)
- (b) Simple exact-match lookup table for the new AVEVA standardized values

Since AVEVA standardized values are coming, lean (b): a simple `FG_ITEM_MAP = { 'Kirkland 2% Organic Milk': 4498, ... }` object plus a fallback fuzzy parser using the old catalog. When AVEVA values arrive, use exact-match; until then, use the fuzzy parser.

**The old finished-product IDs (preserved in git history at SD-597~1 before commit `2c1f330`)** — restore from that commit's `blendTankProductParser.js` and use them here. Quick reference of common ones:
- Kirkland 2% Organic Milk → 4498
- Kirkland 1% Organic Milk → 4495
- DFI Marcels 1% Milk → 3228
- DFI Marcels 2% Milk → 4012
- Horizon Organic 2% Milk → 5911

(Full catalog: `git show 63306e9:services/blendTankProductParser.js` to recover.)

## Files to modify

### `config/index.js`
Add `SURGE_TANK_OVERRIDES` parsed from env var (same pattern as BLEND_TANK_OVERRIDES).

### `historian/providers/restProvider.js`
Add a helper to expose `_uhtMilkGal[uhtId]` to consumers — currently it's an internal field. Add:
```
async getUhtMilkTotalizer(uhtId) {
  // Make sure poll has updated _uhtMilkGal; if not, do a quick read.
  return this._uhtMilkGal[uhtId] || 0
}
```
Also add `getUhtFromEntName(uhtId)` if not already exposed (currently UHT_FROM_ENT is read inside getSurgeTankStatus or similar — verify).

### `historian/providers/baseProvider.js` (or interface)
Add `getUhtMilkTotalizer` / `getUhtFromEntName` to the interface so mockProvider can stub them for tests.

### `historian/providers/mockProvider.js`
Stub the two new methods (return fake values for local dev).

### `jobs/blendTankJob.js`
**Delete lines 147-214** (UHT-direct logic) and the supporting state in `lineState` (uhtRequestedBy, uhtActive fields). The surge tank job replaces this.

### `models/index.js`
Register `MesSurgeTankBatch` and `MesSurgeTankIssueState`.

### `app.js` or `server.js` (wherever jobs are scheduled)
Schedule `surgeTankJob.run()` on `SURGE_TANK_CRON` (add to config, default `'*/10 * * * * *'`). Schedule a periodic tick handler for surge tank issue/completion (similar to existing `issueCompletionJob.js` for blend tanks — either fold into it or add a parallel one).

## Implementation order (concrete steps)

1. **Add models** — `MesSurgeTankBatch` + `MesSurgeTankIssueState`, register in models/index.js, restart to confirm sequelize syncs.
2. **Add config** — `SURGE_TANK_OVERRIDES` + `SURGE_TANK_CRON` in config/index.js.
3. **Expose historian helpers** — `getUhtMilkTotalizer(uhtId)`, `getUhtFromEntName(uhtId)` on rest+mock+base providers.
4. **Create `surgeTankProductParser.js`** — port the OLD blend tank catalog (finished IDs) from git, add `getProductByNsId` and `parseProductName` mirroring the existing parser. Add a `FG_ITEM_MAP` for exact-match too.
5. **Create `surgeTankMesService.js`** — processWOStart, processWOEnd, tickIssueAndCompleteForBatch, tickAllActiveBatches, resolveSurgeTankComponent.
6. **Create `surgeTankJob.js`** — detection loop, calls processWOStart / processWOEnd.
7. **Wire into scheduler** — add surgeTankJob.run to the poll loop, add tick handler.
8. **Remove `blendTankJob.js:147-214`** — old UHT-direct path.
9. **Test** — set `SURGE_TANK_OVERRIDES={"ST81":4498}` in .env, manually trigger via mockProvider or wait for real surge tank fill, verify WO created with FG item 4498 and issue/complete fire correctly.

## Testing approach

- **Phase 1 (mock historian)**: hook up mockProvider to simulate a surge tank batch — set productDesc, simulate level rise, simulate UHT inflow ramp. Verify WO created, issue fires per tick, completion fires.
- **Phase 2 (real historian, dry-run mode)**: set `MES_DRY_RUN=true` and run against live historian, verify the right tags are read and the right NS payloads would be sent (logged, not posted).
- **Phase 3 (live)**: deploy to a single surge tank first with override pointing at a known FG item. Monitor `MesProcessingLog` for `surge_tank_*` events.

## Things to verify before going live

- [ ] All FG items in the surge tank catalog are active in prod NS (run a SuiteQL check like we did for raw items)
- [ ] FG items have BOMs configured so workOrderIssue accepts the raw component item
- [ ] The lot number format MMDDYY{woNum} is unique enough — current blend tank uses it
- [ ] Confirm `_uhtMilkGal` resets on IDLE→PROCESS correctly (read the integration logic before relying)
- [ ] If MES guy ships a real ST inflow tag before this lands, swap the source in step 3

## Reference — git pointers

- Pre-overhaul finished-product catalog: `git show 63306e9:services/blendTankProductParser.js` (commit "SD-597: Update mesItemConfig to production NS")
- This planning conversation: 2026-05-13
- Memory: `[[plant_flow_chain]]` documents silo → separator → silo → blend tank → UHT → surge tank → filler
- Memory: `[[project_standardized_aveva_inputs]]` — AVEVA moving to standardized values, fuzzy parser being superseded
