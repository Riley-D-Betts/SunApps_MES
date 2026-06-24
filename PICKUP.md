# Pick up where we left off — SD-577

_Last touched: 2026-05-11_

## TL;DR

Milk separation assemblyUnbuild flow is fixed and verified end-to-end across all 10 BOM combos in sandbox. The RESTlet path is dormant. Forward path goes straight to NS REST.

## Current branch state

All three repos are on `SD-577` and `development` is in sync.

| Repo | Branch tip |
|---|---|
| SunApps_MES | `SD-577` == `development` (both at the `productIndex 6 → 5401` fix) |
| SuiteScripts | `SD-577` (RESTlet at `MES/sa_milk_unbuild_rl.js`, no longer in flow) |
| SunApps_NetSuite | `SD-577` == `development` (restlet routing fix merged) |

## What was actually broken

NS items `5417` (Raw Conventional Milk) and `5404` (Raw Organic Milk) have default BOMs. On any assemblyUnbuild via REST, NS auto-applies the default BOM and locks the component sublist. That's why our `componentInventoryDetail` calls were failing with "static sublist" / "Please configure inventory detail".

## What actually works (the keeper)

Hit `/record/v1/assemblyUnbuild` with **all three** at once:

1. **Correct BOM** — `getSeparationBomId(sourceItemId, skimProductIndex)`
2. **Component items that match the BOM's actual items** — cream is `5483` (organic) or `5480` (conv); skim is `getItemByProductIndex(skimProductIndex)`
3. **Bin-only inventory detail** — items are bin-tracked but not lot-tracked, so `componentInventoryDetail.inventoryAssignment.items[].binnumber.id` is required, `receiptInventoryNumber` is forbidden. Source assembly item needs the same on `body.inventoryDetail`.

If item IDs match BOM lines, NS *updates* existing lines with our exact quantities instead of trying to add new ones. That's the magic.

Reference payload: see NS unbuild `4379306` (Conv 1%) or `4379497` (Org 3.5%).

## Key files

- `services/milkMesService.js` — forward path used by live MES flow
- `scripts/retryFailedUnbuilds.js` — retries `status: 'error'` rows (`--confirm`, `--limit=N`, `--newest-first`)
- `scripts/testBomCombos.js` — fires one tiny test unbuild for each of the 10 BOM combos
- `services/mesItemConfig.js` — `SEPARATION_BOM_MAP` + `PRODUCT_INDEX_ITEM_MAP` (watch this one — see "Real bug" below)

## Real bug found during verification

`PRODUCT_INDEX_ITEM_MAP[6]` was `5481` (Cartridge Filter Fine 20 Micron). Should be `5401` (Raw Organic 3.5%). Fixed. Without this, any Organic → 3.5% separation would have errored in prod the same way the test did.

If new fat-level products get added, sanity-check the map against `SELECT brc.item FROM bomrevisioncomponent brc JOIN bomrevision br ON brc.bomrevision = br.id WHERE br.billofmaterials = <bom_id>`.

## What's outstanding

- **14 legacy batches** marked `status: 'abandoned'` (sandbox only, written off — pre-dated the `productIndex`-aware destinations format)
- **RESTlet** (`SuiteScripts/MES/sa_milk_unbuild_rl.js`, NS script `customscript_sa_milk_unbuild_rl` / deploy `customdeploy1`) is deployed in sandbox but unused. Leave alone; could be useful if a future scenario needs dynamic-mode quantity overrides.
- **Untested in prod** — sandbox-only verification so far.

## Verification artifacts (sandbox)

10 BOM combo test unbuilds: NS IDs 4379469-4379477, 4379497. All tagged `custbody_milk_transfer_name = TEST-BOM-{src}_{pi}`.

8 retry successes from the 22 stuck batches: NS IDs 4379306, 4379309, 4379311, 4379313, 4379314, 4379315, 4379317, 4379319.

## Useful commands

```
node scripts/retryFailedUnbuilds.js --limit=1 --newest-first        # dry-run latest
node scripts/retryFailedUnbuilds.js --confirm --newest-first        # fire all
node scripts/testBomCombos.js                                       # dry-run all 10
node scripts/testBomCombos.js --confirm                             # fire all 10
```

Gateway must be running on `localhost:4000` for any of these to reach NS.
