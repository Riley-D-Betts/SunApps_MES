# SunApps_MES — Comprehensive Description

A Node.js + Express service (`server.js` on port 4005) that sits between Sun Tado Dairy's plant control systems (AVEVA Historian / SCADA + Atlas) and NetSuite ERP. Its single purpose is to **observe physical milk processing as it happens and translate every measurable event into NetSuite inventory transactions** — assembly unbuilds (separation), work orders, workOrderIssues (ingredient consumption), and workOrderCompletions (finished output) — all without manual data entry from operators.

It is *not* an MES in the traditional "screen for operators" sense. It is an event-driven historian poller + NetSuite emitter. The frontend (in `SunApps`) just renders status it pulls from this service's `/api/mes/live-status` endpoint.

---

## 1. Plant flow this service models

```
   Raw silos                Separator             M-silos + C-silos          Blend tanks (4)             UHT pasteurizers (2)        Surge tanks (4)         Fillers (5)
 MSilo1…5, CSilo1…3   →   CMSep1 (XFR-driven) →   skim back to M, cream to C  →  BT1A/1B/2A/2B    →    UHT1 (→ ST81/ST82) /     →   ST81–ST84       →   Lines 1–5
                                                                                                       UHT2 (→ ST83/ST84)
```

Memory note `plant_flow_chain.md` and `pack_lines.md` document this exactly. Each station has its own scheduled poller, its own DB table, and its own NetSuite transaction shape.

---

## 2. Process model — six cron jobs

`server.js` schedules six independent `node-cron` jobs. Their cadences live in `config/index.js`:

| Job | File | Cron default | Reads | Writes |
|---|---|---|---|---|
| `separationJob` | `jobs/separationJob.js` | `*/10 sec` | `historian.getSeparatorBatches()` + `getSeparatorStatus()` | `assemblyUnbuild` to NS |
| `bulkMilkJob` | `jobs/bulkMilkJob.js` | every 1 min | `historian.getBulkMilkFlowData()` | `workOrderIssue` to legacy bulk-milk runs |
| `blendTankJob` | `jobs/blendTankJob.js` | `*/10 sec` | `getBlendTankStatus()` + `getMilkLineStatus()` | starts/closes blend-tank batches |
| `surgeTankJob` | `jobs/surgeTankJob.js` | `*/10 sec` | `getSurgeTankStatus()` + `getUhtSurgeTankRouting()` + `getUhtStatus()` | starts/closes surge-tank batches |
| `equipmentJob` | `jobs/equipmentJob.js` | `*/15 sec` | silos + UHTs + surge tanks (read-only) | `statusStore` only (dashboard) |
| `issueCompletionJob` | `jobs/issueCompletionJob.js` | `*/5 min` (prod) | totalizer deltas | many small `workOrderIssue` + `workOrderCompletion` calls |

All jobs share one `historian` provider instance, swappable via env (`HISTORIAN_PROVIDER=rest` or `mock`).

On startup `server.js` calls a hydration sequence: `db.ensureRuntimeSchema()` (idempotent `ALTER TABLE` for columns added after the model first deployed) and four `statusStore.hydrate*` calls that rebuild in-memory state from the DB — plus `blendTankJob.hydrateFromDb()` / `surgeTankJob.hydrateFromDb()` which restore each tank's "this product is already active" memory so a process restart doesn't false-fire a duplicate WO start.

---

## 3. The six logical flows

### 3.1 Separation — `separationJob` → `milkMesService.processSeparationBatch()`

Trigger: rising-edge on `Ingr_Sep_CMSep1_IO.XFR.TransferCompleteS.0` (0 → 1). The Raw endpoint is used instead of ProcessValues because ProcessValues has a ~1 h DST timestamp lag that drops recent events outside the query window (`restProvider.js:266-297`, fixed in commit `635ce00`).

When the bit rises, the job reads twelve XFR tags at once (`QTYActual`, `Source`, `ItemID`, 4 destination slots, `Cream_Flow_Totalized`, `Skim_Flow_Totalized`, etc.) plus each touched silo's `IndexSelectRead` (the 1–40 product code the operator picked on the Standardization HMI). Volume tags reset to 0 between batches, so their current value *is* the per-batch total.

