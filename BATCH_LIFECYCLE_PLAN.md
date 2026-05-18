# Batch Lifecycle Plan — Standardizing Start/End Conditions

Reference design for unifying how Separator, Blend Tank, and Surge Tank batches start, run, and end. Today each stage uses ad-hoc heuristics (TransferComplete edge, NOTE_STRING change + 500-lb weight, _ProductDesc + 5-tick gain). This doc replaces those with a single state-machine pattern that uses explicit SCADA signals where available and falls back to debounced idle detection where not.

Status: design locked, pending one diagnostic step (blend-tank CIP tag discovery) before implementation.

---

## 1. Common pattern

Every stage uses the same three-state machine:

```
idle ──► running ──► closed ──► (idle or running again)
```

Common end conditions across all stages:
- An explicit CIP signal — stage entered CIP mode.
- A boundary signal — source, destination, or product identity changed.
- An idle signal — debounced absence of activity for ~5 minutes.

Common shape of "live persistence":
- The DB row for the active batch is updated every tick (~10s) with current totalizers, so a process crash mid-batch loses at most one tick.

Common dropped concepts:
- Weight / level thresholds as start or end signals — replaced by explicit mode tags and line-flow / RPM / gallons-delta signals.
- The 2-min `MIN_BATCH_DURATION_MS` guard that exists today only because weight-from-zero false-ends required it.

---

## 2. Separator

### Polled every tick (~10s)

| Tag | Use |
|---|---|
| `SEPSTAT.FEEDPERMIT` | running flag |
| `SEPSTAT.MOTORSPEEDPROX` | motor RPM (idle detector) |
| `SEPSTAT.CIPCHEMMODE_REQ` | CIP detection |
| `SEPSTAT.CIPRINSEMODE_REQ` | CIP detection |
| `Product.SepFeedTotal` | input lbs (live, resets between batches) |
| `Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized` | cream gal (live, resets between batches) |
| `Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized` | skim gal (live, resets between batches) |
| `Ingr_Sep_CMSep1_IO.XFR.Source` | source silo |
| `Ingr_Sep_CMSep1_IO.XFR.Destination#.0..3` | up to 4 destination silos |
| `Ingr_Sep_CMSep1_IO.XFR.TransferCompleteS.0` | end-of-batch bit (one of several end signals) |
| `MSILO{n}.IndexSelectRead` for each participating silo | product code 1–40 |

### Start (idle → running)

ALL must hold:
- `FEEDPERMIT` rising edge (0 → 1)
- `CIPCHEMMODE_REQ` = 0 AND `CIPRINSEMODE_REQ` = 0
- `XFR.Source` populated

→ open `MesSeparationBatches` row, snapshot source / destinations / index codes.

### During run (every tick)

- Persist current `FeedTotal` / `CreamTotal` / `SkimTotal` to the open row.
- A previously-empty destination slot becoming populated is normal — not a boundary.

### End (running → closed)

ANY of:

| Reason | Trigger |
|---|---|
| `transfer_complete` | `XFR.TransferCompleteS.0` rising edge |
| `source_changed` | `XFR.Source` changes to a different silo |
| `destination_changed` | A populated `XFR.Destination#.N` slot changes value |
| `product_index_changed` | A participating silo's `IndexSelectRead` changes |
| `cip_started` | `CIPCHEMMODE_REQ` or `CIPRINSEMODE_REQ` → 1 |
| `idle_rpm` | `MOTORSPEEDPROX` < 100 RPM continuously for 5 min |
| `idle_feedpermit` | `FEEDPERMIT` = 0 continuously for 5 min |

→ finalize totals, POST `assemblyUnbuild` to NS, re-evaluate start conditions in the same tick (a boundary closes one batch and opens another).

---

## 3. Blend Tank

### Polled every tick (~10s)

Per tank (BT1A/1B/2A/2B):

| Tag | Use |
|---|---|
| `BlendTank{N}.NOTE_STRING` | product name (Atlas-set) — identity authority |
| `BlendTank{N}.CurrentWOState` | **production gate** — string. `"Running"` = eligible. Other observed: `"Complete"`. CIP/Idle/Sterile values not yet sampled. |
| `BlendTank{N}.100LT.SCL_LBS` | tank weight (live persistence only — not a start/end signal) |
| `BlendTank{N}.BatchSize` | operator-set target |
| `BlendTank{N}.FromEntName`, `ToEntName` | source / destination entity strings |

**Critical:** All standardized tags MUST live at the `BlendTank{N}.*` level. The `Proc_Proc1_BT{N}_IO.*` namespace exists for BT1A/BT1B only — BT2A/BT2B have no OEM-IO bridge and all queries return no data. Confirmed by `checkBlendTags.js` + `checkBlendTags2.js` (2026-05-18).

Per line (ML1–4, CL1–2):

