# AVEVA Historian REST API v2 — Reference

**Base URL:** `http://10.4.9.23:32569/Historian/v2/`
**Auth:** NTLM (domain: `MES`, user from env)
**Format:** OData v4 (JSON)
**Page size:** 500 records (use `@odata.nextLink` / `$skiptoken` to paginate)

---

## Endpoints (Entity Sets)

| Endpoint | Purpose |
|----------|---------|
| `Tags` | Tag metadata (FQN, description, type, eng unit, min/max) |
| `ProcessValues` | Current or historical raw values (main query endpoint) |
| `AnalogSummary` | Statistical summary for analog tags (min/max/avg/count/integral) over a time range |
| `StateSummary` | State-based summary for discrete tags |
| `DailySummary` | Pre-aggregated daily rollups |
| `HourlySummary` | Pre-aggregated hourly rollups |
| `MinutelySummary` | Pre-aggregated minute rollups |
| `TagGroups` | Hierarchical tag grouping |
| `TagProperties` | Available tag property names |
| `TagPropertyValues` | Tag property name/value pairs with nav to Tags |
| `TagSearch` | Full-text tag search |
| `TagSuggest` | Type-ahead tag suggestions |
| `SearchSuggest` | General search suggestions |
| `SystemParameters` | System configuration parameters |
| `Comments` | User comments/annotations |
| `Contents` | Saved content/charts |
| `EngineeringUnits` | Available engineering unit definitions |
| `EngineeringUnitDimension` | Unit dimension metadata |
| `ExpressionSuggest` | Expression builder suggestions |
| `ExpressionValidate` | Expression validation |
| `Assets` | Asset hierarchy (name, namespace, location) |
| `$metadata` | OData EDMX schema (XML) |

---

## Key Entity Schemas

### ProcessValue (ProcessValues)
```
FQN             string    (key) Fully Qualified tag Name
DateTime        datetimeoffset
OpcQuality      int32     (192 = good)
Value           double?
Text            string?
Unit            string?
```

### Tag (Tags)
```
FQN             string    (key)
TagName         string
Description     string
TagType         string    (Analog | Discrete | String)
EngUnit         string
EngUnitMin      double
EngUnitMax      double
InterpolationType string
Source          string
```
Navigation: `Raw` → ProcessValues, `Minutely`, `Hourly`, `Daily`

### AnalogSummary
```
FQN, StartDateTime, EndDateTime, OpcQuality, PercentGood, Unit
First, FirstDateTime, Last, LastDateTime
Minimum, MinDateTime, Maximum, MaxDateTime
Average, StdDev, Integral, Count
```
Navigation: `Raw` → ProcessValues

### DailySummary / HourlySummary / MinutelySummary
```
FQN, StartDateTime, EndDateTime, OpcQuality, PercentGood
Analog { First, Last, Min, Max, Average, StdDev, Integral, Count }
Split[]  (state statistics)
Contained[] (state statistics)
```

---

## Query Examples

### Get latest value for a tag (no filter = current value)
```
GET /Historian/v2/ProcessValues?$filter=FQN eq 'Separator.CreamFatAct'
```

### Get historical values with time range
```
GET /Historian/v2/ProcessValues?$filter=
  FQN eq 'MSILO1.GALLONS'
  and DateTime ge datetimeoffset'2026-03-09T00:00:00Z'
  and DateTime le datetimeoffset'2026-03-09T12:00:00Z'
```

### Get tag metadata
```
GET /Historian/v2/Tags?$select=FQN,Description,TagType,EngUnit
```

### Tag navigation to raw data
```
GET /Historian/v2/Tags('Separator.CreamFatAct')/Raw
```

### Analog summary over a period
```
GET /Historian/v2/AnalogSummary?$filter=
  FQN eq 'MSILO1.GALLONS'
  and StartDateTime ge datetimeoffset'2026-03-09T00:00:00Z'
  and EndDateTime le datetimeoffset'2026-03-09T12:00:00Z'
```

---

## Milk-Related Equipment & Tags

### Raw Milk Silos (5 silos)
| Tag Pattern | Type | Unit | Description |
|-------------|------|------|-------------|
| `MSILO{1-5}.GALLONS` | Analog | None | Silo gallons |
| `MSILO{1-5}.LBS` | Analog | None | Silo LBS |
| `MSILO{1-5}.LevelValue` | Analog | None | Silo level |
| `MSILO{1-5}.TempValue` | Analog | None | Silo temperature |
| `MSILO{1-5}.ProductDensity` | Analog | PPG | Product density |
| `MSILO{1-5}.ProductName` | String | — | Current product name |
| `MSilo{1-5}_Gallons.Value` | Analog | GAL | Silo gallons (alt) |
| `MSilo{1-5}_LBS.Value` | Analog | LBS | Silo LBS (alt) |
| `RawMilkSilo{1-5}.ProductName` | String | — | Product name |
| `ML{1-4}.CURRENTSILONAME` | String | — | Milk line → current silo |
| `ML{1-4}.CURRENTSILOPRODUCTCODE` | Analog | — | Milk line → product code |
| `ML{1-4}.CURRENTSILOPRODUCTDENSITY` | Analog | PPG | Milk line → density |