The service then:
1. Dedup-checks against `MesSeparationBatches` (unique on `batchId+sourceSilo+batchEnd`).
2. Classifies each destination: C-silo → cream; M-silo (not source) → skim (memory: `silo_flexibility.md` — silos are *flexible*, prefix is not authoritative, hence the `IndexSelectRead` lookup).
3. Computes waste = input − cream − skim; alerts Teams if waste % > 5 (`WASTE_ALERT_THRESHOLD`).
4. Picks a BOM via `getSeparationBomId(sourceItemId, skimProductIndex)` — `SEPARATION_BOM_MAP` in `mesItemConfig.js` covers Conv → 1/2/3.25/3.5/Skim, Org → same, plus A2 → 1/2/3.25/Skim (4 fat levels — SCADA HMI indices 22-25; A2 has no 3.5% or 4% option on the Standardization HMI). BOM 253 (A2 Skim) currently produces regular org cream (5483) instead of A2 cream (8365) — flagged for NS fix.
5. POSTs `/record/v1/assemblyUnbuild` to NetSuite with the source as the assembly item, `billOfMaterials.id`, and per-component `componentInventoryDetail.inventoryAssignment.items[].binnumber` — bin-only, no lot (the items are bin-tracked but not lot-tracked; PICKUP.md documents this discovery).

Gaps fail soft into `status='pending_ns'` rather than erroring, so ops gets a backlog list rather than an exception storm. Errors land in `status='error'` with full payload in `MesProcessingLogs`.

### 3.2 Blend tank batch start/end — `blendTankJob`

Per tank (BT1A/1B/2A/2B), the job tracks an in-memory `tankState` and reacts to four discrete events:

- **`NOTE_STRING` changed to a new product** → close current batch (if any) and start a new one.
- **Weight crosses 500 lb (`WEIGHT_THRESHOLD_LBS`) with same product** → confirm a start that started without a name change.
- **`NOTE_STRING` cleared while batch active** → end batch (`note_cleared`).
- **Weight drops below 100 lb (`EMPTY_THRESHOLD_LBS`) after batch is ≥ 2 min old (`MIN_BATCH_DURATION_MS`)** → end batch (`emptied`). The age gate suppresses a false end from the scale reading 0 during initial fill.

`PRODUCT_SENTINELS = {'', 'none', 'empty', 'cip', 'water', 'sterile', 'n/a', '-', '--'}` filters out PLC defaults that look like product names but aren't.

On start: `blendTankMesService.processWOStart()`
- Duplicate guard + 5-min cooldown.
- Resolve product:
  1. `BLEND_TANK_OVERRIDES[tankId]` env var (sandbox scaffolding — memory `project_standardized_aveva_inputs.md` says AVEVA is moving to constrained values).
  2. `blendTankProductParser.parseProductName()` — exact-match `RAW_FG_ITEM_MAP` first, then fuzzy brand/fat%/modifier scoring against `PRODUCT_CATALOG`. Strict mode (`MES_PARSER_STRICT_MODE=true`) disables the fuzzy fallback so unrecognized inputs go to `pending_ns` instead of mis-scoring.
- The parsed item is a *Raw FG* (e.g. 8344 Raw Kirkland 2% Organic Milk), NOT a finished item — Memory `future_bom_layering.md` describes the planned 3-layer flow (raw silo → Layer 2 raw FG via blend tank → Layer 3 FG via surge tank).
- POST `/record/v1/workOrder` with `assemblyItem`, `quantity=batchSize`, custom body fields (`custbody_mes_tank_id`, `custbody_mes_product_name`, source/dest entities), location 23, subsidiary 2.
- Persist NS WO id + number to `MesBlendTankBatches`. Status flow: `active` → `completed` (or `dry_run`, `pending_ns`, `error`).

Lines (ML1–4, CL1–2): `blendTankJob` also tracks each line's totalizer. On a totalizer reset (>100 lb → <100 lb) or `CURRENTSILOPRODUCTNAME` clear, it calls `blendTankMesService.processLineFlow()` — the "tail-catcher" path that captures any final delta that the 5-min tick hadn't issued yet.

### 3.3 Surge tank batch start/end — `surgeTankJob`

The newest flow (branch `SD-597`). State machine per surge tank (ST81–84) with a stricter start gate than blend tank:

- **`_ProductDesc` changes to a new valid product** → adopt the new product, reset fill-tick counter, end any old batch.
- **5-tick fill gate**: a tick "counts" only when **both** (a) gallons delta > `FILL_NOISE_GAL` (5 gal/tick) since last poll **and** (b) the UHT feeding this tank is on PROCESS step name `"Sterile on Product"` (`STERILE_ON_PRODUCT_STEP`). 5 consecutive ticks (~50 s at 10-s cron) clears the gate; any miss resets to 0. Memory `surge_wo_start_gates.md` documents why: an earlier version used `sterProdBarrOK`, which is a plumbing/valve indicator, not a sterility signal — multiple false starts in sandbox.
- **State === 4** = CIP mode, ineligible.
- **`_ProductDesc` cleared while active** → end batch.
- **mainGallons < 10 after batch is ≥ 2 min old** → end (emptied).

