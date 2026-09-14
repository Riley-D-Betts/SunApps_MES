# SunApps MES Service

A Manufacturing Execution System (MES) service that bridges the plant floor and the ERP for Ida Milk's liquid-milk processing operation. It continuously reads real-time process data from the **AVEVA Historian** (plant SCADA), reconstructs what physically happened at each production stage, and posts the corresponding inventory and cost transactions into **NetSuite** — automatically, with no operator data entry.

> **In one sentence:** the plant's tanks, separators, and fillers move millions of pounds of milk a week; this service watches that movement through the historian and keeps NetSuite's inventory, work orders, waste accounting, and costing in lock-step with physical reality.

It is *not* an MES in the "screens for operators" sense. It is an event-driven historian poller + NetSuite transaction emitter. The plant runs from Atlas + AVEVA HMIs and never sees this service; the SunApps frontend just renders status pulled from this service's `/api/mes/live-status` and `/api/mes/analytics` endpoints.

**This README is the map. Read it top to bottom once before touching anything.** Section 15 (Hard-won NetSuite facts) and Section 16 (Gotchas) are the parts most likely to save you a day.

---

## Table of contents

1. [The plant, in domain terms](#1-the-plant-in-domain-terms)
2. [The three-layer item architecture](#2-the-three-layer-item-architecture)
3. [Architecture overview](#3-architecture-overview)
4. [Tech stack](#4-tech-stack)
5. [Getting started](#5-getting-started)
6. [Configuration reference](#6-configuration-reference)
7. [Boot sequence](#7-boot-sequence)
8. [The cron jobs](#8-the-cron-jobs)
9. [The production flows, in detail](#9-the-production-flows-in-detail)
10. [Waste & shrinkage accounting](#10-waste--shrinkage-accounting)
11. [Inventory adjustments, sweeps & correlation](#11-inventory-adjustments-sweeps--correlation)
12. [Data model](#12-data-model)
13. [The historian layer](#13-the-historian-layer)
14. [Historical replay & runtime config](#14-historical-replay--runtime-config)
15. [NetSuite integration & hard-won NS facts](#15-netsuite-integration--hard-won-ns-facts)
16. [Gotchas, footguns & known issues](#16-gotchas-footguns--known-issues)
17. [HTTP API reference](#17-http-api-reference)
18. [Project structure](#18-project-structure)
19. [The scripts directory](#19-the-scripts-directory)
20. [Deployment & versioning](#20-deployment--versioning)
21. [Documentation index](#21-documentation-index)
22. [Glossary](#22-glossary)

---

## 1. The plant, in domain terms

The production flow is a chain of stages. Milk only moves left to right:

```
 Raw silos          Separator            Silos                Blend tanks (4+1)      UHT pasteurizers (2)     Surge tanks (4)      Fillers (Lines 1–6)
 MSilo1–5,      →   CMSep1          →    skim → M-silos   →   BT1A/1B/2A/2B     →    UHT1 (→ ST81/ST82)   →   ST81–ST84       →    paired filler legs
 CSilo1–3           (XFR-driven)         cream → C-silos      (+ CocoaTank/BTCA)     UHT2 (→ ST83/ST84)                            via Sel-line latches
```

Facts about the physical plant that the code depends on:

- **Silos are flexible.** Any M-silo or C-silo can hold cream OR skim OR raw milk. The `M`/`C` prefix is *not* authoritative for what's inside. Contents are always resolved live (HMI product index, active line routing, or the last batch) — there is deliberately **no static silo→item map** anywhere in the codebase (see `services/mesItemConfig.js` header comment).
- **The separator** (CMSep1) turns a source silo's raw milk into cream + skim, routed to destination silos. Its feed/cream/skim totalizers are **cumulative odometers** that do not reset between transfers — every batch volume is `current − baseline-at-open`.
- **Blend tanks** are where standardized milk gets built to a named product. The product name arrives via the SCADA `NOTE_STRING` tag (typed/selected by the operator). Six milk lines (ML1–4 skim/raw, CL1–2 cream) feed them, each with its own totalizer. The Atlas WO-state tags (`CurrentWOState`, `JobRunning`, `CurrentWO`) are **stale/abandoned across all tanks** — batch detection is driven purely by `NOTE_STRING` + real line flow. There is also a 5th tank, **CocoaTank (BTCA)**, currently untracked by `blendTankJob` because it has no `NOTE_STRING`/string tags.
- **UHTs** sterilize milk on its way to a surge tank. A UHT feeds **one surge tank at a time**, but two open batches can share a UHT across time — see the single-claimant rule (§9.4). There is **no hardware totalizer** on the UHT flow meter (FT1102); the service integrates GPM in software, and only during the PROCESS step named **"Sterile on Product"** (step 24) — integrating during any other step counts water recirculation as milk.
- **Surge tanks** (ST81–84) buffer sterile product ahead of the fillers. `ST8x_Sel{N}_Filling_Indicator` latch tags tell you which filler *line* a tank is routed to; Sel lines are **paired-filler legs** (Sel4 ↔ Fillers 3+4, Sel3 ↔ Fillers 5+6, Sel1 ↔ Fillers 1/2). Fillers 3–6 have historized `ProductFlowRate` meters (units are physically **l/min** despite the "l/h" label). Filler 1's inlet is metered since **2026-08-18** by `TR11_FT1140` on the ThermaRoute leg (GPM + gallons totalizer, SD-708 — see the §13 quirk on its casing); Filler 2 remains unmetered.
- **Pack lines are Lines 1–5 only.** No Line 6 palletizer exists; ignore null historian data for Pack6/Pall6.

## 2. The three-layer item architecture

Every NetSuite transaction this service emits fits a three-layer BOM flow:

| Layer | Physical stage | NS item family | Example |
|---|---|---|---|
| **Layer 1** | Raw silos / separation | Bulk raw + separated components (bin-tracked, mostly non-lot) | 5417 conv raw, 5404 org raw, 5403/5406 A2 raw; cream 5480/5483/8365 |
| **Layer 2** | Blend tank | **Raw FG** assembly items — "Raw Kirkland 2% Organic Milk" (8344) etc. | blend WO builds these |
| **Layer 3** | Surge tank | **Finished goods** — the pasteurized, sellable item (4498 Kirkland 2%, etc.) | surge WO consumes exactly one Layer-2/skip component and builds the FG |

Two legal "skip" paths exist and are recorded on every surge batch as `layerSkipReason`: `layer-2-skip` (post-separator content fed straight to a UHT, bypassing blend) and `layer-1-and-2-skip` (bulk raw piped to UHT — detected by `isBulkRawId()` against `BULK_RAW_ITEM_IDS = {5417, 5404, 5403, 5406}`).

**Lot-tracked "(Batch)" twin items:** the non-lot type-2 standardization milks (5412/5415/…/8370) can't serve as a lot-traced blend WO assembly, so each has a separate lot-tracked "(Batch)" twin item that the blend parser resolves to (e.g. A2 4% → 8928 family; conv twins 8564/8664/8465/8466, org 8467–8470, A2 8471–8473/8565/8764). The non-lot originals remain the *inputs* that `lineIngredientMapper` resolves line flow to. Twins were created by `scripts/createBatchTwin.js` + `attachBatchBom.js`.

Lot numbers are deterministic everywhere: **`MMDDYY` + the digits of the WO number** (both completions and adjustment lots — see `buildLotString`).

## 3. Architecture overview

```
                ┌──────────────────────────┐
                │     AVEVA Historian       │   23,000+ SCADA tags (scripts/all-tags.json)
                │   (REST / OData v2 API)   │
                └────────────┬──────────────┘
                             │  NTLM poll
                ┌────────────▼──────────────┐
                │  Historian provider        │   mock | rest (live) | historical (replay)
                │  (hot-swappable holder)    │   historian/index.js createProvider()
                └────────────┬──────────────┘
                             │
   ┌─────────────────────────▼─────────────────────────┐
   │              Cron jobs (node-cron, guarded)        │
   │  separation · bulkMilk · blendTank · surgeTank ·   │
   │  equipment · tick (issue/complete) · invAdjust     │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────▼─────────────────────────┐
   │     Services (state machines + business logic)     │
   │  separatorStateMachine · blend/surge MES services  │
   │  product parsers · nsInventoryLookup · sweeps ·    │
   │  adjustment correlation · cost revaluation ·       │
   │  analytics · statusStore (live dashboard state)    │
   └──────────┬───────────────────────────┬────────────┘
              │                           │
   ┌──────────▼─────────┐      ┌──────────▼────────────┐
   │  SQL Server (MSSQL)│      │ clients/coreClient.js  │
   │  Sequelize models  │      │ → SunApps Core API     │
   │  env-prefixed      │      │   (localhost:4000)     │
   │  tables            │      │ → NetSuite REST/SuiteQL│
   └────────────────────┘      └────────────────────────┘
```

**Key design points**

- **Provider abstraction** — the historian is accessed through a swappable provider held in a mutable holder (`app.locals.providerHolder`). `rest` reads the live plant; `historical` replays a past time window through a simulated clock (`sim/clock.js`); `mock` runs with no plant connection. Cron callbacks close over the *holder*, not a provider instance, so a swap takes effect on the very next tick.
- **Hot-swappable runtime config** — replay mode, sim start, speed-up, and per-job cron cadence live in a single DB row (`MesRuntimeConfig`, id=1) and can be changed at runtime via `/api/mes/dev/replay/*` with no restart (`reconcileMode()` in `server.js`).
- **Concurrency-guarded ticks** — every cron job runs inside `guarded()` (`server.js`): if the previous tick is still in flight, the new one is skipped, so a slow historian poll can never stack overlapping ticks.
- **Environment-isolated tables** — dev, prod, and local share one physical database; a global Sequelize `beforeDefine` hook prefixes every table (`prod_…`, `dev_…`). DEFAULT-constraint names are prefixed too (MSSQL constraint names are schema-unique).
- **Self-healing schema** — `db.ensureRuntimeSchema()` runs idempotent `ALTER TABLE`/`CREATE INDEX` blocks on every boot. There is **no migration tool**; every column added after a table first shipped gets a guarded DDL block in `models/index.js`.
- **Stateful & restart-safe** — batch and totalizer-cursor state is hydrated from the DB on boot, so a restart mid-production resumes cleanly without double-issuing or duplicate WO starts.
- **NS-confirmed cursors** — totalizer baselines (`lastIssuedTotalizerLbs`, `lastIssuedUhtGal`) only advance after NetSuite confirms a posting. If NS is down, the same delta is retried next tick. There are no queues.
- **Read-only against the plant.** No write-back to PLCs, ever.

## 4. Tech stack

- **Runtime:** Node.js 22 (deploy workflows pin Node 22)
- **Web:** Express 5 (`server.js`, port 4005)
- **Scheduling:** node-cron
- **ORM / DB:** Sequelize 6 → Microsoft SQL Server (`tedious` dialect, `encrypt:true`, `trustServerCertificate:true`)
- **Historian access:** AVEVA Historian REST API v2 (OData) over NTLM (`httpntlm`)
- **ERP integration:** NetSuite via the SunApps **Core API** gateway (`clients/coreClient.js` — this service holds no NS credentials)
- **Process manager:** PM2 (`sunapps_mes`)
- **CI/CD:** GitHub Actions → self-hosted Windows runners

Total dependency list is seven packages (see `package.json`). There is no test framework, no linter config, no TypeScript — plain CommonJS JavaScript.

## 5. Getting started

### Prerequisites

- Node.js 22+
- A SQL Server instance (the login needs **DDL rights** — `ensureRuntimeSchema` issues `ALTER TABLE` on boot)
- Network access to the AVEVA Historian and the Core API — or neither, with `HISTORIAN_PROVIDER=mock` and `MES_DRY_RUN=true`

### Install & run

```bash
npm ci
npm run start      # production
npm run dev        # node --watch
```

The service listens on `PORT` (default `4005`). Liveness:

```bash
curl http://localhost:4005/health
# → { status, uptime, historianProvider, lastSeparationPoll, lastBulkMilkPoll, lastBlendTankPoll }
```

### The two safety rails

1. **`ENVIRONMENT` defaults to `dev`** — an unconfigured instance physically cannot write into the `prod_` tables.
2. **`MES_DRY_RUN=true`** short-circuits *every* NetSuite POST (WO create, issue, completion, unbuild, adjustment, revaluation, BOM commit) and just logs the body. All local accounting state (DB rows, cumulative totals, cursors) still advances — this is how new behavior is validated with zero ERP side effects.

For a fully offline dev loop: `ENVIRONMENT=local HISTORIAN_PROVIDER=mock MES_DRY_RUN=true`.

## 6. Configuration reference

All config funnels through `config/index.js` (dotenv). Everything below is what the code *actually reads* — several documented-elsewhere variables are dead (flagged).

### Connections & identity

| Variable | Default | Purpose |
|---|---|---|
| `ENVIRONMENT` | `dev` | `dev` \| `prod` \| `local` (lowercased). Drives `TABLE_PREFIX = "<env>_"`, prod log-muting, **and the workOrderIssue wrapper-case default** (§15) |
| `PORT` | `4005` | HTTP port |
| `SQL_SERVER` / `SQL_DATABASE` / `SQL_USER` / `SQL_PASSWORD` | — | SQL Server connection |
| `CORE_API_URL` | `http://localhost:4000` | SunApps Core API gateway (→ NetSuite) |
| `HISTORIAN_PROVIDER` | `mock` | `mock` \| `rest` \| `historical` (env value `historical` makes `rest` the replay-off base) |
| `HISTORIAN_BASE_URL` / `HISTORIAN_DOMAIN` / `HISTORIAN_USERNAME` / `HISTORIAN_PASSWORD` | — | AVEVA Historian NTLM connection. Live base URL is `http://10.4.9.23:32569/Historian/v2/` (see `docs/historian-api.md`) |

### Cron cadences (production; replay mode overrides these — see §14)

| Variable | Default | Job |
|---|---|---|
| `SEPARATION_CRON` | `*/10 * * * * *` (10 s) | separationJob |
| `BULK_MILK_CRON` | `*/1 * * * *` (1 min) | bulkMilkJob |
| `BLEND_TANK_CRON` | `*/10 * * * * *` (10 s) | blendTankJob |
| `SURGE_TANK_CRON` | `*/10 * * * * *` (10 s) | surgeTankJob |
| `EQUIPMENT_CRON` | `*/5 * * * * *` (5 s) | equipmentJob — 5 s deliberately halves trapezoidal error on the UHT software totalizer |
| `RECEIVING_CRON` | `*/10 * * * * *` (10 s) | receivingJob — 8 historian tags per bay |
| `PACKAGING_CRON` | `*/10 * * * * *` (10 s) | packagingJob — ~55 historian tags; slow this first if AVEVA complains |
| `FACILITY_STATE_CRON` | `*/5 * * * * *` (5 s) | facilityStateJob — in-memory diff + broadcast |
| `FACILITY_LINES_CRON` | `*/15 * * * * *` (15 s) | facilityLinesJob — scheduler cache via Gateway; queues once a minute |
| `FACILITY_TRUCKS_CRON` | `0 * * * * *` (1 min) | facilityTrucksJob — one SuiteQL via Gateway |
| `TICK_CRON` | `*/5 * * * *` (5 min) | issueCompletionJob |
| `INVENTORY_ADJUSTMENT_CRON` | `*/5 * * * *` (5 min) | inventoryAdjustmentJob — matches the 5-min averaging window used to denoise idle-tank jitter |
| `LOSS_ROLLUP_CRON` | `40 5 * * *` (05:40 **plant time**) | lossRollupJob — MesLossDaily history, last `LOSS_ROLLUP_DAYS` (3) days; also once at boot (SD-729) |
| `LOSS_DIGEST_CRON` | `0 6 * * 1` (Mon 06:00 **plant time**) | lossDigestJob — weekly Milk Loss Teams card; posts only when `ENVIRONMENT=prod` **and** `LOSS_DIGEST_ENABLED=true` **and** `MES_DRY_RUN` off (SD-729) |

### Behavior knobs

| Variable | Default | Purpose |
|---|---|---|
| `MES_DRY_RUN` | `false` (strict `=== 'true'`) | Compute everything, post nothing to NS |
| `MES_MIN_ISSUE_LBS` | `10` | Delta below this defers to the next tick (no sub-pound NS spam) |
| `MES_MIN_COMPLETION_LBS` | `1` | Same, for completions |
| `MES_WASTE_RESIDUAL_FLOOR_LBS` | `200` | Tank level below this at batch close counts as empty |
| `MES_WASTE_RISE_FLOOR_LBS` | `20` | Per-tick destination level rise below this is ignored (arrival noise floor) |
| `MES_WASTE_DROP_FLOOR_LBS` | `20` | **Declared but unreferenced** — Phase-2 placeholder, no consumer anywhere |
| `LOSS_DIGEST_ENABLED` | `false` (strict `=== 'true'`) | Third gate on the weekly Teams digest (with `ENVIRONMENT=prod` and dry-run off). Absent = safely off; the card is still built and logged (SD-729) |
| `LOSS_ROLLUP_DAYS` | `3` | Plant days the nightly loss-history rollup recomputes (batches close late / get retried) |
| `LOSS_REPORT_URL` | `''` | Link placed on the digest card (the SunApps `/mes-loss-report` page) |
| `PLANT_TZ` | `America/Boise` | Timezone for the two reporting crons and for plant-day bucketing in the loss report |
| `MES_INFLOW_BACKFILL_LOOKBACK_HOURS` | `18` | How far back a freshly-named blend batch sweeps for `unmatched` inflows |
| `MES_PARSER_STRICT_MODE` | `false` | Disables fuzzy product parsing (blend + surge); unmatched product strings go to `pending_ns`. Turn on once AVEVA's standardized/constrained inputs are fully rolled out |
| `BLEND_TANK_OVERRIDES` | `{}` | JSON `{tankId: rawNsItemId}` — bypasses the blend product parser (sandbox scaffolding) |
| `SURGE_TANK_OVERRIDES` | `{}` | JSON `{tankId: fgNsItemId}` — same for surge |
| `PM2_APP_NAME` | `sunapps_mes` | Read directly by `devRoutes.js`; the pm2 process `/reset` restarts |

### Dead / vestigial variables (documented elsewhere, ignored by code)

| Variable | Reality |
|---|---|
| `TEAMS_WEBHOOK_URL` | **Dead.** Runtime Teams alerting was deliberately disabled — `notifyService.sendAlert()` is a no-op (commit `598e472`). Only the GitHub Actions deploy workflows post to Teams (via the `TEAMS_SOFTWARE_DEPLOYMENT_HOOK` repo variable). |
| `SIM_START` / `SPEEDUP` | **Vestigial.** Consumed only to seed the `MesRuntimeConfig` row on the *very first boot ever*. After that the DB row is authoritative and these env vars are ignored. Use `/api/mes/dev/replay/config` instead. |
| `BLEND_BOM_RESTLET_SCRIPT` / `_DEPLOY`, `BOM_ADMIN_SUBSIDIARY` | Zero references in this repo (presumably consumed by the Core gateway). The RESTlet BOM-editor path was abandoned (SD-636, 2026-07-13) — NetSuite's blend addon blocks all programmatic BOM edits. Don't revive it. |

## 7. Boot sequence

Read `server.js` top-to-bottom once; the order matters.

1. `require('./config')` — runs dotenv, creates the Sequelize instance, **and registers the `beforeDefine` table-prefix hook before `./models` loads** (this ordering is why prefixing "just works").
2. Prod log muting — if `ENVIRONMENT === 'prod'`, `console.log/info/debug` become no-ops globally (`console.warn`/`error` survive). **In prod, most log statements do not print.** The boot banner uses a saved binding (`bootLog`) so it still shows.
3. Provider holder created (`providerHolder.current = createProvider(baseProviderType)`), cron registry + `guarded()` wrappers declared, `reconcileMode()` defined. Nothing scheduled yet.
4. `sequelize.sync()` then the async boot block:
   1. `db.ensureRuntimeSchema()` — idempotent schema evolution + `seedFgInputPairings()` + `MesRuntimeConfig` row-1 bootstrap.
   2. `statusStore.hydrate*` × 4 (separation ring, tick state, recent blend/surge batch rings).
   3. `separatorStateMachine.hydrateFromDb()` — resumes a `running` separation batch with its totalizer baselines.
   4. `blendTankJob.hydrateFromDb()` / `surgeTankJob.hydrateFromDb()` — re-open `active` batches into in-memory tank state so a restart mid-batch neither fires a duplicate WO start nor orphans the row.
   5. `runtimeConfigService.load()` → `reconcileMode(config)` — **cron jobs are scheduled here for the first time** — then `onChange(reconcileMode)` registers the hot-swap listener.
5. Middleware, `/health`, and the nine route mounts (§17) are registered synchronously.
6. `app.listen(PORT)` — note this is **outside** the `.then()`, so the HTTP server accepts traffic before hydration completes; see Gotchas (§16).

## 8. The cron jobs

All seven are wired identically: `cron.schedule(expr, guarded(name, () => job.run(providerHolder.current)))`. The provider is passed fresh each tick (hot-swap mechanism). `guarded()` skips a tick if the previous one is still running.

| Job | File | Prod default | Replay default | Reads | Emits |
|---|---|---|---|---|---|
| separation | `jobs/separationJob.js` | 10 s | 5 s | `getSeparatorTickSnapshot()` | assembly unbuilds (via state machine → `milkMesService`) |
| bulkMilk | `jobs/bulkMilkJob.js` | 1 min | 30 s | `getBulkMilkFlowData(since)` | legacy bulk-milk WO issues |
| blendTank | `jobs/blendTankJob.js` | 10 s | 5 s | `getBlendTankStatus()`, `getMilkLineStatus()` | blend batch starts/ends, line tail-catcher |
| surgeTank | `jobs/surgeTankJob.js` | 10 s | 5 s | `getSurgeTankStatus()`, `getUhtSurgeTankRouting()`, `getUhtStatus()` | surge batch starts/ends |
| equipment | `jobs/equipmentJob.js` | 5 s | 10 s | silos + UHTs + surge tanks + routing | **read-only** — statusStore only; also drives UHT totalizer integration cadence and the sticky "UHT→tank" activeFill designation |
| receiving | `jobs/receivingJob.js` | 10 s | 10 s | `getReceivingStatus()` (receiving bays 1/2 XFR) | **read-only** — statusStore + silo activity; feeds the facility map |
| packaging | `jobs/packagingJob.js` | 10 s | 10 s | `getPackagingStatus()` (~55 packaging counters/flows/sterile tags) | **read-only** — movement + rates for the facility map's line evidence |
| facilityState | `jobs/facilityStateJob.js` | 5 s | 10 s | none (statusStore + cached sources) | **read-only** — facility-map change-sets → Gateway socket room |
| facilityLines | `jobs/facilityLinesJob.js` | 15 s | 30 s | none (Gateway: scheduler state, staging queues) | **read-only** — line facts for the map |
| facilityTrucks | `jobs/facilityTrucksJob.js` | 1 min | 1 min | none (Gateway: SuiteQL milk trucks) | **read-only** — truck queue for the map |
| tick | `jobs/issueCompletionJob.js` | 5 min | 30 s | totalizer deltas via services | many small WO issues + completions (blend pass, then surge pass in its own try/catch) |
| invAdjust | `jobs/inventoryAdjustmentJob.js` | 5 min | 30 s | silos, blend tanks, lines, UHTs | at-rest sweep → NS inventory adjustments |
| lossRollup | `jobs/lossRollupJob.js` | daily 05:40 plant | — | none (batch tables only) | **writes only `MesLossDaily`** — persisted Milk Loss history, $ frozen at that morning's prices; registered once at boot outside the replay cron set, tz-pinned (SD-729) |
| lossDigest | `jobs/lossDigestJob.js` | Mon 06:00 plant | — | none | **read-only** — weekly Teams Adaptive Card via Gateway `POST /internal/notify/teams` (channel `loss`); triple-gated, otherwise logs the card + `lossDigest.dryRun` event (SD-729) |

Job-internal guards worth knowing (constants live at the top of each file): blend `MIN_BATCH_AGE_MS` 2 min (suppresses premature ends, *except* `all_lines_stopped`), `ALL_LINES_STOPPED_IDLE_MS` 5 min, line reset threshold 100 lb; surge `FILL_TICKS_FOR_START = 5`, `FILL_NOISE_GAL = 5`, CIP = state 4 is ineligible; equipment hysteresis `SWITCH_TICKS = 12` / `IDLE_TICKS = 36` (tick *counts*, so wall-time scales with the cron cadence).

## 9. The production flows, in detail

### 9.1 Separation → assembly unbuild

`separationJob` is a thin shell around **`services/separatorStateMachine.js`** — a per-tick state machine (design in `BATCH_LIFECYCLE_PLAN.md`; the separator half is the part that shipped).

- **Open:** feed-permit rising edge (`SEPSTAT.FEEDPERMIT`), with a 6-tick recovery fallback and a duplicate-volume suppression guard (same silo, within 8 h, within 5 % volume of a recent error/pending batch).
- **Baselines:** at open, the feed/cream/skim totalizer values are captured (`feedStartLbs` etc.). All volumes are `current − baseline` — the totalizers never reset, and missing baselines historically caused 2–4 duplicate unbuilds per physical separation.
- **Close** (priority order): `transfer_complete` → `cip_started` → `source_changed` → `destination_changed` → `product_index_changed` → `idle_rpm` → `idle_feedpermit`. Only the two boundary reasons re-open a new batch the same tick.
- **Guards at close:** input < 1 lb → `skipped` (phantom reopen); cream+skim > input × 1.02 → `pending_ns` for review (mass-balance violation), no unbuild posted.
- **Item resolution:** destination classification is C-silo → cream, other M-silo → skim, but the *item* comes from the Standardization HMI product index per silo (`IndexSelectRead`, indices 1–26 in `PRODUCT_INDEX_ITEM_MAP`) — never from silo naming. Cream item is derived **from the source item** (`getCreamItemForSource`: A2 sources → 8365, organic → 5483, else 5480) because the cream silo's own index is often stale.
- **BOM:** `getSeparationBomId(sourceItemId, skimProductIndex)` via `SEPARATION_BOM_MAP` — conventional 5417 → BOMs 337/338/351/353/251, organic 5404 → 347–350/252, A2 5403 → dedicated A2 BOMs 423/424/425/253 (A2 has only 4 fat levels on the separator HMI: 3.25 %, 2 %, 1 %, skim — no 3.5 %/4 %).
- **Post:** `POST /record/v1/assemblyUnbuild` — see §15 for the body shape and the **bin-5020 staging trick** that defeats NS's "largest-other-bin" quantity cap.
- Failures that are catalog problems (unmapped index, missing BOM) land in `status='pending_ns'` with an itemized `gaps[]`, not `error` — ops fixes data, then retries via the API.

### 9.2 Blend tank batch lifecycle (Layer 2)

`jobs/blendTankJob.js` tracks per-tank in-memory state and reacts to discrete events on `NOTE_STRING` and the tank load cell:

- New valid product name → close current batch (if any), start a new one.
- Name cleared → end (`note_cleared`). Weight < 100 lb after ≥ 2 min → end (`emptied`). All lines stopped 5 min → end (`all_lines_stopped`).
- `PRODUCT_SENTINELS` (`cip`, `water`, `sterile`, `none`, `-`, …) are never products.

On start, **`blendTankMesService.processWOStart()`**: duplicate guard + 5-min cooldown → resolve the product (override env → `blendTankProductParser`: exact `RAW_FG_ITEM_MAP` first, then fuzzy brand/fat%/modifier scoring unless strict mode) → `POST /record/v1/workOrder` with `isWip:true`, location 30, subsidiary 3, and the MES custom body fields → persist to `MesBlendTankBatches` (`active`). If NS rejects the item for a cost-basis error, `costRevaluationService.ensureCostBasis()` auto-remediates (§15) and the create is retried.

**Late naming / backfill:** tanks are routinely filled *before* the operator names them. Inflows observed with no active batch are stored as `status='unmatched'` `MesBlendTankInflows`; when the batch finally starts, `backfillUnmatchedInflows()` issues + completes them (within the 18 h lookback), mirroring backfilled pounds into `cumulativeOutputLbs` so they complete 1:1 without phantom waste. `batchStartFinder.findBlendTankActualStart()` also back-projects the real start time from line/level history into `actualStartAt`.

**Line tail-catcher:** each milk line's totalizer is watched; on a reset (>100 lb → <100 lb) or source clear, `processLineFlow()` captures the final `peak − lastIssued` delta the 5-min tick hadn't seen. The MEM* latch tags exist because `REQUESTEDBY` clears to "None" the instant flow ends.

### 9.3 The 5-minute tick — issues & completions

`jobs/issueCompletionJob.js` is the accounting heartbeat. NetSuite ends up with **hundreds of small incremental WO issues/completions that sum to the batch total** — this matches SunTado's existing NS practice and keeps NS in sync within minutes of physical flow.

**Blend pass** (`tickAllActiveBatches`): per active batch, per matching line, `delta = currentTotalizer − lastIssuedTotalizerLbs` (cursor in `MesPipeIssueStates`). Deltas ≥ 10 lb are grouped **one workOrderIssue per (source bin, item) tuple**, posted via the transform endpoint with all non-target BOM lines omitted, and the cursor advances only after NS confirms. A catch-up pass handles lines that reset while the service was down (using the stored `lastProductName`/`lastSiloName`). If the BOM is missing the component, the WO is PATCHed to append it at qty 0 first (`ensureItemOnWoBom`).

**Arrival & completion:** completions are driven by **measured arrival, not by what was issued**. For blend, arrival = positive load-cell rise on the destination tank (`tickArrivalForBatch`, rise floor 20 lb). When `cumulativeOutputLbs − cumulativeCompletedLbs ≥ 1 lb`, a `workOrderCompletion` fires with the deterministic lot (`MMDDYY` + WO digits) into the tank's bin. Completions are serialized per WO (`withCompletionLock`) because concurrent creates on the same lot make NS throw "already exists"; that error path reconciles against the WO's `builtQuantity`.

**Surge pass:** per batch, `deltaGal` on the UHT software totalizer × **8.6 lb/gal** is issued against the *pinned* component (below). Arrival = surge level rise × 8.6, **plus — behind `MES_METERED_DRAIN` (SD-708) — metered Filler 1 drain** from the TR11_FT1140 inlet meter (`computeFiller1DrainForTick`: reset-tolerant odometer cursor, gated on the Sel1 latch, a sole-claimant check across ST81/82, and Filler 1 RunMode), so an ST81/82 tank that fills and drains simultaneously still gets credited with what passed through. The always-on shadow column `outputWithDrainLbs` records what output *would* be with the credit applied even while the flag is off. Concurrent drain on unmetered legs (ST83/84's Sel3/4 lines, or a Filler 2 draw on the shared Sel1 leg) keeps the batch flagged `concurrentFillDrain` and its waste an **upper bound**, not a measurement.

### 9.4 Surge tank batch lifecycle (Layer 3)

`jobs/surgeTankJob.js` uses a stricter start gate than blend (history: sandbox false-starts from plumbing signals):

- `_ProductDesc` changes to a valid product → adopt it, reset the fill counter.
- **5-tick fill gate:** a tick counts only when *both* Δgal > 5 **and** the feeding UHT is in PROCESS step **"Sterile on Product"**. Five consecutive ticks (~50 s) opens the batch; any miss resets to 0. (Do **not** gate on `sterProdBarrOK` — it's a valve/plumbing indicator, not a sterility signal.)
- State 4 = CIP → ineligible. `_ProductDesc` cleared or < 10 gal after 2 min → end.

On start, **`surgeTankMesService.processWOStart()`**:

1. Resolve the FG via override env or `surgeTankProductParser` (FG catalog — distinct from the blend parser's raw-FG catalog).
2. **`resolveLayer3Component()`** pins the *single* raw component this batch will consume, recorded on the row (`componentItemId`/`componentBinId`/`componentResolvedFrom`): feeding blend tank → that tank's active batch `mesItem` (fallback: most recent completed batch with real output within 72 h — excludes phantom batches); feeding silo → live line-product resolution via `lineIngredientMapper` (never a static silo guess); silo→TSTAT→UHT bypass handled by `resolveComponentFromUhtFeedLine`.
3. **FG-pairing gate:** the `(fgItemId, rawInputItemId)` combo is looked up in `MesFgInputPairings`. `approved` → proceed; missing → auto-inserted as `pending` and the batch runs flagged `pairingStatus='pending_review'`; **`rejected` → the WO is held** and the batch parks in `error` until ops fixes the pairing (`/api/mes/fg-pairings/:id/fix` rejects the bad combo and approves the corrected one atomically). Canonical pairs from `RAW_FG_TO_FG_MAP` are auto-approved by the boot seeder.
4. `POST /record/v1/workOrder` with a **custom one-line component list** (`item.items = [{item:{id:component}, quantity:1}]`) so NS doesn't auto-populate a static BOM that wouldn't match skip paths.
5. The UHT totalizer is snapshotted, and a fire-and-forget back-projection (`findSurgeTankActualStart` + `integrateFt1102BackfillGal`) seeds the issue cursor with gallons that flowed *before* detection.

**Single-claimant rule:** a UHT feeds one tank at a time, but two open batches can reference the same UHT. Each tick, `resolveIssueModes()` consults the equipment job's sticky `activeFill` designation: the active tank gets `issue`, siblings get `forfeit` (cursor advances, gallons discarded), ambiguity → `hold` (nothing moves). Without this, both WOs double-count the same totalizer delta.

### 9.5 Batch end (`processWOEnd`, blend + surge)

Reload the row → final issue tick (surge) → one last completion flush → compute waste (§10) → `status='completed'`, write `MesProcessingLog`, clear caches. A batch that never measured arrival falls back to completing 1:1 against issued (no phantom waste from a dead sensor).

### 9.6 Bulk milk (legacy) & equipment

`bulkMilkJob` supports manually-registered bulk-milk WOs (`MesBulkMilkRuns`) accumulating separator output via cream/skim totalizer deltas — the oldest flow, rarely touched. `equipmentJob` is pure status: silo/UHT/surge snapshots into `statusStore`, plus the hysteresis-guarded per-UHT `activeFill` tank designation the surge single-claimant rule depends on (so it is a **control input**, not just dashboard fluff).

## 10. Waste & shrinkage accounting

The core idea (SD-597 → SD-636): **WO completion is driven by measured arrival into the destination vessel; `issued − arrived = waste`, and it lands in NetSuite as WIP shrinkage** (the WO closes with more issued than built).

- Blend: arrival = destination tank load-cell rise (rise floor 20 lb; residual floor 200 lb at close).
- Surge: arrival = level rise, plus metered Filler 1 drain (TR11_FT1140, SD-708) when `MES_METERED_DRAIN` is on; the always-on shadow column `outputWithDrainLbs` records what output would be with the credit applied (the dev-soak comparator). Unmetered concurrent drain (ST83/84's Sel3/4 legs; a Filler 2 draw on the shared Sel1 latch) → `concurrentFillDrain=true` and waste is an upper bound; when every concurrent tick was metered on line 1 only, the close note reports waste as measured. `meteredDrainLbs` (raw pre-floor credit), `meteredDrainTickCount`, `concurrentTickCount`, `drainFillerLines` are recorded per batch.
- Separation: waste = feed − cream − skim over the batch window (baselined totalizers). Waste % > 5 (`WASTE_ALERT_THRESHOLD`) logs an alert event (console + statusStore only — Teams is off).
- `wastePercent` is only computed when input/issued ≥ 10 lb and is clamped to ±999999.99 (sensor-glitch overflow protection — this literally overflowed a DECIMAL(5,2) once).

**Milk Loss executive report (SD-729, `services/lossReportService.js`)** rolls the three batch tables up for leadership and is deliberately stricter than the analytics tabs: (1) every surge figure is split into a **measured** part and an **upper-bound-only** part (`wasteLbs = wasteLbsMeasured + wasteLbsUpperBoundOnly`) using the same fully-metered predicate as batch close (`concurrentFillDrain=0`, or every concurrent tick metered on line 1); the measured figure is `issued − COALESCE(outputWithDrainLbs, output)`, which is right whether `MES_METERED_DRAIN` is on or off; (2) closed batches with < 100 lb issued are **unaccounted** production (listed, never counted as zero loss); (3) families without a price row are reported as **unpriced pounds** — no global fallback; (4) **loss $ is measured two ways, as peers** — raw-milk *cost* (`wasteUsd`, per-family $/lb) and forgone finished-goods *revenue* (`lostRevenueUsd`, per-item $/lb), both with the same measured/upper-bound split, never added together, and no revenue figure for separation; (5) `MesInventoryAdjustments` is never read (the sweep↔shortfall loop makes it noise); (6) pounds are canonical, `units.lbsPerGal` (= `mesItemConfig.LBS_PER_GAL`, 8.6) is published for display-only gallons; (7) batches are attributed to the plant-local (America/Boise) day they **closed**, weeks start Monday. Separation batches carry the HMI product index in `itemId` (15/16/21…), so family classification there goes through `PRODUCT_INDEX_ITEM_MAP` (`familyCaseExpr({ indexCols })`).

The analytics layer folds *exact-linked* inventory adjustments into a batch's holistic waste: `wasteWithAdjLbs = issued + exactNetLbs − completed`. Fuzzy-linked sweep adjustments are shown but deliberately **not** folded in (a silo sweep spans many batches; folding it into one would overstate).

## 11. Inventory adjustments, sweeps & correlation

Three distinct things post `inventoryAdjustment`s, all funneled through `services/inventoryAdjustmentService.js`, all audited in `MesInventoryAdjustments` (every path writes a row: `submitted`, `dry_run`, `skipped`, `error`):

1. **Shortfall bumps** (`source='shortfall'`) — inline top-ups fired right before retrying an issue/unbuild that NS rejected for insufficient bin/lot quantity. Surge parses NS's "Inventory numbers are not available" error to top up **the exact pinned lot** by `needed − onHand + 5`.
2. **At-rest sweeps** (`source='sweep'`) — `tankAtRestSweepService` runs every 5 min. For every silo/blend tank that is *not in motion* (no active line route, not feeding/being-fed by a UHT in PROCESS, no active batch, not source/dest of a running separation), it averages the level over a 5-min window (skip if peak-to-peak > 2000 lb) and calls `reconcileBinToPhysical`: drive the NS bin to exactly the observed quantity of the *current* item and **zero of everything else** — negative lots raised to 0 first, stale products cleared. The current-item leg only fires when the delta ≥ 500 lb (sensor noise); cleanup legs use a 1 lb floor. The silo's current item is resolved **live** (HMI product index) — never from a static map (a static map was tried; its per-item nets were pure artifacts).
3. **Unbuild-cap staging** (`source='unbuild_cap'`) — the bin-5020 dance in §15.

**Correlation** (`services/adjustmentCorrelationService.js`): every adjustment row carries structured trigger columns (`triggerKind` `wo|sepBatch|sweep`, `nsWorkOrderId`, `batchKind`, `mesBatchId`) written at post time; legacy rows fall back to memo-regex parsing, then to bounded fuzzy matching (±6 h window, tank/item/time scoring). This powers `/api/mes/analytics/inventory-adjustments/correlations`, the batch-centric `batches-with-adjustments` view, per-batch drilldowns, and a live SuiteQL pull of the *actual* NS transactions (`/batches/:kind/:id/netsuite`) as source-of-truth reconciliation.

Sweep rules of interpretation: silo up-adjustments usually mean a truck receipt landed physically before paperwork — they are **never** force-attributed to a batch (source down-only for silo legs; the analytics `excludePositiveSilo` filter exists for exactly this). Only the grand net and gross churn of sweep adjustments are physically meaningful; per-item splits are only as good as the live item resolution.

## 12. Data model

Sequelize models in `models/`, one file per table, **zero associations** — all linkage is plain columns + manual joins. `timestamps:false` everywhere; rows carry explicit `createdAt`/`detectedAt` columns.

| Table (env-prefixed) | Model | Purpose |
|---|---|---|
| `MesSeparationBatches` | `MesSeparationBatch` | One row per separator batch. Volumes + **totalizer baselines** (`feedStartLbs`…), `destinations` JSON snapshot, boundary-detection snapshots (`prev*Json`), `endReason`. **Unique** `(batchId, sourceSilo, batchEnd)` — the dedup guard; a null `batchEnd` is the open row. Status: `pending, running, race_dedup, pending_ns, dry_run, skipped, completed, error, rejected` |
| `MesBlendTankBatches` | `MesBlendTankBatch` | One row per blend batch. NS WO linkage, `cumulativeIssuedLbs/CompletedLbs/OutputLbs`, `actualStartAt`, waste columns. Status: `active, dry_run, pending_ns, completed, error, rejected, cancelled` |
| `MesBlendTankInflows` | `MesBlendTankInflow` | Per-line inflow audit; `blendTankBatchId` nullable → `unmatched` rows are the late-naming backfill pool. Status incl. `unmatched, tick_already_issued` |
| `MesPipeIssueStates` | `MesPipeIssueState` | Per `(batch, line)` totalizer cursor + last product/silo for restart recovery. **Unique** `(blendTankBatchId, line)` |
| `MesSurgeTankBatches` | `MesSurgeTankBatch` | Richest model: pinned Layer-3 component (`componentItemId/BinId/ResolvedFrom`), `layerSkipReason`, `pairingStatus` (incl. `blocked`), feed source, cumulative totals, `meteredDrainLbs`, `concurrentFillDrain/TickCount`, `drainFillerLines`, waste |
| `MesSurgeTankIssueStates` | `MesSurgeTankIssueState` | Per `(batch, UHT)` gallons cursor (`lastIssuedUhtGal`). **Unique** `(surgeTankBatchId, uhtId)` |
| `MesFgInputPairings` | `MesFgInputPairing` | FG ⇐ raw-input whitelist; `approved/pending/rejected`. **Unique** `(fgItemId, rawInputItemId)` — makes seeding idempotent |
| `MesInventoryAdjustments` | `MesInventoryAdjustment` | Audit of every adjustment attempt; `source` (`sweep/shortfall/unbuild_cap`), signed `qtyDelta`, structured trigger-correlation columns |
| `MesBulkMilkRuns` | `MesBulkMilkRun` | Legacy manual bulk-milk WOs |
| `MesProcessingLog` | `MesProcessingLog` | Append-only log of every NS POST attempt with full payload + response (singular table name; no indexes) |
| `MesRuntimeConfigs` | `MesRuntimeConfig` | **Single row, id=1**: `replayMode`, `simStart`, `speedup`, `replayCronsJson` |
| `MesLossDaily` | `MesLossDaily` | **Persisted Milk Loss history (SD-729)**: one row per plant-local close *day* × stage (`separation`/`blend`/`surge`; v2 adds `received`/`packaging`) × equipment × raw-milk family — `lbsIn`, `wasteLbs = wasteMeasuredLbs + wasteUpperBoundLbs`, `wasteUsd` **frozen at the `pricePerLb` in effect at rollup**, `lostRevenueUsd`, batch/unmeasured/zero-issued counts, `heldLbs`. **Unique** `(day, stage, equipment, family)`. Written by `lossRollupJob` (delete-and-reinsert per day, idempotent), `POST /api/mes/analytics/loss-report/rollup` and `scripts/backfillLossDaily.js`; read by `GET /loss-history`. Born in 1.0.13 → created by `sync()`; later columns need an `ensureRuntimeSchema` block |

**Schema evolution:** there is no migration tool. `sequelize.sync()` creates *new* tables only; every column/index added after a table first shipped has an idempotent guarded DDL block in `db.ensureRuntimeSchema()` (`models/index.js`) — `IF NOT EXISTS(sys.columns…) ALTER TABLE ADD`, widen-column guards, `sys.indexes` guards. When you add a model column, **you must also add its block there** or existing deployments never get it. DEFAULT-constraint names must be prefixed (`DF_${P}Table_col`) or dev/prod collide in the shared DB.

**Seeding:** `seedFgInputPairings()` upserts every `RAW_FG_TO_FG_MAP` pair as `approved` (by `findOrCreate` on the unique index) on every boot; ops-added rows are never touched. The `MesRuntimeConfig` row is created once, seeded from env, then env is ignored forever.

## 13. The historian layer

`historian/index.js` `createProvider(type)` → one of three providers, all implementing the interface documented in `historian/providers/baseProvider.js` (14 methods: separator batches/status/snapshot, bulk-milk flow, blend-tank status, milk-line status, silo status, UHT status/routing/totalizer/fromEnt, surge status, `getFiller1InletFlow`).

### `restProvider.js` — the live one (~1300 lines, read its header comments)

Talks OData v2 over NTLM. Two read styles: `Tags('fqn')/Raw?$orderby=DateTime desc&$top=1` for **current values** and `ProcessValues?$filter=…` (paginated via `@odata.nextLink`) for history. Quirks it exists to absorb — each has an in-code rationale comment, and each cost real debugging time:

- **DST timestamp lag:** ProcessValues runs ~1 h behind; recent events queried through it silently fall outside the window. Current values and the separator rising-edge detector therefore use the Raw endpoint.
- **Double-prefixed tags:** real surge level/gallons live at `ThermaRoute.ThermaRoute.ST{N}_LT8{N}01[_Gal]`; the single-prefix variants return OpcQuality=0/zeros.
- **Silo tag casing:** live gallons are at `MSilo{N}_Gallons.Value` (mixed case); the UPPERCASE `.GALLONS/.LBS` variants are bad-quality. ProductName/Density stay UPPERCASE. Names are normalized both ways (`RawMilkSilo5` ⇒ `MSilo5`).
- **UHT mode-bit separators differ per UHT** (`UHT1.Mode.CIP` vs `UHT2.Mode_CIP`) — per-UHT FQN builders.
- **Software UHT totalizer** (`_uhtMilkGal`): trapezoidal integration of `FT1102_Output` GPM, **only during "Sterile on Product"** (counting all of PROCESS once booked ~100 GPM of water recirc as >1M lb of milk on a 10k-gal tank); negative/raced contributions floored (a concurrent-poll race once drove it to −394k gal).
- **Rate-sample pollution:** multiple crons hit the shared provider within the same second; sub-second gaps with quantized gallon changes produced 30k lb/min spikes — samples under a minimum elapsed time are rejected, and each consumer keeps its *own* baseline (`_prevSurgeGal` vs `_surgeRatePrevGal` vs `_destPrevGal` are deliberately separate).
- **Filler drain** (`getFillerDrainGal`, SD-636): AnalogSummary `Average × duration` per bucket (NOT the `Integral` field — its time basis is inconsistent per tag), l/min despite the l/h label, negative glitches clamped, empty buckets = "unreadable" (`measured:false`), never zero. Sel→metered-filler map: `{Sel3: [5,6], Sel4: [3,4]}`. Meters also see CIP/water flow; the arrival clamp bounds it.
- **Filler 1 inlet meter casing (SD-708):** the totalizer's catalog FQN really is misspelled — `THermaRoute.TR11_FT1140.Totalizer_1` (capital H). `Tags('fqn')/Raw` resolves FQNs case-*in*sensitively, but `$filter=FQN eq` on ProcessValues/AnalogSummary is case-*sensitive* — wrong casing silently returns zero history, no error. Both FT1140 tags are deadbanded to ~nothing in ProcessValues (10 rows/30 d); history reads must use AnalogSummary (~60 and ~42 samples/min). The totalizer also counts non-production flow (flush/CIP ran ~13k gal through it before the first RunMode=1) — product math must gate on RunMode/Sel1, the same lesson as FT1102's "Sterile on Product" gate. Exposed live via `getFiller1InletFlow()` (gpm + totalizer + RunMode; `measured:false` on failed/bad-quality reads; never rejects — it must not fail the whole equipment poll) and historically via `/api/mes/filler-flow`; canonical FQNs are exported as `RestProvider.TAGS`. Evidence: `scripts/probeTr11FillerFlow.js`.
- Per-instance delta state (`_prevTransferComplete`, `_prevCreamTotal`, …) means **provider swaps reset all deltas** — first tick after a swap re-baselines.

### `historicalProvider.js` — replay

Extends RestProvider and changes only what "now" means: `_now()` → sim clock, `_getCurrentValue()` → a sim-time-pinned ProcessValues lookup with a 15-sim-second cache, a 3-request semaphore (on-prem AVEVA 500s with empty bodies at 5–8 concurrent queries), retry backoff, and **null on exhausted retries** (a tick proceeds with partial data rather than dying).

### `mockProvider.js`

Randomized-but-realistic data, three separation scenarios to exercise product-index resolution. Does not implement `getFillerDrainGal`.

### Tag reference

`scripts/all-tags.json` (3.4 MB) is a dump of every historian tag (`FQN`, `Description`, `EngUnit`, `TagType`), refreshed by `scripts/discoverTags.js`. `docs/historian-api.md` documents the OData API itself. `HistorianTags.docx` is the original tag handoff from controls.

## 14. Historical replay & runtime config

Replay mode re-runs a past plant window through the real pipeline — used for backfill after outages and for testing against real historical behavior. Control surface: `/api/mes/dev/replay/*` (§17). The source of truth is the `MesRuntimeConfig` DB row, **not** env vars.

- `POST /enable {simStart, speedup, replayCrons?}` — swaps the provider to `HistoricalProvider`, starts the sim clock, and reschedules all crons to the replay cadences (`DEFAULT_REPLAY_CRONS` in `runtimeConfigService.js`: most jobs 5 s, tick/invAdjust 30 s; 5 s wall × speedup 60 = 5 sim-minutes per tick).
- `POST /disable` — back to the base provider and env crons.
- `POST /pause` / `resume` — freeze/unfreeze the sim clock (in-memory only; lost on restart).
- `POST /reset` — the nuke: resets the sim clock to `simStart`, resets every job's in-memory state, clears caches/statusStore/pollStore, **deletes all rows from the environment's MES tables** (children-first), re-seeds pairings, responds, then `pm2 restart`s itself 500 ms later so everything rebuilds from the clean DB. Dev-environment tool; the table prefix is what makes it safe.
- `sim/clock.js` — all services/jobs that timestamp batch state use `clock.now()`, which is wall time unless the sim is active.

Caveats: flipping replay on/off resets in-memory job state but does **not** re-hydrate active DB batches (only boot does) — use `/reset` or restart rather than a bare `/enable` when correctness matters. `bulkMilkJob` is missing from the flip-reset list entirely (§16).

## 15. NetSuite integration & hard-won NS facts

This service never talks to NetSuite directly. `clients/coreClient.js` wraps the SunApps **Core API** gateway (`CORE_API_URL`, default `localhost:4000`), which holds the NS credentials and proxies `/api/netsuite/*` (REST record API), `/api/netsuite/suiteql`, and `/api/netsuite/restlet`. No auth headers, no retry, no timeout in this client — failures surface as thrown errors with `.status`/`.data` and are retried naturally by the next cron tick.

Constants that matter: location **30**, subsidiary **3** (Suntado), adjustment account **476**, revaluation account **477**, department **7**. Bin maps live in `mesItemConfig.js` (`MSilo1–5` → 4931–4935, `CSilo1–3` → 4928–4930, blend tanks → 3105–3108, `ST81–84` → 4995–4998). Current stock lives in **49xx-range bins**; a huge on-hand in a low-numbered bin (e.g. 1003) is pre-cutover garbage and `findBinForItem` ignores them.

Every shape below was established by trial-and-error against NS. **Do not "clean up" these payloads without re-testing against both sandbox and production.**

| Transaction | Endpoint | The facts |
|---|---|---|
| Work order | `POST /record/v1/workOrder` | **`isWip:true` is mandatory** — without it every subsequent issue 400s with "does not use WIP, or is closed". Surge WOs pin a custom one-line `item.items` component list; blend retries with a 0-qty seed component if NS demands "at least one line item" (which can make the WO circular — see cost basis below). All records carry `custbody_liquid_milk_wo` plus tank/product/source/dest custom fields. |
| WO issue | `POST …/workOrder/{id}/!transform/workOrderIssue` | Only the target line is included; others are omitted. **The bin-only inventory-detail wrapper casing is per-NS-account:** sandbox keys off the WO's lot mix (lot-bearing → lowercase `componentinventorydetail`, pure bin-only → camelCase `inventoryDetail`); **production inverts it** (bin-only always camelCase). Default is keyed off `ENVIRONMENT`, and `postWoIssueWithWrapperRetry` self-heals by flipping the case when NS *silently ignores* the wrong wrapper (yes — wrong casing is ignored, not rejected: the issue posts with no inventory detail). `binnumber` is `{id:Number}` (a string silently credits 0). Lot lines use `issueinventorynumber` with the lot internal id. |
| WO completion | `POST …/!transform/workOrderCompletion` | Lot = `MMDDYY`+WO digits (the idempotency key). Concurrent completions on one WO race in NS ("already exists") → serialized per WO + reconciled against `builtQuantity`. `receiptInventoryNumber` is the raw lot *string*; `binnumber` a string id here. |
| Assembly unbuild | `POST /record/v1/assemblyUnbuild` | Header `quantity` must exactly equal the source inventory-detail quantity. Requires `billOfMaterials.id`. **NS caps unbuild qty at the largest single-bin content *other than* the source bin you assign** (dynamic, value-based — proven by experiment; not payload-fixable). Workaround: stage `qty+1` of the source item into scratch bin **5020** first, unbuild, then zero the staging back out in a `finally` (`source='unbuild_cap'` adjustments). The source bin is also pre-topped to `qty+5` with backoff polling for NS's inventory-balance lag. |
| Inventory adjustment | `POST /record/v1/inventoryAdjustment` | Header ids are **raw numbers** (`account: 476`, not `{id:476}`); line `department` is `{id:'7'}` (inconsistent, yes). **Up-adjusts require line `unitcost` = the item's standard cost** or NS 400s "Lines cannot have a negative unit cost". `receiptInventoryNumber` is a raw lot-name string for both directions; once a lot ref is present, `binnumber` must be a raw string. Down-adjusts are clamped to *available* (not on-hand). |
| Cost revaluation | `POST /record/v1/inventoryCostRevaluation` | NS's error "Inventory Revaluation is no longer the first transaction" on a workOrderIssue actually means: a STANDARD-cost item has cost 0 and no reval. Fix: BOM-rollup reval dated one day *before* the item's earliest transaction, built from the **master BOM revision** (never the WO's own lines — they sit at qty 0 and can be circular from the seed fallback). `costComponent.cost` is the **extended** amount (NS sums lines; it does not multiply by qty); `isMaterialOverhead` must be the string `'F'`. Auto-invoked by the blend WO-start path, once per item per process. |
| SuiteQL | `POST /query/v1/suiteql` | Always the raw endpoint (`core.suiteQL()`'s route is mis-wired — noted in two services). No `dual`. `transaction.createdfrom` is **not queryable** — joins go through the NS ids we recorded. `inventoryassignment.bin` (not `binnumber`), no item column; join via `transactionline`. Lines are double-entry: headline qty per txn = `MAX(ABS(quantity))`; unbuild input = \|Σ negatives\|. Gateway 401 `INVALID_LOGIN` is transient on warmup — retry. |

Other NS behaviors encoded in the services: WO create 400 "Invalid Field Value N for field item" usually means the item isn't shared with subsidiary 3 (an NS data problem, not a mapping bug); `getItemTracking` learns an item's record subtype from NS's own "different type" error and never caches the failure default (a transient miss would poison wrapper detection process-wide); lot quantities are **floored** to 2 dp (rounding up can exceed available).

## 16. Gotchas, footguns & known issues

Things that will bite you, in rough order of likelihood:

1. **Prod is silent.** `console.log/info/debug` are globally no-op'd when `ENVIRONMENT=prod`. If you're staring at pm2 logs in prod wondering why nothing prints — that's why. `warn`/`error` still print.
2. **Runtime Teams alerts are OFF by design.** `notifyService.sendAlert()` is a no-op. Waste alerts, poll failures, etc. reach only the console and the `statusStore` event ring. Deploy notifications come from GitHub Actions, not the app. To re-enable, restore the webhook POST in `notifyService.js`.
3. **New model column ⇒ new `ensureRuntimeSchema` block.** `sequelize.sync()` will not alter existing tables. Forgetting the DDL block means dev works (fresh table) and prod silently lacks the column.
4. **The deploy workflows don't write `SURGE_TANK_CRON`, `TICK_CRON`, or `INVENTORY_ADJUSTMENT_CRON`** into `.env` — deployed instances run the code defaults for those three. Fine today (defaults match intent), but changing a cadence via repo secrets alone won't work until the workflow `.env` blocks are updated.
5. **`SIM_START`/`SPEEDUP` in `.env` do nothing** after first boot; `TEAMS_WEBHOOK_URL` does nothing ever. See §6.
6. **HTTP serves before hydration finishes** (`app.listen` is outside the boot `.then()`); an early `GET /api/mes/dev/replay/status` 500s until `runtimeConfigService.load()` completes.
7. **Replay flip does not re-hydrate** in-memory batch state from the DB (only boot does), and `bulkMilkJob.reset()` is missing from `reconcileMode`'s reset list — after a flip its poll window is anchored to stale wall-clock time. Prefer `/reset` (which pm2-restarts) over a bare `/enable`/`/disable` when state matters.
8. **Atlas WO-state tags are dead.** `CurrentWOState`/`JobRunning`/`CurrentWO` are frozen across all blend tanks (one stuck "Running" ~26 days). Never gate anything on them; `NOTE_STRING` + line flow is the truth. Similarly `BT*_TANK_MODE` (enum 0–4) is historized but transitions are days apart — coarse context only.
9. **Equipment hysteresis constants are tick counts, not durations** — changing `EQUIPMENT_CRON` silently changes the real switch/idle times (comments in the file assume 5 s).
10. **The provider instance holds delta baselines** — swapping providers (or restarting) re-baselines every delta detector on its first tick; the null-prev separator edge intentionally *fires* so batches that completed during downtime are caught.
11. **Wrapper-casing on workOrderIssue is environment-inverted** (§15). If issues post "successfully" but consume nothing in NS, this is almost certainly it — check the self-healing retry logs.
12. **Model comments lag reality** in a few spots: `MesFgInputPairing` omits `rejected`; `MesSurgeTankBatch` omits `pairingStatus='blocked'` and several `componentResolvedFrom` values; `MesRuntimeConfig` says six crons (there are seven). Trust the services, not the model comments.
13. **A2 separation:** the SCADA HMI offers A2 in only 4 fat levels (indices 22–25). BOMs 426/427 exist in NS but are unreachable until SCADA gains A2 3.5 %/4 % indices.
14. **PLMS/filler OEE data (SD-649)** is on a segmented network — the Tetra Pak PLMS web UI at `10.5.1.13` is unreachable from the 10.4.x MES network except via the "Jumo Connected" jump host. `fillerHoursService` currently has real machine-level tags for **Filler 1 only**; fillers 2–6 return all-unknown.
15. **The BOM-editor RESTlet path is abandoned** (SD-636): NetSuite's blend addon blocks programmatic BOM edits. The `/api/mes/bom-admin` endpoints that remain go through the record API and honor `MES_DRY_RUN`; `POST /bulk/surge-twins` is dry-run unless `{commit:true}`.

## 17. HTTP API reference

Mounts from `server.js`. All bodies/queries JSON. No auth on this service (it's LAN-internal; the gateway holds NS auth).

### `GET /health`
Uptime, provider class name, last poll times (separation/bulkMilk/blendTank only).

### `/api/historian` — raw historian gateway (`routes/historianRoutes.js`)
Generic OData proxy so the frontend and ad-hoc scripts never re-implement NTLM/OData: `GET /search?q=`, `GET /tag/:fqn`, `GET /tags?fqn=&fqn=`, `GET /history/:fqn?since&until&resolution` (AnalogSummary with ProcessValues fallback + resample), `GET /analog-summary/:fqn`, `GET /state-summary/:fqn`, `GET /events`, `GET /batches?since`, `GET /tag-detail/:fqn`, `GET /tag-groups`, `GET /tag-properties`, `GET /system-params`, plus `GET /polled-history/:fqn` and `GET /poll-store/stats` (in-memory `pollStore` replay of live-polled values, 7-day/50k-point rings).

### `/api/mes/live-status` (`routes/liveStatusRoutes.js`)
`GET /` → `statusStore.snapshot()` — one JSON blob: separator, blend tanks + lines, bulk milk, silo activity, UHTs + surge tanks (incl. `activeFill`), fillers (Filler 1 inlet meter: `inletGpm`, `inletTotalizerGal`, `measured`, `running`, `sampleAt` — SD-708), tick cumulative state, receiving bays 1/2 (`receiving.bays[]`: truck number, product index, destination silos, lbs so far — silos also get an `activity` role `receiving`), packaging (`packaging.lines[digit]`: moving/movement/lastMovementAt, fillerFlow, filler1 lanes+modes, sterile, casePacker/palletizer counters, rates, raw state/reason; `packaging.legs` TR sterile flags), recent-batch rings. The frontend polls this. `GET /events?since&limit` → rolling 500-event ring.

### `/api/mes/facility` (`routes/facilityRoutes.js`) — facility map state
The single owner of what the SunApps facility map shows. `jobs/facilityStateJob.js` (cron `FACILITY_STATE_CRON`, default every 5 s) maps `statusStore.snapshot()` onto map SVG ids via `services/facilityAdapter.js` + `services/facilityJoins.js`, diffs by id against the previous tick (`services/facilityStateService.js`, the scheduler's change-set pattern), and pushes only the change-set through the Gateway (`POST /internal/broadcast/facility-state` → socket room `facility-map`, event `facility:updated`). `GET /state` → `{ entities, updatedAt, version, stale, assignments }` (waits for the first tick on a cold start); `GET /health`; `POST /refresh`; `GET|PUT /assignments` — admin-editable SVG-id → historian-id joins (surge circles ↔ ST81–84, blend circles ↔ BlendTank1A…/CocoaTank) persisted in `MesFacilitySettings` (`services/facilitySettingsService.js`), applied on the next tick. No polling from browsers: they hydrate once and apply change-sets; a version gap makes a client resync on its own.

**Packaging lines 1–6** come from the Production Scheduler, not the historian: `jobs/facilityLinesJob.js` (cron `FACILITY_LINES_CRON`, default every 15 s) reads the scheduler service's cached window through the Gateway (`GET /api/scheduler/state`, no SuiteQL of our own) and each line's pending consumption queue once a minute (`GET /api/staging/queue/:line`), cached in `services/facilityLinesSource.js`. Effective times mirror `schedulerCascadeService.computeEffectiveTimes` (keep in step; gantt strings are plant wall-clock, so this host runs in America/Boise like the scheduler service). `facilityAdapter.buildLines` decides the status: a WO with a logged start → running; a CIP/downtime/maintenance event covering now → cip/down/hold (events belong to the merged 3/4 and 5/6 rows); the WO planned for now backed by evidence (NetSuite In Process, product on the line's surge leg, Filler 1's meter) → running "no start logged"; planned with no evidence → changeover for 45 min, then idle "(late)"; next WO within 45 min → changeover; else idle naming the next WO. A full queue (5/5) is appended to the line's text. The status is painted on every drawn member of the line (Filler 1 keeps its metered status); the shared 5/6 palletizer follows the busier line. `line<n>` entities carry WO / item / qty / NS status / started / ends / next / queue metrics and link to `/production-scheduler`.

**Receiving** (Phase 4): `jobs/receivingJob.js` (cron `RECEIVING_CRON`, default every 10 s; replay key `receiving`) reads the two receiving bays' XFR transfer objects (`Ingr_Rec_RecBay{1,2}_IO.XFR.*` + `IntakeQty`, 8 tags per bay, `historian.getReceivingStatus()`) into `statusStore.receiving` — also merged into silo `activity` as role `receiving` for live-status. `XFR.Source` is the TRUCK NUMBER the operator keyed in, `XFR.ItemID` the Standardization product index (15 raw conventional, 16 raw organic), `Destination#.0/1` the silo(s). `jobs/facilityTrucksJob.js` (cron `FACILITY_TRUCKS_CRON`, default once a minute; replay key `facilityTrucks`) pulls `customrecord_milk_truck` for arrival ±2 days through the Gateway (`services/facilityTrucksSource.js`; status list 1 Pending QC, 2 Passed QC, 3 Diverted, 4 Received, 5 Failed QC, 6 Scheduled, 7 Checked in, 8 Pending External Results). `facilityAdapter.buildReceiving` lights the drawn path truck bridge (`recbridge`, level = load progress when the load weight is known) → bay hose (`recline{n}`, carries truck / product / pounds so far / destination) → receiving header → `recsiloline{silo}` and marks the silo. The two circles by the driver area (`rectank1/2`) are CIP chemical tanks and are never lit. `XFR.Source` is free text the operator typed (a truck number, "Tanker: T-3", a carrier code, or blank), so the NetSuite truck join is opportunistic (exact truck number, or the text ending in one); the receiving desk (`rec1`) and the Receiving Bay room summarise the queue (unloading, checked in, pending QC, passed, FAILED QC → hold, next scheduled). Links go to `/milk-trucks`.

**Packaging evidence** (Phase 3b, from the Sep 2026 tag audit): `jobs/packagingJob.js` (cron `PACKAGING_CRON`, default every 10 s; replay key `packaging`) reads the ~55 packaging tags that actually publish (`services/packagingTags.js`, `historian.getPackagingStatus()`): palletizer `Day_Counts` (pallets today, resets at midnight) + lifetime cases + utilization state/reason for lines 1/3/4/5, case-packer lifetime cases + state/reason + pack recipe, `CasePacker5_CaseCounts`, `Filler{3..6}.ProductFlowRate` (3/4 labelled l/h, 5/6 l/min — the 3/4 label is suspect, so flow is compared against a small per-unit threshold and shown raw), Filler 1's lane good-carton counters and RunMode/CIP/SIP flags, and the ThermaRoute sterile flags for fillers 1–5 and legs TR11–14. The JOB tracks movement (a counter that changed value within 5 min, Filler 1 lanes 3 min; first sighting never counts) and cases/min from a 6-min sample ring, into `statusStore.packaging`. Lines 5 and 6 share Pall5 and the CsPckr5 counters; movement goes to whichever filler has flow. The utilization state/reason codes are passed through raw (values seen 1,2,3,4,5,8,10 / 0,1,3,18) — the site's `util_state`/`util_reas` tables are not in the historian. In the adapter, movement is the strongest physical evidence for "running" (with the scheduler: planned WO + movement → running "no start logged"; movement with nothing scheduled → "Producing · nothing scheduled"; without the scheduler the historian decides alone), a running line whose counters stopped gets "⚠ no movement for N min", and the filler / case packer / palletizer shapes take their own colour from flow / their own counters. Line entities gain pallets today, cases today, cases/min, cartons/min, flow, sterile and pack metrics; the drawn legs carry a sterile metric.

**One colour per product chain.** NetSuite gives every stage its own work order (blend batch WO, surge batch WO, packaging WO), so the adapter unifies chains after building: every active element is tagged with the vessel or train it belongs to (`BlendTank1A`, `TSTAT1`, `UHT1`, `ST81`, `line1`), physically connected keys are linked (feed line → its destination vessel; balance tank ↔ its UHT; feeding blend tank ↔ UHT; UHT ↔ the surge tank it fills; surge tank ↔ the line whose leg it drains while that line runs), and `unifyChains` gives each connected chain ONE group — the packaging WO if a line is in the chain, else the surge WO, else the blend WO, else a stable `chain:<anchor>` key. Hubs (headers, manifolds, the outlet matrix) carry no group. Filler 1's inlet meter (FT1140 on leg TR11) counts as draw even when no tank has latched Sel 1 — the leg lights with "no tank selected" — and RunMode alone reads as "In production mode · no product yet", not running.

**Manual overrides** (`GET /overrides`, `PUT|DELETE /overrides/:id`, settings key `overrides`): a supervisor pins an element's status from the map's detail panel (SunApps control key `FACILITY_MAP_OVERRIDE`) with a note, who, and an expiry (0 = until cleared, max 7 days). Applied after the adapter on every tick; an override on `line<n>` covers the line and its members; expired ones are purged on the next tick. Entities carry `override: { of, status, note, by, setAt, until }` and `source: 'manual'`.

### `/api/mes/milk` (`routes/milkMesRoutes.js`)
Separation review: `GET /separation/batches?status=`, `GET /separation/product-indices`, `POST /separation/batches/:id/retry` (accepts corrected product indices), `POST /separation/batches/:id/reject`. Blend: `GET /blend-tank/active|batches|product-options`, `POST /blend-tank/batches/:id/retry|reject`, `GET /blend-tank/:id/components`, `POST /blend-tank/:id/issue-ingredient`, `POST /blend-tank/clear-stale`. Surge: `GET /surge-tank/batches|product-options`, `POST /surge-tank/batches/:id/retry` (accepts `nsItemId` override) `|reject`. Bulk milk: `POST /bulk-milk/register|complete`, `GET /bulk-milk/active`. (The `POST /separation/batch`, `/bulk-milk/flow`, `/blend-tank/wo-*` ingest endpoints are legacy — the in-process cron loop is what actually fires.)

### `/api/mes/fg-pairings` (`routes/fgPairingRoutes.js`)
`GET /?status=`, `POST /:id/approve`, `POST /:id/reject` (future surge batches with that combo are **held**), `POST /:id/fix` (reject wrong + approve corrected in one step).

### `/api/mes/analytics` (`routes/analyticsRoutes.js`)
Filtered/paged/sorted (whitelisted sort fields, limit cap 500): `GET /blend-batches`, `/surge-batches`, `/separation-batches`, `/inventory-adjustments` (supports `excludePositiveSilo`), each with a `/-trend` rollup; `GET /inventory-adjustments/correlations`; `GET /batches-with-adjustments` (holistic waste incl. exact-linked adjustments); `GET /batches/:kind/:id` (drilldown) and `GET /batches/:kind/:id/netsuite` (live SuiteQL source-of-truth pull); `POST /inventory-adjustments/:id/retry|reject`.

**Milk Loss executive report (SD-729):** `GET /loss-report?from&to&groupBy=day|week&compare=true` → `{ period, prior, headline, stages[], byEquipment[], byFamily[], byProduct[], topEvents[], trend[], unaccounted, insights[], pricing, units }` — the whole executive page in one call — every $ figure comes in both bases, cost (`wasteUsd*`) and revenue (`lostRevenueUsd*`); `chain[]` always lists the seven-step product path (separation → blend → UHT → surge → fillers → packaging → shipped vs produced) with `status` measured / combined (UHT is inside the surge measurement) / not-measured and a `howToMeasure` note, plus `shareOfMeasured*` for the loss-split donut. `ignoreUpperBounds=true` drops every upper-bound-only batch (input AND loss) so every figure is measured; `excluded` always says what that leaves out (also accepted by `/loss-history`, which uses `MesLossDaily.lbsInMeasured`) (defaults to the 7 whole plant days ending yesterday; bare `YYYY-MM-DD` dates are plant days, `to` inclusive; 400 on `to<=from` or > 400 days). `GET /loss-history?from&to&groupBy=day|week|month&by=stage|equipment|family` → frozen history from `MesLossDaily` (default last 26 weeks). `POST /loss-report/rollup?from&to` → recompute the history for a day range at current prices. `GET /loss-report/digest-preview` → the exact Teams card the weekly digest would post plus `wouldPost`. See §10 for the honesty rules the numbers follow.

### `/api/mes/dev/replay` (`routes/devRoutes.js`)
`GET /status`, `POST /enable|disable|config|pause|resume|reset` — see §14.

### `/api/mes/bom-admin` (`routes/bomAdminRoutes.js`)
`GET /groups` (dairy hierarchy derived from the MES maps — not an NS concept), `GET /search?q=`, `GET /item/:id`, `POST /preview`, `POST /commit` (overwrites the current BOM revision's components), `POST /bulk/surge-twins` (dry-run default).

### `/api/mes/filler-hours` (`routes/fillerHoursRoutes.js`)
`GET /?filler=1&since=&until=` — time-in-state history for Machine Efficiency (SD-655). Filler 1 only has real tags today.

### `/api/mes/filler-flow` (`routes/fillerFlowRoutes.js`)
`GET /?since=&until=&resolution=` — windowed Filler 1 inlet flow analytics (SD-708): totalizer delta with reset detection, volume split by machine state (the meter counts flush/CIP too — use `volume.byState.runtime` or `runs[]` for production volume), per-run volumes, and trend points with explicit `measured:false` gaps. Window-based only — no shift/timezone logic; anchor `since` to a shift boundary for aligned buckets. 501 under the mock provider.

### `/api/milk` (`routes/milkRoutes.js`)
Legacy passthroughs to `services/milkService.js` (direct unbuild/bulk-WO helpers, incl. a RESTlet fallback). Kept for admin use.

## 18. Project structure

```
server.js                  Express app, cron scheduler + guards, provider hot-swap, boot/hydration
config/index.js            All env config, Sequelize instance, beforeDefine table-prefix hook
historian/
  index.js                 Provider factory
  providers/
    baseProvider.js        The 14-method interface (JSDoc = the contract)
    restProvider.js        Live AVEVA OData/NTLM — all the tag quirks live here
    historicalProvider.js  Replay: RestProvider with sim-time "now" + cache/semaphore
    mockProvider.js        Offline dev data
    uhtStepNames.js        ThermaStat PROCESS/CIP step-name tables (24 = Sterile on Product)
jobs/                      One file per cron job (thin; state machines live in services)
services/                  The core (~24 files, ~11.5k LOC) — see §9–§11
  blendTankMesService.js       Blend batch lifecycle, issues/completions, backfill, tail-catcher
  surgeTankMesService.js       Surge lifecycle, layer-3 pinning, single-claimant, filler drain
  separatorStateMachine.js     Separation open/close state machine
  milkMesService.js            Separation → unbuild, bulk-milk legacy, retry/reject
  issue path: nsInventoryLookup.js (tracking/bins/lots/wrapper shapes)
  waste/adjust: inventoryAdjustmentService.js, tankAtRestSweepService.js,
                adjustmentCorrelationService.js, costRevaluationService.js
  parsers/maps: blendTankProductParser.js, surgeTankProductParser.js,
                lineIngredientMapper.js, mesItemConfig.js (ALL static NS maps)
  batchStartFinder.js          Back-projects real batch starts from historian history
  statusStore.js               In-memory live state + event ring (also a control input)
  analyticsService.js          Filtered queries + trends
  bomAdminService.js, fgPairingService.js, fillerHoursService.js
  runtimeConfigService.js      Replay-config cache + listener bus
  pollStore.js                 In-memory tag time-series from live polls
  notifyService.js             Deliberate no-op (Teams off)
models/                    One Sequelize model per table + index.js (loader, ensureRuntimeSchema, seeds)
routes/ + controllers/     HTTP layer (§17)
clients/coreClient.js      Core API gateway wrapper (all NS traffic)
sim/clock.js               Simulated clock for replay
scripts/                   ~110 operational one-offs (§19) + all-tags.json
docs/                      historian-api.md, PROJECT_OVERVIEW.md
.github/workflows/         dev deploy, prod deploy, auto-tagging
```

## 19. The scripts directory

~110 standalone `node scripts/<x>.js` tools (most load `.env` themselves). Categories:

- **`probe*`** (~45, largest group) — read-only historian/NS experiments that established the facts in this README (e.g. `probeRawVsProcessValues.js` found the DST lag; `probeFillerFlowIntegration.js` established the Sel↔filler map and l/min units). Probes are kept as the *evidence record* — check for one before re-deriving any tag behavior.
- **`diag*` / `check*` / `inspect*` / `monitor*`** (~18) — live diagnostics (`diagHealthSurvey.js`, `dumpWoErrors.js`, `monitorWOState.js`).
- **Recovery / backfill / cleanup** (~14) — incident tooling: `recoverBlendTank2AFill.js`, `retryFailedUnbuilds.js`, `cleanupPhantomTankBatches.js`, `fixSurgeIssueBaselines.js`, `fixCircularBom.js`; twin-item rollout: `createBatchTwin.js`, `attachBatchBom.js`, `rolloutBatchTwins.js`, `enableBinTrackingOnTwins.js`.
- **Verification / audit** (~10) — `verifyNsReferences.js` (validates every hardcoded NS id against the live account — run after any NS data change), `verifyAdjustmentCorrelations.js`, `auditWipAccount.js`, `dryRunSweepTick.js` (forces dry-run, then runs one sweep tick).
- **Catalog dumps** — `discoverTags.js` → `scripts/all-tags.json`; `exportNsItemSpec.js` → `ns-item-spec.json`.
- **Milk Loss report (SD-729)** — `probeLossReport.js <fromDay> <toDayExcl> [--json]` runs the report against whichever table set `ENVIRONMENT` selects (read-only, no sync) **and** an independent T-SQL cross-check, exiting non-zero on any mismatch — the way to see prod-shaped numbers without the app; `backfillLossDaily.js --from YYYY-MM-DD [--to] [--confirm]` re-computes `MesLossDaily` for a range at current prices (dry-run by default).

Rule of thumb: anything that *writes* to NS has a `dryRun`/`commit` split or forces `MES_DRY_RUN` — keep that convention.

## 20. Deployment & versioning

GitHub Actions → self-hosted Windows runners → `C:\Apps\SunApps_MES` → pm2 (`sunapps_mes`).

- **`development_deploy.yml`** — push to `development` → dev server: write `.env` from repo secrets (UTF-8 no BOM), copy, `npm ci`, `pm2 restart`.
- **`production_deploy.yml`** — on a **published release** (or manual dispatch with a tag): checkout the tag, same `.env`/copy/`npm ci`/restart, then posts a release-notes Adaptive Card to Teams (`TEAMS_SOFTWARE_DEPLOYMENT_HOOK` repo variable).
- **`tag_production.yml`** — push to `master`: reads `package.json` version, fails if tag `v<version>` exists, else creates and pushes it. Publishing the GitHub release for that tag is what triggers the prod deploy.

**Versioning convention (follow this exactly):** before every push of a feature branch, fetch remote `master` and set the branch's `package.json` version to **exactly master's patch + 1**. Do not re-bump an unmerged branch on later pushes. The tag workflow's "fail if tag exists" check is what enforces this at merge time.

Known gap: both deploy workflows omit `SURGE_TANK_CRON`/`TICK_CRON`/`INVENTORY_ADJUSTMENT_CRON` from the `.env` they write (code defaults apply). `DEPLOY_CHECKLIST.md` records the first-prod-deploy bootstrap (historical, but the workflow-mechanics section is still accurate).

## 21. Documentation index

| Doc | What it is | Currency |
|---|---|---|
| `README.md` | This file — the map | Current as of 2026-08 (branch SD-636) |
| `docs/PROJECT_OVERVIEW.md` | Non-technical business narrative (why this exists) | Current, intentionally timeless |
| `docs/historian-api.md` | AVEVA OData v2 API reference (base URL, entity sets, paging) | Accurate but predates the DST-lag / Raw-vs-ProcessValues / AnalogSummary findings — those live in `restProvider.js` comments and this README |
| `overview.md` | Older deep-dive of the architecture | Superseded by this README (says six cron jobs; there are seven; predates analytics/bom-admin/filler-hours) |
| `BATCH_LIFECYCLE_PLAN.md` | Unified batch-state-machine design | Separator half shipped (`separatorStateMachine.js`); blend/surge halves not implemented |
| `SURGE_TANK_PLAN.md` | SD-597 surge-flow plan incl. "decisions already made" | Implemented; its file:line references are stale |
| `PICKUP.md` | SD-577 session hand-off (unbuild/static-BOM finding) | Historical record only |
| `DEPLOY_CHECKLIST.md` | First prod deploy checklist (SD-597) | Historical; workflow mechanics still accurate |

## 22. Glossary

| Term | Meaning |
|---|---|
| **Batch** | One contiguous production run at one stage (a separation transfer, a blend-tank fill under one product name, a surge-tank fill). One DB row; usually one NS work order. |
| **WO / issue / completion** | NetSuite work order; `workOrderIssue` = ingredient consumption posted against it; `workOrderCompletion` = built output posted from it. This service emits many small incremental issues/completions per batch. |
| **Unbuild** | NS `assemblyUnbuild` — reverses an assembly into components; how separation (raw → cream + skim) is booked. |
| **Totalizer** | A cumulative flow odometer tag. Separator/line totalizers never reset (baseline math); milk-line totalizers reset between runs (reset = tail-catcher trigger); the UHT "totalizer" is software-integrated GPM. The Filler 1 inlet totalizer (`TR11_FT1140`, SD-708) is a hardware odometer that is *resettable but not configured to reset* — consumers must use reset-tolerant baseline math. |
| **Cursor / baseline** | The per-(batch, line/UHT) `lastIssued*` value in `MesPipeIssueStates`/`MesSurgeTankIssueStates`; the delta since it is what gets issued next tick. Advances only on NS confirmation. |
| **Arrival / output** | Measured mass reaching the destination vessel (`cumulativeOutputLbs`); drives completions. `issued − output = waste`. |
| **Sweep** | The 5-min at-rest reconciliation driving each idle tank's NS bin to its observed physical contents. |
| **Shortfall** | An automatic up-adjustment fired so a rejected issue/unbuild can retry. |
| **Tail-catcher** | The line-reset path that captures the final flow delta the 5-min tick hadn't issued yet. |
| **Pinned component** | The single Layer-3 input item resolved once at surge WO creation and used for every subsequent issue. |
| **FG pairing** | The `(finished good, raw input)` whitelist row gating surge WOs; new combos need ops approval. |
| **Twin item** | The lot-tracked "(Batch)" counterpart of a non-lot standardization milk item, used as the blend WO assembly. |
| **Sentinel** | A product-name value (`CIP`, `Water`, `Sterile`, `-`, …) that must never be treated as a product. |
| **`pending_ns`** | Batch status meaning "the physics resolved but an NS mapping didn't" — an ops/catalog fix + retry, not a code bug. |
| **Sel line** | A surge-tank→filler routing latch (`ST8x_Sel{N}_Filling_Indicator`); one Sel line = a paired-filler leg. |
| **XFR** | The separator's transfer program/tags (`Ingr_Sep_CMSep1_IO.XFR.*`). |
| **Layer 1/2/3** | Raw/separated → blend-tank raw FG → surge-tank finished good (§2). |
