# SunApps_MES — Production Deployment Checklist

Deploying `SD-597` to production. This is the **first** prod deploy (no git tags exist yet),
so it includes one-time bootstrap steps that won't apply to future releases.

**Deploy path:** merge to `master` → `tag_production.yml` auto-tags `v<package.json version>` →
publish a GitHub **Release** on that tag → `production_deploy.yml` runs on the `[self-hosted, prod-server]`
runner (env `prod`): writes `.env` from secrets → copies to `C:\Apps\SunApps_MES` → `npm ci` →
`pm2 restart sunapps_mes` → Teams notification.

---

## 0. The one decision that matters most: dry run vs. live NetSuite

`MES_DRY_RUN` (a `prod` environment secret) gates **every** NetSuite write — WO creates, issues,
completions, assembly unbuilds, inventory adjustments, cost revaluations. `MES_DRY_RUN=true` still
advances all DB/accounting state and logs the exact payloads, but posts nothing to NS.

- [ ] **Decide:** first prod deploy with `MES_DRY_RUN=true` to watch the logged payloads against the
      live historian for a shift, *then* flip to `false`? Or go live immediately?
- [ ] Confirm the `MES_DRY_RUN` value in the `prod` GitHub Environment is what you intend.
- [ ] Confirm **which NetSuite account** `CORE_API_URL` (the SunApps gateway) proxies to — production
      vs sandbox. If `MES_DRY_RUN=false` and the gateway points at NS production, real transactions post.

---

## 1. Code & branch readiness

- [ ] `SD-597` PR reviewed and approved; CI/tests green.
- [ ] Working tree clean; no debug-only changes (e.g. test cron overrides, `BLEND_TANK_OVERRIDES`,
      `SURGE_TANK_OVERRIDES`, forced `MES_DRY_RUN`) left in committed code.
- [ ] `package.json` version is correct. It's `0.0.1` and **no tags exist yet**, so `v0.0.1` will be
      created cleanly. (Going forward: every merge to master MUST bump the version or `tag_production`
      fails on "tag already exists.")
- [ ] Decide whether `MES_PARSER_STRICT_MODE` should be on. It's not written by the deploy workflow, so
      it falls back to the config default (`false` = fuzzy parsing still active). Leave default unless
      AVEVA standardized select-tag values are live.

## 2. GitHub Environment `prod` — secrets & protection

The workflow builds `.env` from these secrets. Verify each exists in the **`prod`** environment:

- [ ] `PORT`, `CORE_API_URL`
- [ ] `HISTORIAN_PROVIDER` — **must be `rest`** in prod (not `mock`/`historical`, or no live polling)
- [ ] `HISTORIAN_BASE_URL`, `HISTORIAN_DOMAIN`, `HISTORIAN_USERNAME`, `HISTORIAN_PASSWORD`
- [ ] `SEPARATION_CRON`, `BULK_MILK_CRON`, `BLEND_TANK_CRON`, `EQUIPMENT_CRON`
- [ ] `SQL_USER`, `SQL_PASSWORD`, `SQL_DATABASE`, `SQL_SERVER`
- [ ] `TEAMS_WEBHOOK_URL`, and the `TEAMS_SOFTWARE_DEPLOYMENT_HOOK` **variable** (vars, not secrets)
- [ ] `MES_DRY_RUN` (see §0)
- [ ] **Gap to confirm:** `SURGE_TANK_CRON`, `TICK_CRON`, `INVENTORY_ADJUSTMENT_CRON`, `MES_MIN_ISSUE_LBS`,
      `MES_MIN_COMPLETION_LBS`, and the waste floors are **not** written by the deploy workflow — they fall
      back to `config/index.js` defaults (tick/adjust = `*/5 * * * *`, surge = `*/10s`). Confirm those
      defaults are your intended prod cadence; if not, add them to the workflow's `.env` block + secrets.
- [ ] Required-reviewers / protection rules on the `prod` environment are set as you want them.

## 3. Prod server (self-hosted runner) prerequisites

- [ ] GitHub Actions runner labeled `self-hosted` + `prod-server` is **online** and registered to this repo.
- [ ] Node.js 22, `npm`, `git`, and **PM2 (global)** installed on the prod server.
- [ ] **FIRST-DEPLOY GOTCHA:** the workflow only runs `pm2 restart sunapps_mes`, which **fails if the
      process doesn't exist yet.** Before the first deploy (or as a one-time manual step on the server):
      ```powershell
      cd C:\Apps\SunApps_MES
      pm2 start server.js --name sunapps_mes
      pm2 save
      pm2 startup   # so it survives a server reboot
      ```
      After this exists once, future deploys' `pm2 restart` works.