On start: `surgeTankMesService.processWOStart()`
- Resolve FG via `SURGE_TANK_OVERRIDES` env or `surgeTankProductParser` — this parser's catalog has FG item IDs (4498 Kirkland 2%, 3228 DFI Marcels 1%, etc.), as opposed to the blend-tank parser's raw IDs.
- **`resolveLayer3Component()`** — pin the single raw component to be consumed:
  - feeding-from = blend tank → look up active `MesBlendTankBatch` on that tank, use its `mesItem`.
  - feeding-from = silo → resolve via `getMilkLineStatus()` matching the UHT, then `lineIngredientMapper.resolveLineProduct(productName)`. If no line is feeding the UHT, fall back to `SILO_ITEM_MAP[silo]` (bulk raw).
  - `layerSkipReason` is tagged: `null` = canonical 3-layer; `layer-2-skip` = post-separator content fed direct; `layer-1-and-2-skip` = bulk raw piped to UHT (`isBulkRawId()` checks against `BULK_RAW_ITEM_IDS = {5417, 5404, 5403, 5406}`).
- **FG-pairing approval workflow** — every (`fgItemId`, `rawInputItemId`) combo is upserted into `MesFgInputPairings`. Pre-seeded canonical pairs from `RAW_FG_TO_FG_MAP` are auto-approved on boot (`seedFgInputPairings()` in `models/index.js`). Any new pair lands as `status='pending'` and the batch is flagged `pairingStatus='pending_review'`. Physical flow still happens — ops reviews via `/api/mes/fg-pairings` and either approves or leaves pending forever (no blocklist).
- POST `/record/v1/workOrder` with `assemblyItem.id` (FG) and a **custom one-line component list** (`body.item.items=[{item:{id:componentItemId}, quantity:1}]`) so NS doesn't auto-populate the static BOM (which won't match for skip paths).

### 3.4 The 5-minute tick — `issueCompletionJob`

This is the heart of the per-batch accounting. Memory `ns_wo_completion_pattern.md` documents the reasoning: SunTado's NS practice is many small incremental WO completions that sum to the total (matches their existing OEM behavior).

Each tick:

**Blend-tank pass** (`blendTankMesService.tickAllActiveBatches`):
1. For every active `MesBlendTankBatch`, call `getMilkLineStatus()` once.
2. Per line that maps to this batch (via canonical `BT2A ↔ BlendTank2A` normalizer, or silo-fallback when REQUESTEDBY is empty), compute `delta = current_totalizer − lastIssuedTotalizerLbs` from `MesPipeIssueStates`.
3. If delta ≥ `MES_MIN_ISSUE_LBS` (default 10 lb), fetch the WO's BOM (cached per WO in `_bomCache`), build a `buildWoIssueBody` that **sets all other BOM lines to qty 0** and the target line to the delta + `inventoryDetail.inventoryAssignment` with `binnumber` + `inventoryStatus:{id:1}`. Memory `ns_wo_issue_shape.md` documents that the write body must use singular `inventoryDetail` (NOT `componentInventoryDetail`, which is the *read* shape).
4. POST `/record/v1/workOrder/{id}/!transform/workOrderIssue`, persist the new baseline only after NS confirms.
5. **Catch-up pass** — any pipe state whose `lastTotalizerLbs > lastIssuedTotalizerLbs` for a line that wasn't in matchingLines this tick (a restart-and-reset case) fires a synthetic issue using stored `lastProductName` / `lastSiloName`.
6. **`tickCompletionForBatch`** — if `cumulativeIssued − cumulativeCompleted ≥ MES_MIN_COMPLETION_LBS` (default 1 lb), POST `/record/v1/workOrder/{id}/!transform/workOrderCompletion` with a lot number `MMDDYY{woNum}` and bin = either `toEntName` (UHT-direct legacy path, ST81–84) or the blend tank itself. Update `cumulativeCompletedLbs`.

**Surge-tank pass** (`surgeTankMesService.tickAllActiveBatches`):
- Per batch, read `historian.getUhtMilkTotalizer(feedingUhtId)`. That totalizer is a *software* integration of `FT1102_Output` GPM over time (no hardware totalizer on FT1102 — `restProvider.js:789-805`); resets on each IDLE→PROCESS transition.
- Compute `deltaGal = currentGal − lastIssuedUhtGal`; convert `deltaLbs = deltaGal × 8.6` (GAL_TO_LBS constant; deliberately single because UHT throughput is mixed during product changes).
- Use the *pinned* component from the batch row (`componentItemId`/`componentBinId`/`componentResolvedFrom`) — no per-tick re-resolution unless legacy null. Issue and complete same as blend tank.

