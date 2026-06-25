# SunApps MES Service

A Manufacturing Execution System (MES) service that bridges the plant floor and the ERP for Ida Milk's liquid‑milk processing operation. It continuously reads real‑time process data from the **AVEVA Historian** (plant SCADA), reconstructs what physically happened at each production stage, and posts the corresponding inventory and cost transactions into **NetSuite** — automatically, with no operator data entry.

> **In one sentence:** the plant's tanks, separators, and fillers move millions of pounds of milk a week; until now none of that in‑plant movement was tracked in NetSuite, and this service watches it through the historian and keeps NetSuite's inventory, work orders, and costing in lock‑step with the physical reality.

---

## What it does

The plant's production flow is a chain of stages:

```
Bulk intake → Raw silos → Separator → Silos → Blend tanks → UHT → Surge tanks → Fillers
```

The service polls the historian on a set of cron schedules, detects the start and end of a **batch** at each stage, measures the volumes involved (using tank levels, totalizers, and flow meters), and emits the matching NetSuite transactions:

| Plant event | NetSuite action |
|-------------|-----------------|
| Raw milk separated into cream + skim | Assembly unbuild (source → cream + skim items) |
| Bulk milk truck unloaded | Inventory receipt |
| Blend tank filled & named | Work order create + work order issues + completions |
| Surge tank filled from UHT | Work order create + issues + completions (finished goods) |
| Milk measured arriving vs. issued | Waste / shrinkage inventory adjustments |
| Tanks at rest drifting on sensor noise | De‑noised inventory reconciliation sweeps |

Everything is keyed to lot numbers and bins, so the result is a fully traceable, costed picture of in‑plant production in the ERP — production movement that previously was **not recorded in NetSuite at all.**

---

## Architecture

```
                ┌──────────────────────────┐
                │     AVEVA Historian       │   23,000+ SCADA tags
                │   (REST / OData v2 API)   │
                └────────────┬──────────────┘
                             │  poll (NTLM)
                ┌────────────▼──────────────┐
                │   Historian provider      │   mock | rest (live) | historical (replay)
                └────────────┬──────────────┘
                             │
   ┌─────────────────────────▼─────────────────────────┐
   │                  Cron jobs (node-cron)             │
   │  separation · bulkMilk · blendTank · surgeTank ·   │
   │  equipment · tick (issue/complete) · invAdjust     │
   └─────────────────────────┬─────────────────────────┘
                             │
   ┌─────────────────────────▼─────────────────────────┐
   │     Services (state machines + business logic)     │
   │  separator state machine · blend/surge MES ·       │
   │  product parsers · cost revaluation · waste &      │
   │  at‑rest sweeps · FG pairing · analytics           │
   └──────────┬───────────────────────────┬────────────┘
              │                           │
   ┌──────────▼─────────┐      ┌──────────▼────────────┐
   │  SQL Server (MSSQL)│      │   Core API → NetSuite  │
   │  Sequelize models  │      │  (work orders, issues, │
   │  batch + tick state│      │  unbuilds, adjustments)│
   └────────────────────┘      └────────────────────────┘
```

**Key design points**

- **Provider abstraction** — the historian is accessed through a swappable provider. `rest` reads the live plant; `historical` replays a past time window through a simulated clock (`sim/clock.js`) for testing and back‑fill; `mock` runs with no plant connection.
- **Hot‑swappable runtime config** — replay mode, sim start, speed‑up, and cron cadence can be toggled at runtime via the dev API without a restart (`reconcileMode`).
- **Concurrency‑guarded ticks** — each cron job is guarded so a slow poll can never stack overlapping ticks.
- **Environment‑isolated tables** — dev, prod, and local share one physical database; every table is prefixed (`prod_…`, `dev_…`) so datasets never commingle.
- **Self‑healing schema** — `ensureRuntimeSchema()` adds new columns/indexes idempotently on every boot, so models can evolve without manual migrations.
- **Stateful & restart‑safe** — batch and tick state is hydrated from the database on boot, so a restart mid‑production resumes cleanly.

---

## Tech stack

- **Runtime:** Node.js 22
- **Web:** Express 5
- **Scheduling:** node-cron
- **ORM / DB:** Sequelize 6 → Microsoft SQL Server (`tedious`)
- **Historian access:** AVEVA Historian REST API v2 (OData) over NTLM (`httpntlm`)
- **ERP integration:** NetSuite via an internal Core API
- **Process manager:** PM2
- **CI/CD:** GitHub Actions → self‑hosted Windows runners

---

## Getting started

### Prerequisites

