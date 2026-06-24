---
name: ns-bin-cutover
description: Low-numbered NS bins (e.g. 1003) are pre-Ida-Milk-cutover and stale; current production inventory lives in the 49xx-range bins the MES pins
metadata:
  type: reference
---

NS sandbox `inventorybalance` still shows large on-hand for items in low-numbered bins (e.g. bin **1003** held 2.2M lb of item 5403). Those are **pre-cutover (before the switch to Ida Milk)** and are NOT the bins production uses now — current MES bins are the 49xx-range ids the services pin (e.g. blend/surge `componentBinId` 4929/4933/4935).

**Why it matters:** when cross-checking "where does NS show this item's stock," a low-numbered bin with huge on-hand is a red herring. `findInventoryAllocations` / `findBinForItem` correctly ignore them (return null when the item has no stock in a valid current bin) — so an item whose only balance is in old bins issues as INSUFFICIENT even though `inventorybalance` looks full. Verified 2026-06-02: item 5403 had millions of lb across bins 1001–1013 but `findBinForItem(5403, 4933)` → null.

Related: [[ns-wo-issue-shape]], [[lot-tracked-bom-components]].