At end of each tick the job re-hydrates `statusStore.tick` and `recentBlendBatches`/`recentSurgeBatches` rings so the dashboard refreshes without a DB query per snapshot.

### 3.5 Batch end (`processWOEnd`)

Common to blend + surge:
- Re-load batch row.
- For blend tank: backfill `cumulativeIssuedLbs` from any legacy `MesBlendTankInflow` rows that pre-date the tick column.
- One last `tickCompletionForBatch` to flush any remaining unaccounted-for issued mass.
- Surge tank also fires a final `tickIssueForBatch` first.
- Set `status='completed'`, write `MesProcessingLog`, clear BOM cache.

### 3.6 Pure-status (`equipmentJob`)

Read-only — silos, UHTs, surge tanks. Computes per-UHT "active fill tank" with hysteresis: candidate must be > 5 gal/tick (`FILL_NOISE_GAL`) for 4 consecutive ticks (`SWITCH_TICKS = 4 × 15 s = 60 s`) before switching from the previous designation; all-tanks-quiet for 12 ticks (`IDLE_TICKS = 3 min`) clears it. This drives the dashboard's "UHT1 → ST82" badge without flicker.

---

## 4. Data model (Sequelize on MSSQL)

| Table | Purpose |
|---|---|
| `MesSeparationBatches` | one row per CMSep1 batch; `destinations` JSON has the full resolved snapshot |
| `MesBulkMilkRuns` | legacy bulk-milk WO tracking |
| `MesBlendTankBatches` | one row per blend-tank batch; cumulative totals + last-fire timestamps |
| `MesPipeIssueStates` | per (batch, line) totalizer baseline + last product/silo for restart recovery |
| `MesBlendTankInflows` | per-issue audit trail |
| `MesSurgeTankBatches` | one row per surge-tank batch; layer-3 pinned component, pairing status |
| `MesSurgeTankIssueStates` | per (batch, UHT) totalizer baseline |
| `MesFgInputPairings` | (fgItem, rawInput) approval list — unique index, seeded from `RAW_FG_TO_FG_MAP` |
| `MesProcessingLogs` | every NS POST attempt with full payload + response |

`db.ensureRuntimeSchema()` runs idempotent `ALTER TABLE`s on every boot so any model column added after the table was first created shows up automatically — no migration tool.

---

## 5. The historian provider abstraction (`historian/`)

`BaseProvider` defines the interface; two implementations:

- **`RestProvider`** — talks to AVEVA Historian OData v2 via NTLM (`httpntlm`). Two endpoints used: `/Tags('fqn')/Raw` for current values (no DST lag) and `/ProcessValues?$filter=...` for historical (with `@odata.nextLink` pagination). Some tags are double-prefixed (`ThermaRoute.ThermaRoute.ST{N}_LT8{N}01`) because the single-prefix variants return `OpcQuality=0`. UHT mode bits use different separators per UHT (`UHT1.Mode.CIP` vs `UHT2.Mode_CIP`) — handled by per-UHT FQN list builders. The provider also keeps in-memory state for: `_uhtMilkGal` (software totalizer), `_prevSurgeGal` (per-tank inflow delta), `_prevTransferComplete` (separator rising edge), `_prevCreamTotal`/`_prevSkimTotal` (bulk milk delta).

- **`MockProvider`** — drives mock historian responses for local dev.

Routes under `/api/historian/*` expose the historian as a generic gateway: tag search, current value, history (raw + AnalogSummary + StateSummary + events), so SunApps frontend and ad-hoc scripts (`scripts/`) can read any tag without re-implementing OData logic.

---

## 6. NetSuite integration boundary

This service does NOT speak directly to NetSuite. It calls a local `coreClient` (`http://localhost:4000` by default — env `CORE_API_URL`) which proxies to NetSuite via the SunApps gateway. Memory `netsuite_wo_architecture.md` makes the load-bearing decisions explicit:
- WOs are created dynamically with a custom component list — no static BOM is configured on most assemblies, the body's `item.items` *is* the BOM for that run.
- AVEVA never talks to NS — every NS hop goes through this service.

**`MES_DRY_RUN=true`** short-circuits every NS POST and just logs the body. All accounting state (DB, cumulative totals) still advances — handy for sandbox verification without polluting NS.

---

## 7. Configuration surface (`.env` → `config/index.js`)