- Node.js 22+
- Access to a SQL Server instance
- Network access to the AVEVA Historian and the Core API (or run with `HISTORIAN_PROVIDER=mock`)

### Install & run

```bash
npm ci
npm run start      # production
npm run dev        # watch mode
```

The service listens on `PORT` (default `4005`). Health check:

```bash
curl http://localhost:4005/health
```

### Configuration

Configuration is read from a `.env` file (see `config/index.js`). Key variables:

| Variable | Purpose |
|----------|---------|
| `ENVIRONMENT` | `dev` \| `prod` \| `local` — drives table prefixing |
| `PORT` | HTTP port (default 4005) |
| `CORE_API_URL` | Base URL of the Core API (→ NetSuite) |
| `HISTORIAN_PROVIDER` | `mock` \| `rest` \| `historical` |
| `HISTORIAN_BASE_URL` / `_DOMAIN` / `_USERNAME` / `_PASSWORD` | AVEVA Historian connection (NTLM) |
| `SQL_SERVER` / `_DATABASE` / `_USER` / `_PASSWORD` | SQL Server connection |
| `MES_DRY_RUN` | When `true`, computes everything but does **not** post to NetSuite |
| `*_CRON` | Per‑job cron cadence (separation, bulk milk, blend, surge, equipment, tick, inventory adjustment) |
| `TEAMS_WEBHOOK_URL` | Microsoft Teams alerting webhook |
| `SIM_START` / `SPEEDUP` | Historical‑replay clock start and time multiplier |

> **Safety default:** `ENVIRONMENT` defaults to `dev` so an unconfigured instance can never write into the production dataset, and `MES_DRY_RUN` lets you validate behavior with zero ERP side effects.

---

## Project structure

```
server.js                 Express app, cron scheduler, provider hot-swap, boot/hydration
config/                   Env config, Sequelize setup, environment table prefixing
historian/                Provider factory + mock / rest (live) / historical (replay) providers
jobs/                     Cron entry points per production stage
services/                 State machines + business logic (the core of the system)
models/                   Sequelize models (batches, tick state, adjustments, runtime config)
routes/ + controllers/    REST API (status, analytics, dev/replay control)
clients/                  Core API / NetSuite client
sim/                      Simulated clock for historical replay
scripts/                  Operational & diagnostic one-off scripts
docs/                     Historian API reference + project overview
```

### Cron jobs

| Job | Default cadence | Responsibility |
|-----|-----------------|----------------|
| `separationJob` | 10 s | Drives the separator state machine → cream/skim unbuilds |
| `bulkMilkJob` | 1 min | Detects bulk milk truck intakes |
| `blendTankJob` | 10 s | Detects blend‑tank batches (start/fill/name) |
| `surgeTankJob` | 10 s | Detects surge‑tank (finished goods) batches |
| `equipmentJob` | 5 s | Polls equipment state, integrates the UHT software totalizer |
| `issueCompletionJob` (tick) | 5 min | Emits periodic work‑order issues + completions |
| `inventoryAdjustmentJob` | 5 min | At‑rest tank reconciliation + waste sweeps |

---

## API

All routes are mounted under `/api`:

| Mount | Purpose |
|-------|---------|
| `GET /health` | Liveness + last‑poll timestamps per job |
| `/api/historian/*` | Raw historian queries (tags, values, summaries) |
| `/api/mes/milk/*` | Milk MES operations |
| `/api/mes/live-status/*` | Live plant / batch status |
| `/api/mes/fg-pairings/*` | Finished‑goods → raw‑input pairing approvals |
| `/api/mes/analytics/*` | Batch history, trends, inventory‑adjustment correlations |
| `/api/mes/dev/replay/*` | Runtime config: toggle replay, set sim clock, change cron cadence |
| `/api/milk/*` | Legacy milk endpoints |

---

## Deployment

Deployment is automated through GitHub Actions to self‑hosted Windows runners:

- **`development_deploy.yml`** — deploys to the dev server.
- **`production_deploy.yml`** — triggered on a published release; checks out the tag, writes `.env` from repository secrets, copies to `C:\Apps\SunApps_MES`, runs `npm ci`, and restarts the PM2 process. Posts a release‑notes card to Teams on success.
- **`tag_production.yml`** — production tagging workflow.

Versioning follows a master‑patch convention: a feature branch's `package.json` is set to exactly the master patch + 1 before the first push.

---

## Documentation

- [`docs/historian-api.md`](docs/historian-api.md) — AVEVA Historian REST API reference and the plant tag map.
- [`docs/PROJECT_OVERVIEW.md`](docs/PROJECT_OVERVIEW.md) — non‑technical overview of what this system does for the business and why it matters.
