---
name: uht-single-claimant
description: A UHT sterilizes for exactly one surge tank at a time, but two surge batches on the same UHT are 'active' at once — the shared totalizer must be claimed by only one per tick
metadata:
  type: project
---

Each UHT (UHT1→ST81/ST82, UHT2→ST83/ST84) sterilizes milk for exactly ONE surge tank at a time, but the MES legitimately has TWO `active` MesSurgeTankBatch rows on the same UHT simultaneously — one tank draining to the filler while the next fills. Both batches read the same per-UHT software totalizer (`getUhtMilkTotalizer`), so any per-batch tick that issues its own delta will double-count the same milk onto both WOs.

**Why:** observed live as WO1635 (ST81) + WO1636 (ST82) both on UHT1 each issuing/completing the same UHT1 flow.

**How to apply:** the authoritative "which tank is this UHT filling right now" signal is `equipmentJob.resolveActiveFillTank` (hysteresis: 60s to switch, 3min to clear), surfaced as `activeFill` per tank / `destSurgeTankId` per UHT in `statusStore.snapshot().surgeTanks`. `surgeTankMesService.resolveIssueModes` uses it to make only one batch per UHT claim the delta each tick (issue / forfeit-and-advance-baseline / hold). Any new per-UHT accounting must respect single-claimant. Related: [[plant_flow_chain]], [[surge_wo_start_gates]], [[uht_milk_totalizer_gating]].