```
HISTORIAN_PROVIDER=rest|mock
HISTORIAN_BASE_URL, HISTORIAN_DOMAIN, HISTORIAN_USERNAME, HISTORIAN_PASSWORD
SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD
CORE_API_URL                      # SunApps gateway URL
SEPARATION_CRON, BULK_MILK_CRON, BLEND_TANK_CRON, SURGE_TANK_CRON,
EQUIPMENT_CRON, TICK_CRON
MES_MIN_ISSUE_LBS=10              # below this, defer to next tick
MES_MIN_COMPLETION_LBS=1
MES_DRY_RUN=false
MES_PARSER_STRICT_MODE=false      # disable fuzzy parsing when AVEVA select tags arrive
BLEND_TANK_OVERRIDES={"BlendTank1A":8344}   # scaffolding for product tag
SURGE_TANK_OVERRIDES={"ST81":4498}          # scaffolding for product tag
TEAMS_WEBHOOK_URL                 # for waste/poll-fail alerts
```

---

## 8. Failure modes and safety nets

- **Cooldown** — same tank can't start two batches within 5 min (`COOLDOWN_MINUTES`); guards against operator's product-set flutter.
- **Sentinel filtering** — `PRODUCT_SENTINELS` set blocks `CIP`/`Water`/`Sterile`/`-` from being treated as products.
- **Min duration before "emptied" end** — 2 min (`MIN_BATCH_DURATION_MS`) so a fill-from-zero doesn't immediately close.
- **Min delta thresholds** — issues defer below 10 lb; completions defer below 1 lb. Avoids spamming NS with sub-pound noise.
- **`pending_ns` status** — anything that resolved the physics but failed to resolve an NS item/bin/BOM lands here, not in `error`. Ops queries `WHERE status='pending_ns'` to fix the catalog.
- **Hydration on restart** — `blendTankJob.hydrateFromDb` + `surgeTankJob.hydrateFromDb` pull `active` rows into in-memory tank state on boot, so a process restart in the middle of a batch doesn't trigger a duplicate WO start *or* leave an orphan active row in the DB.
- **Catch-up pass** in the blend-tank tick — handles the case where a line reset while the process was down (uses `MesPipeIssueState.lastProductName`/`lastSiloName`).
- **Teams notifications** — only the deploy workflows post to Teams (via `TEAMS_SOFTWARE_DEPLOYMENT_HOOK`). Runtime alerts are disabled: `notifyService.sendAlert()` is a no-op, so historian-poll/tick/sweep failures are logged locally (`console.error` + `statusStore.pushEvent`) but never sent to Teams.

---

## 9. Auxiliary surfaces

- **`routes/liveStatusRoutes.js`** — `/api/mes/live-status` returns a single JSON snapshot built by `statusStore.snapshot()`. The frontend polls this; it includes separator status, blend tanks + lines, bulk milk, derived silo activity, UHT + surge tank live state, tick cumulative state, and recent batch rings.
- **`routes/milkMesRoutes.js`** + **`routes/milkRoutes.js`** — POST endpoints (legacy gateway shape) for separation batch / blend tank events / bulk milk runs; the in-process job loop is what actually fires today, the POST endpoints are legacy/admin.
- **`routes/fgPairingRoutes.js`** — list + approve FG/raw-input pairings.
- **`scripts/`** — one-off operational tools: BOM verification, retry failed unbuilds, recover specific tanks (`recoverBlendTank2AFill`, `cleanupPhantomTankBatches`), tag discovery, AVEVA tag inventory dumps.
- **GitHub Actions** (`.github/workflows/`) — `development_deploy.yml`, `production_deploy.yml`, `tag_production.yml`.

---

## 10. What this service deliberately is NOT

- No queues — every event handler is synchronous within its cron tick. If NS is down the issue retries on the next tick with the same delta because `lastIssuedTotalizerLbs` only advances after NS confirms.
- No GUI for operators. The plant operates from Atlas + AVEVA HMIs. This service is invisible to the floor.
- No control-loop / write-back to PLCs. Strictly read-only against the plant.
- No business rules beyond what's needed to translate observed flow into a valid NS transaction (BOM-correct, bin-correct, lot-named-by-convention).

The product roadmap (per `SURGE_TANK_PLAN.md`, `PICKUP.md`, and memory `future_bom_layering.md` / `project_standardized_aveva_inputs.md`) is to: (1) replace fuzzy parsing with AVEVA-standardized constrained values; (2) finish the layer-3 surge-tank flow that's currently behind `SD-597`; (3) push lot numbers downstream to fillers so each finished case can be traced back to its raw silo lot via the chain of WOs.