### Cream Silos (3 silos)
| Tag Pattern | Type | Unit | Description |
|-------------|------|------|-------------|
| `CSILO{1-3}.GALLONS` | Analog | None | Cream silo gallons |
| `CSILO{1-3}.LBS` | Analog | None | Cream silo LBS |
| `CSILO{1-3}.LevelValue` | Analog | None | Cream silo level |
| `CSILO{1-3}.TempValue` | Analog | None | Cream silo temp |
| `CSILO{1-3}.ProductDensity` | Analog | PPG | Product density |
| `CSILO{1-3}.ProductName` | String | — | Current product |
| `CSilo{1-3}_Gallons.Value` | Analog | GAL | (alt) |
| `CSilo{1-3}_LBS.Value` | Analog | LBS | (alt) |
| `CL{1-2}.CURRENTSILONAME` | String | — | Cream line → current silo |
| `CreamBalance.GALLONS` | Analog | None | Cream balance tank gallons |
| `CreamBalance.LBS` | Analog | None | Cream balance tank LBS |
| `CreamBalance.LevelValue` | Analog | None | Cream balance tank level |

### Separator (192 tags under `Separator.*`)
Key operational tags:
| Tag | Type | Description |
|-----|------|-------------|
| `Separator.CreamFatAct` | Analog | Actual cream fat % |
| `Separator.CreamCVOutput` | Analog | Cream control valve output |
| `Separator.ProcessActive` | Discrete | Separator running |
| `Separator.MachineRunning` | Discrete | Machine running |
| `Separator.MachineRunTime` | Analog | Run time counter |
| `Separator.MachineModeActive` | Analog | Current machine mode |
| `Separator.MotorSpeedActual` | Analog | Motor speed |
| `Separator.ProductFatContent` | Analog | Input product fat % |
| `Separator.SkimFatAct` | Analog | (check — may exist) |

### Cold Milk Separator (MES work order integration)
| Tag | Type | Description |
|-----|------|-------------|
| `ColdMilkSeparator1.CurrentWO` | String | Current work order |
| `ColdMilkSeparator1.CurrentItem` | String | Item being produced |
| `ColdMilkSeparator1.CurrentProd` | Analog | Current production qty |
| `ColdMilkSeparator1.ProdQty` | Analog | Produced quantity |
| `ColdMilkSeparator1.ProdItem` | String | Produced item ID |
| `ColdMilkSeparator1.ProdLot` | String | Produced lot number |
| `ColdMilkSeparator1.ConsQty` | Analog | Consumed quantity |
| `ColdMilkSeparator1.ConsItem` | String | Consumed item ID |
| `ColdMilkSeparator1.ConsLot` | String | Consumed lot number |
| `ColdMilkSeparator1.JobRunning` | Discrete | Job active |
| `ColdMilkSeparator1.StartJob` | Discrete | Start trigger |
| `ColdMilkSeparator1.EndJob` | Discrete | End trigger |
| `ColdMilkSeparator1.FromEntName` | String | Source entity |
| `ColdMilkSeparator1.ToEntName` | String | Destination entity |

### Separator Flow Totals (IO layer)
| Tag | Type | Description |
|-----|------|-------------|
| `Ing_Sep_CMSep1_HIST.Cream_Flow_Totalized` | Analog | Totalized cream flow |
| `Ing_Sep_CMSep1_HIST.Skim_Flow_Totalized` | Analog | Totalized skim flow |

### Bulk Milk Intake (2 bays)
| Tag | Type | Unit | Description |
|-----|------|------|-------------|
| `B{1-2}Intake.UnloadTotal` | Analog | LBS | Unload total |
| `B{1-2}Intake.SiloNumSelectRead` | Analog | — | Destination silo |
| `B{1-2}Intake.TruckProductCode` | Analog | — | Product code |
| `B{1-2}Intake.InProcess` | Discrete | — | Currently unloading |
| `B{1-2}Intake.StepNum` | Analog | — | Unload step |

### Cream Loadout
| Tag | Type | Description |
|-----|------|-------------|
| `CreamLO.LoadoutTotal` | Analog | Loadout volume total |
| `CreamLO.LoadoutSP` | Analog | Volume setpoint |
| `CreamLO.StepNum` | Analog | Loadout step |
| `CreamLO.DriverName` | String | Driver name |

### Standardization Product Settings
| Tag | Type | Unit | Description |
|-----|------|------|-------------|
| `Product.CALC_CREAMFATPER_ENTRY` | Analog | % | Cream fat % entry |
| `Product.CALC_SKIMFATPER_ENTRY` | Analog | % | Skim fat % entry |
| `Product.CALC_CREAMFLOWPPM` | Analog | PPM | Cream flow PPM |
| `Product.CALC_SKIMFLOWPPM` | Analog | PPM | Skim flow PPM |
| `Product.CreamAddBackFlow_SP` | Analog | PPM | Cream add-back setpoint |
| `Product.FinalCreamTemp_SP` | Analog | °F | Final cream temp SP |
| `Product.FinalSkimTemp_SP` | Analog | °F | Final skim temp SP |
| `Product.FinalSkimFatPer_SP` | Analog | % | Final skim fat % SP |

---

## Stats: 23,393 total tags across ~300+ equipment groups