| Tag | Use |
|---|---|
| `{LINE}.BATCHTOTALIZER` | line totalizer (lbs, resets per batch) |
| `{LINE}.CURRENTSILOPRODUCTNAME`, `CURRENTSILOPRODUCTCODE` | product on the line |
| `{LINE}.CURRENTSILOSOURCESILONAME` | source silo |
| `{LINE}.REQUESTEDBY` | destination vessel — e.g. "BlendTank1A" |
| `{LINE}.STAT_ACTIVE` | line active flag |
| `{LINE}.CURRENTPRODUCTDENSITY` | PPG conversion |

### Start (idle → running)

ALL must hold:
- `CurrentWOState == "Running"` (affirmative production signal — replaces the abstract "not in CIP" check)
- `NOTE_STRING` is set to a recognized **type-2 or type-3** product
- ≥ 1 line has `REQUESTEDBY = this tank` AND `STAT_ACTIVE = true` AND its `BATCHTOTALIZER` advanced this tick

→ resolve item, POST `workOrder` to NS, open `MesBlendTankBatch` row.

**Constraint:** BTs produce type-2 (Raw separated milk — standardization in BT) or type-3 (Raw FG) items only. Type-4 finished goods are surge-tank-only and must be rejected at this resolver. Today's `RAW_FG_ITEM_MAP` covers type-3; expanding to include type-2 (Raw Conv Skim/1%/2%/3.25%/3.5%, Raw Org and Raw Org A2 variants, Raw Cream) is required for the standardization-in-BT flow.

### During run (every tick)

- Issue line deltas to the WO (existing tick logic in `blendTankMesService.tickAllActiveBatches`).
- Re-snapshot which lines are feeding.

**Multi-pipe inflow:** A blend tank can have multiple lines flowing in simultaneously (e.g. skim line + cream line for a 2% standardization). Each tick must produce **one `workOrderIssue` per `(source bin, item)` tuple** — not one per line. Two lines pulling from the same silo carrying the same product collapse into a single issue; two lines from different silos (or same silo, different products) each get their own. All inputs are bin-tracked, so the bin (source silo) is part of the issue's grouping key.

### End (running → closed)

ANY of:

| Reason | Trigger |
|---|---|
| `wo_state_left_running` | `CurrentWOState` changes from `"Running"` to anything else (Complete / CIP / Idle / …). Atlas operator marked the WO done. |
| `all_lines_stopped` | All lines with `REQUESTEDBY = this tank` have been inactive AND not advancing totalizer continuously for 5 min |
| `note_cleared` | `NOTE_STRING` cleared |

→ final `workOrderCompletion` to BT, end batch. Lot number = `MMDDYY{woNum}` for type-3; bin = the blend tank itself.

No weight-based end conditions. Drop existing `WEIGHT_THRESHOLD_LBS = 500` (start), `EMPTY_THRESHOLD_LBS = 100` (end), and `MIN_BATCH_DURATION_MS = 2 min` guard.

### Diagnostic findings (2026-05-18)

Initial probe (`scripts/checkBlendTags.js` + `scripts/checkBlendTags2.js`) ruled out most candidates and confirmed `CurrentWOState`:

| Tag | Result |
|---|---|
| `Proc_Proc1_BT{N}_IO.UCO.Sallocation` | BT1A/1B = 0 (not the documented 1/2/3-5); BT2A/2B = no data. **Unusable.** |
| `Proc_Proc1_BT{N}_IO.UCO.MUtilState` | BT1A=2, BT1B=3; BT2A/2B = no data. **Unusable** (BT2 gap). |
| `Proc_Proc1_BT{N}_IO.UCO.Mallocation` | BT1A/1B = 0; BT2A/2B = no data. |
| `Proc_Proc1_BT{N}_RMS.CurrentRecipe*` | All null. |
| `Proc_Proc1_BT{N}_IO.UCO.ProdS` / `CleanS` / `AssetModeS` | All null on BT1A/1B; no data on BT2A/2B. |
| `Proc_Proc1_BT{N}_IO.UCO.MUtilReasonCd` | BT1A/1B = 0; BT2A/2B = no data. |
| **`BlendTank{N}.CurrentWOState`** | **All four tanks return values.** Observed: `"Running"` (BT1A) and `"Complete"` (BT1B/2A/2B). **Selected.** |

### Follow-up diagnostic owed

We've only sampled two `CurrentWOState` values (`"Running"`, `"Complete"`). To confirm what the tag emits during CIP / Idle / Sterile phases, run `scripts/monitorWOState.js` over a known CIP window and append the discovered values to this section.

---

## 4. Surge Tank

### Polled every tick (~10s)

Per tank (ST81–84):

| Tag | Use |
|---|---|
| `ThermaRoute.ThermaRoute.{TID}_LT8{N}01_Gal` | main gallons (live → `pollDeltaGal`) |
| `ThermaRoute.ThermaRoute.{TID}_LT8{N}01` | main level % |
| `ThermaRoute.{TID}_ProductDesc` | product name |
| `ThermaRoute.{TID}_State` | state code — 1=Sterile, 4=CIP (others unknown) |
| `ThermaRoute.{TID}_Connected`, `_TankEmpty_Indicator`, `_FillingOK` | discrete state |

Per UHT/ST pair:

| Tag | Use |
|---|---|
| `ThermaRoute.{UHT}_{ST}_Connection_Code` | =1 when UHT is plumbed to this ST |

Per UHT (already polled by equipment job):
- Mode bits → PROCESS / CIP / IDLE / DD_INH
- Step name (`Sterile on Product` is the start gate)
- FT1102 software totalizer
- `FromEntName` (silo or BT feeding the UHT)

### Start (idle → running)

ALL must hold:
- `State ≠ 4` (not CIP)
- `_ProductDesc` is a recognized **type-4 FG** product
- Feeding UHT mode = PROCESS AND step name = `"Sterile on Product"`
- 5 consecutive ticks with `pollDeltaGal > 5 gal`

→ pin Layer-3 raw component (existing `resolveLayer3Component`), POST `workOrder` to NS with custom one-line component list, open `MesSurgeTankBatch`. Pairing approval workflow (`MesFgInputPairings`) unchanged.

### During run (every tick)

- Read `historian.getUhtMilkTotalizer(feedingUht)` — convert deltaGal × 8.6 → lbs.
- POST `workOrderIssue` for the pinned component (existing tick logic).
- Compute completion via `mainGallons` growth and POST `workOrderCompletion` when `cumulativeIssued - cumulativeCompleted ≥ MES_MIN_COMPLETION_LBS`.

### End (running → closed)

ANY of:

| Reason | Trigger |
|---|---|
| `product_cleared` | `_ProductDesc` cleared |
| `product_changed` | `_ProductDesc` changes to a different valid product |
| `cip_started` | `State` → 4 |
| `uht_changed` | Feeding UHT changes (Connection_Code rebind) |
| `source_changed` | Feeding UHT's `FromEntName` changes |
| `uht_mode_changed` | Feeding UHT's mode → CIP or IDLE |
| `idle` | `pollDeltaGal < 5` AND UHT step ≠ `"Sterile on Product"` continuously for 5 min |

→ finalize, POST final `workOrderIssue` + `workOrderCompletion`. Lot number = `MMDDYY{woNum}`; bin = the surge tank.

No gallons-based emptied threshold (drop existing `mainGallons < 10 after ≥ 2 min`).

---

## 5. Consolidated comparison

| | Separator | Blend Tank | Surge Tank |
|---|---|---|---|
| **Active flag** | `FEEDPERMIT=1` + not CIP | production-tag = "production" + ≥1 line feeding | `State≠4` + UHT on "Sterile on Product" + 5-tick gain |
| **Product identity from** | `XFR.Source` + per-silo `IndexSelectRead` | `NOTE_STRING` (type-2 or type-3 only) | `_ProductDesc` (type-4 FG only) |
| **Source change** | `XFR.Source` changes → close | (lines change naturally via tick logic) | UHT's `FromEntName` changes → close |
| **Destination change** | Populated `XFR.Destination#.N` changes → close | N/A (BT is itself destination) | UHT swap (Connection_Code rebind) → close |
| **CIP detection** | `CIPCHEMMODE_REQ` / `CIPRINSEMODE_REQ` | `CurrentWOState != "Running"` (covers CIP + idle + complete uniformly) | `State=4` + UHT mode=CIP |
| **Idle definition** | `MOTORSPEEDPROX<100` for 5 min OR `FEEDPERMIT=0` for 5 min | All feeding lines stopped for 5 min | No gallons growth + UHT not sterilizing for 5 min |
| **Weight/level thresholds** | Removed (CIP tag suffices) | Removed (line flow suffices) | Removed (idle test suffices) |
| **Live persistence** | Every tick into open row | Every tick (existing) | Every tick (existing) |
| **NS transaction** | `assemblyUnbuild` | `workOrder` + `workOrderIssue` × N (one per `(source bin, item)` tuple) + `workOrderCompletion` | `workOrder` + `workOrderIssue` × N + `workOrderCompletion` |
| **Lot number** | None (bin-tracked only) | Type-3: `MMDDYY{woNum}`; Type-2: none | `MMDDYY{woNum}` |

---

## 6. Cross-cutting work not in this plan

Out of scope for the batch-lifecycle redesign but called out by the source description (`Milk Tracking using Sunapps_MES.txt`) — track separately:

1. **Inventory back-up adjustments.** Bin-tracked transactions fail when a silo is inflowing and outflowing simultaneously. Need a compensating-adjustment service: adjust up when source bin is short, adjust back down when it flattens. Touches all three stages.
2. **Type-2 BOM expansion.** BTs producing type-2 (standardization in a BT — e.g. raw org skim + raw org cream → raw org 2%) need item resolver coverage. Adjacent to but distinct from this plan.

---

## 7. Related references

- Current implementation overview: `overview.md`
- Surge tank previous design pass: `SURGE_TANK_PLAN.md`
- Implementation discoveries: `PICKUP.md`
- Source description: `Milk Tracking using Sunapps_MES.txt`
- Memory: `surge_wo_start_gates.md`, `a2_separator_hmi.md`, `silo_flexibility.md`, `ns_wo_issue_shape.md`, `future_bom_layering.md`, `project_standardized_aveva_inputs.md`