- [ ] `C:\Apps\SunApps_MES` is writable by the runner service account.

## 4. Database (SQL Server / mssql) — shared DB, env-prefixed tables

Dev and prod point at the **same** physical database. Isolation is by **table-name prefix** driven by
the `ENVIRONMENT` var: prod tables are `prod_Mes*`, dev tables are `dev_Mes*` (applied automatically via
a `beforeDefine` hook in `config/index.js`). `ENVIRONMENT` is hardcoded in each deploy workflow
(`production_deploy.yml` → `prod`, `development_deploy.yml` → `dev`), so the prefix is correct per
environment with no extra secret needed.

- [ ] DB (`SQL_DATABASE` on `SQL_SERVER`) is reachable from the prod server.
- [ ] `SQL_USER` has **DDL rights** — boot runs `sequelize.sync()` (creates the `prod_Mes*` tables) and
      `ensureRuntimeSchema()` (idempotent `ALTER TABLE` / `CREATE INDEX`, all prefix-aware). Without
      create/alter perms, startup fails.
- [ ] First prod boot creates a **fresh, empty** `prod_Mes*` table set — cleanly separated from any
      existing dev data. Verify the `prod_*` tables appear and the unprefixed/dev tables are untouched.
- [ ] `prod_MesRuntimeConfig` seeds with `replayMode=0` (provider is `rest`), so prod won't boot into
      historical replay. `prod_MesFgInputPairings` seeds from `RAW_FG_TO_FG_MAP`.
- [ ] **Note on the dev side:** once this change deploys to dev, the dev server switches to `dev_Mes*`
      tables (fresh/empty) and abandons the old unprefixed `Mes*` tables. If you need to preserve current
      dev data, `sp_rename` the existing tables + their `DF_*` constraints to the `dev_` names before
      deploying; otherwise just drop the orphaned unprefixed tables later.
- [ ] (Optional) DB backup/snapshot taken before deploy.

## 5. Upstream dependencies

- [ ] **SunApps gateway** (`CORE_API_URL`) is up and reachable from the prod server, pointed at the
      intended NS account (see §0).
- [ ] **AVEVA Historian** reachable from the prod server over NTLM with the prod creds.
- [ ] NetSuite catalog prerequisites for live posting are in place (else batches land in `pending_ns`,
      not `error`): items shared with subsidiary 3, batch-twin items for type-2 milks, cost basis /
      revaluation done for standard-cost items, correct bins (49xx-range, not stale low bins).

## 6. Deploy execution

- [ ] Merge `SD-597` → `master` (via approved PR).
- [ ] Confirm `tag_production.yml` ran and created tag `v0.0.1`.
- [ ] Create & **publish a GitHub Release** on `v0.0.1` (with release notes) — this is what triggers
      `production_deploy.yml`. (Alternatively: `workflow_dispatch` with the tag input.)
- [ ] Watch the Actions run: `.env` created → files copied → `npm ci` clean → `pm2 restart` succeeded.
- [ ] Confirm the Teams "Update!" success card posted.

## 7. Post-deploy verification (on the prod server)

- [ ] `pm2 status` shows `sunapps_mes` **online** (not errored/restarting).
- [ ] `pm2 logs sunapps_mes` shows startup banner:
      - `Base historian provider (replay-off): rest`
      - `Dry run: <your intended value>`
      - `Sequelize models synced.` and `Cron schedule applied: {...}`
- [ ] Hit `GET http://<host>:<PORT>/health`:
      - `historianProvider` = `RestProvider` (NOT `MockProvider` / `HistoricalProvider`)
      - `lastSeparationPoll` / `lastBulkMilkPoll` / `lastBlendTankPoll` are recent and **advancing**.
- [ ] Watch one full tick cycle in logs: no historian-poll failures, no unhandled errors, cron ticks
      not stacking ("Skipping … previous still in flight" should be rare).
- [ ] If live (`MES_DRY_RUN=false`): confirm the first real NS transactions look correct (a WO create /
      issue / completion) and spot-check in NetSuite. Query `WHERE status='pending_ns'` for anything
      that resolved physics but failed NS catalog resolution.
- [ ] If dry run: confirm logged payloads (`DRY_RUN body: …`) look correct before scheduling the flip.

## 8. Rollback plan

- [ ] **No previous tag exists** (first deploy), so there's nothing to re-deploy to. Rollback = stop
      forward: `pm2 stop sunapps_mes` to halt all NS posting, then fix forward.
- [ ] For future deploys: rollback = re-run `production_deploy.yml` via `workflow_dispatch` with the
      previous tag, then `pm2 restart`.
- [ ] Fastest "stop the bleeding" lever if NS data looks wrong: flip `MES_DRY_RUN=true` (secret) and
      redeploy, or `pm2 stop sunapps_mes`.

---

### Highest-risk items for *this* deploy
1. **`MES_DRY_RUN` + gateway NS target** — the difference between logging and writing real production NS data (§0).
2. **First-deploy PM2** — `pm2 restart` fails with no existing process; do the one-time `pm2 start` first (§3).
3. **Unmapped cron/threshold secrets** silently fall back to config defaults (§2).
4. **DB DDL perms** — boot creates/alters tables; insufficient rights = failed startup (§4).

---

### SD-717: seed the cost constants (once per environment)

The costs table (`{env}_MesCostConfigs`) auto-creates on boot but ships EMPTY —
$ figures across SunApps/Portal stay hidden until seeded. After deploying, POST
the genesis row (append-only; later price changes go through the SunApps Cost
Settings page or another POST):

```bash
curl -X POST http://<host>:4005/api/mes/config/costs \
  -H 'Content-Type: application/json' \
  -d '{"milkCostPerLb": 0.34, "fgCasePrice": 10.35, "note": "initial seed — ops-provided Aug 2026"}'
```

- [ ] Seed dev after the dev deploy; verify `GET /api/mes/config/costs` returns the values.
- [ ] Seed prod after the prod release.
- [ ] SunApps side: create the `MES_COST_ADMIN` control key in the admin ControlKeys UI
      and grant it to the right group — the Cost Settings page is route-denied until then.

### SD-717: per-family raw milk prices (mostly automatic)

The daily price-sync job (boot + `PRICE_SYNC_CRON`, default 5:10 AM) derives
$/lb per family (organic / conventional / cream_organic / cream_conventional)
from NetSuite VendBill/ItemRcpt lines over a trailing 30 days and appends rows
to `{env}_MesRawMilkPrices` — **no seeding needed for those families**. Two
manual items remain:

- [ ] **A2 has no priced purchase transactions in NS** — seed it manually per
      environment (also doable from the SunApps Cost Settings page):

```bash
curl -X POST http://<host>:4005/api/mes/config/costs/raw-milk \
  -H 'Content-Type: application/json' \
  -d '{"family": "a2", "pricePerLb": 0.39, "note": "manual — no priced A2 purchase lines in NS"}'
```

- [ ] Verify after boot: `GET /api/mes/config/costs` shows a `families` object
      with `source: "ns"` rows (organic ≈ 0.39, conventional ≈ 0.18 as of Aug 2026),
      and the event stream shows `priceSync.updated`. A `priceSync.error` event
      means the gateway/SuiteQL path failed — prices stay stale, nothing breaks.
- [ ] Optional: `PRICE_SYNC_CRON` secret per environment (unmapped = the 5:10 AM
      code default, which is fine).

### SD-717: FG revenue rates (automatic)

The same daily sync also derives **revenue-per-lb per bulk FG item** (what a
pound would have earned as invoiced finished goods): packaging WorkOrd lines
give the SKU mix + lb-per-case, CustInvc lines give $/case, over a trailing
`FG_REVENUE_WINDOW_DAYS` (default 90). Rows land in `{env}_MesFgRevenueRates`;
no seeding needed. An item only derives when the window holds ≥1 packaging WO
AND ≥1 invoice for a resulting SKU — patch gaps manually:

```bash
curl -X POST http://<host>:4005/api/mes/config/costs/fg-revenue \
  -H 'Content-Type: application/json' \
  -d '{"fgItemId": "6420", "revenuePerLb": 0.86, "note": "manual — no packaging WO in window"}'
```

- [ ] Verify after boot: `GET /api/mes/config/costs` shows `fgRevenue` rows
      (`source: "ns"`) and the event stream shows `fgRevenue.updated`.
      `fgRevenue.error` = the derive query failed; rates stay stale, nothing breaks.
- [ ] Dev note: the sandbox's transaction data lags refreshes — widen
      `FG_REVENUE_WINDOW_DAYS` (and `PRICE_SYNC_WINDOW_DAYS`) on dev if nothing derives.
