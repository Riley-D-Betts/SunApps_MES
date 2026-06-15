const fs = require('fs')
const path = require('path')
const { Sequelize, DataTypes } = require('sequelize')
const config = require('../config')

const sequelize = config.sequelize
const db = {}

fs.readdirSync(__dirname)
  .filter(file => file.endsWith('.js') && file !== 'index.js')
  .forEach(file => {
    const modelFactory = require(path.join(__dirname, file))
    const model = modelFactory(sequelize, DataTypes)
    db[model.name] = model
  })

Object.values(db)
  .filter(model => typeof model.associate === 'function')
  .forEach(model => model.associate(db))

db.sequelize = sequelize
db.Sequelize = Sequelize

db.ensureRuntimeSchema = async function () {
  // sequelize.sync() creates new tables but never alters existing ones, so any
  // column added to a model after the table was first created has to be added
  // here idempotently. Each block is self-checking — safe to run on every boot.

  // MesBlendTankBatches: tick-driven cumulative totals + last-fire timestamps
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'cumulativeIssuedLbs' AND Object_ID = Object_ID(N'MesBlendTankBatches'))
      ALTER TABLE MesBlendTankBatches ADD cumulativeIssuedLbs DECIMAL(14,2) NOT NULL CONSTRAINT DF_MesBlendTankBatches_cumulativeIssuedLbs DEFAULT 0;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'cumulativeCompletedLbs' AND Object_ID = Object_ID(N'MesBlendTankBatches'))
      ALTER TABLE MesBlendTankBatches ADD cumulativeCompletedLbs DECIMAL(14,2) NOT NULL CONSTRAINT DF_MesBlendTankBatches_cumulativeCompletedLbs DEFAULT 0;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'lastIssueAt' AND Object_ID = Object_ID(N'MesBlendTankBatches'))
      ALTER TABLE MesBlendTankBatches ADD lastIssueAt DATETIME2 NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'lastCompletionAt' AND Object_ID = Object_ID(N'MesBlendTankBatches'))
      ALTER TABLE MesBlendTankBatches ADD lastCompletionAt DATETIME2 NULL;
  `)
  // Waste tracking: measured arrival (drives completion) + per-batch waste.
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'cumulativeOutputLbs' AND Object_ID = Object_ID(N'MesBlendTankBatches'))
      ALTER TABLE MesBlendTankBatches ADD cumulativeOutputLbs DECIMAL(14,2) NOT NULL CONSTRAINT DF_MesBlendTankBatches_cumulativeOutputLbs DEFAULT 0;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'lastDestLevelLbs' AND Object_ID = Object_ID(N'MesBlendTankBatches'))
      ALTER TABLE MesBlendTankBatches ADD lastDestLevelLbs DECIMAL(14,2) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'wasteLbs' AND Object_ID = Object_ID(N'MesBlendTankBatches'))
      ALTER TABLE MesBlendTankBatches ADD wasteLbs DECIMAL(14,2) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'wastePercent' AND Object_ID = Object_ID(N'MesBlendTankBatches'))
      ALTER TABLE MesBlendTankBatches ADD wastePercent DECIMAL(8,2) NULL;
  `)
  // MesBlendTankInflows: preserve routing strings on unmatched flows so we can
  // diagnose what SCADA was writing as REQUESTEDBY when no batch matched.
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'destination' AND Object_ID = Object_ID(N'MesBlendTankInflows'))
      ALTER TABLE MesBlendTankInflows ADD destination NVARCHAR(100) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'siloName' AND Object_ID = Object_ID(N'MesBlendTankInflows'))
      ALTER TABLE MesBlendTankInflows ADD siloName NVARCHAR(50) NULL;
  `)

  // MesPipeIssueStates: product/silo context for restart recovery
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'lastProductName' AND Object_ID = Object_ID(N'MesPipeIssueStates'))
      ALTER TABLE MesPipeIssueStates ADD lastProductName NVARCHAR(200) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'lastSiloName' AND Object_ID = Object_ID(N'MesPipeIssueStates'))
      ALTER TABLE MesPipeIssueStates ADD lastSiloName NVARCHAR(100) NULL;
  `)

  // MesSurgeTankBatches: Layer-3 component pinning + skip-path classification
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'componentItemId' AND Object_ID = Object_ID(N'MesSurgeTankBatches'))
      ALTER TABLE MesSurgeTankBatches ADD componentItemId NVARCHAR(50) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'componentBinId' AND Object_ID = Object_ID(N'MesSurgeTankBatches'))
      ALTER TABLE MesSurgeTankBatches ADD componentBinId INT NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'componentResolvedFrom' AND Object_ID = Object_ID(N'MesSurgeTankBatches'))
      ALTER TABLE MesSurgeTankBatches ADD componentResolvedFrom NVARCHAR(40) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'layerSkipReason' AND Object_ID = Object_ID(N'MesSurgeTankBatches'))
      ALTER TABLE MesSurgeTankBatches ADD layerSkipReason NVARCHAR(30) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'pairingStatus' AND Object_ID = Object_ID(N'MesSurgeTankBatches'))
      ALTER TABLE MesSurgeTankBatches ADD pairingStatus NVARCHAR(20) NULL;
  `)
  // Waste tracking: measured arrival (drives completion) + per-batch waste.
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'cumulativeOutputLbs' AND Object_ID = Object_ID(N'MesSurgeTankBatches'))
      ALTER TABLE MesSurgeTankBatches ADD cumulativeOutputLbs DECIMAL(14,2) NOT NULL CONSTRAINT DF_MesSurgeTankBatches_cumulativeOutputLbs DEFAULT 0;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'lastDestLevelLbs' AND Object_ID = Object_ID(N'MesSurgeTankBatches'))
      ALTER TABLE MesSurgeTankBatches ADD lastDestLevelLbs DECIMAL(14,2) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'wasteLbs' AND Object_ID = Object_ID(N'MesSurgeTankBatches'))
      ALTER TABLE MesSurgeTankBatches ADD wasteLbs DECIMAL(14,2) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'wastePercent' AND Object_ID = Object_ID(N'MesSurgeTankBatches'))
      ALTER TABLE MesSurgeTankBatches ADD wastePercent DECIMAL(8,2) NULL;
  `)
  // Actual-start backfill: historian-derived timestamp of when milk actually
  // started flowing, as opposed to when MES detected the batch (detectedAt).
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'actualStartAt' AND Object_ID = Object_ID(N'MesBlendTankBatches'))
      ALTER TABLE MesBlendTankBatches ADD actualStartAt DATETIME NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'actualStartAt' AND Object_ID = Object_ID(N'MesSurgeTankBatches'))
      ALTER TABLE MesSurgeTankBatches ADD actualStartAt DATETIME NULL;
  `)

  // MesSeparationBatches: state machine extensions (endReason + per-tick snapshots)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'endReason' AND Object_ID = Object_ID(N'MesSeparationBatches'))
      ALTER TABLE MesSeparationBatches ADD endReason NVARCHAR(40) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'prevSourceSilo' AND Object_ID = Object_ID(N'MesSeparationBatches'))
      ALTER TABLE MesSeparationBatches ADD prevSourceSilo NVARCHAR(50) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'prevDestinationsJson' AND Object_ID = Object_ID(N'MesSeparationBatches'))
      ALTER TABLE MesSeparationBatches ADD prevDestinationsJson NVARCHAR(500) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'prevIndexCodesJson' AND Object_ID = Object_ID(N'MesSeparationBatches'))
      ALTER TABLE MesSeparationBatches ADD prevIndexCodesJson NVARCHAR(500) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'lastTickAt' AND Object_ID = Object_ID(N'MesSeparationBatches'))
      ALTER TABLE MesSeparationBatches ADD lastTickAt DATETIME2 NULL;
  `)
  // Totalizer baselines captured at batch open. The separator feed/cream/skim
  // totalizers are monotonic odometers that DON'T reset between transfers, so a
  // batch's volume is (current − baseline), not the raw totalizer. Without these
  // a re-opened batch (idle reopen / boundary / recovery) re-reports the whole
  // cumulative total → 2-4 duplicate unbuilds for one physical separation.
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'feedStartLbs' AND Object_ID = Object_ID(N'MesSeparationBatches'))
      ALTER TABLE MesSeparationBatches ADD feedStartLbs DECIMAL(14,2) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'creamStartLbs' AND Object_ID = Object_ID(N'MesSeparationBatches'))
      ALTER TABLE MesSeparationBatches ADD creamStartLbs DECIMAL(14,2) NULL;
  `)
  await sequelize.query(`
    IF NOT EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'skimStartLbs' AND Object_ID = Object_ID(N'MesSeparationBatches'))
      ALTER TABLE MesSeparationBatches ADD skimStartLbs DECIMAL(14,2) NULL;
  `)
  // destinations / prev*Json originally created as NVARCHAR(500). The
  // resolved destinations payload (raw + resolved + source) blows past that,
  // breaking every openBatch with "string or binary data would be truncated".
  // max_length=-1 in sys.columns means NVARCHAR(MAX), so this is idempotent.
  await sequelize.query(`
    IF EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'destinations' AND Object_ID = Object_ID(N'MesSeparationBatches') AND max_length <> -1)
      ALTER TABLE MesSeparationBatches ALTER COLUMN destinations NVARCHAR(MAX) NULL;
  `)
  await sequelize.query(`
    IF EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'prevDestinationsJson' AND Object_ID = Object_ID(N'MesSeparationBatches') AND max_length <> -1)
      ALTER TABLE MesSeparationBatches ALTER COLUMN prevDestinationsJson NVARCHAR(MAX) NULL;
  `)
  await sequelize.query(`
    IF EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'prevIndexCodesJson' AND Object_ID = Object_ID(N'MesSeparationBatches') AND max_length <> -1)
      ALTER TABLE MesSeparationBatches ALTER COLUMN prevIndexCodesJson NVARCHAR(MAX) NULL;
  `)
  // wastePercent originally created as DECIMAL(5, 2) (max 999.99); sensor
  // glitches that produce tiny inputVolume with non-trivial wasteVolume push
  // the computed percent past the ceiling, breaking the whole batch row with
  // "Arithmetic overflow error converting numeric to data type numeric."
  // Widen to DECIMAL(8, 2). sys.columns reports precision/scale directly.
  await sequelize.query(`
    IF EXISTS (SELECT 1 FROM sys.columns WHERE Name = N'wastePercent' AND Object_ID = Object_ID(N'MesSeparationBatches') AND (precision <> 8 OR scale <> 2))
      ALTER TABLE MesSeparationBatches ALTER COLUMN wastePercent DECIMAL(8, 2) NULL;
  `)

  // Seed MesFgInputPairings from the canonical RAW_FG_TO_FG_MAP. Idempotent —
  // findOrCreate on the unique (fgItemId, rawInputItemId) index skips existing
  // rows on every boot. Newly-added entries in RAW_FG_TO_FG_MAP get auto-seeded
  // on the next deploy; rows added by ops via the approval flow are untouched.
  await seedFgInputPairings()

  // Ensure the single-row MesRuntimeConfig exists. On first create, honor any
  // env-based replay settings so existing dev configs migrate cleanly; after
  // that the DB row is authoritative and env vars are ignored.
  if (db.MesRuntimeConfig) {
    await db.MesRuntimeConfig.findOrCreate({
      where: { id: 1 },
      defaults: {
        id: 1,
        replayMode: process.env.HISTORIAN_PROVIDER === 'historical',
        simStart: process.env.SIM_START || null,
        speedup: parseFloat(process.env.SPEEDUP || '60'),
      },
    })
  }
}

async function seedFgInputPairings() {
  if (!db.MesFgInputPairing) return
  const itemConfig = require('../services/mesItemConfig')
  const { RAW_FG_TO_FG_MAP } = itemConfig
  // Pull names for nicer UI display — derive from parser catalogs (already in memory).
  let blendCatalog = []
  let surgeCatalog = []
  try { blendCatalog = require('../services/blendTankProductParser').PRODUCT_CATALOG } catch {}
  try { surgeCatalog = require('../services/surgeTankProductParser').PRODUCT_CATALOG } catch {}
  const nameForBlend = id => blendCatalog.find(p => p.nsId === Number(id))?.name || null
  const nameForSurge = id => surgeCatalog.find(p => p.nsId === Number(id))?.name || null

  let inserted = 0
  for (const [rawId, fgId] of Object.entries(RAW_FG_TO_FG_MAP)) {
    const [, created] = await db.MesFgInputPairing.findOrCreate({
      where: { fgItemId: Number(fgId), rawInputItemId: Number(rawId) },
      defaults: {
        status: 'approved',
        fgName: nameForSurge(fgId),
        rawInputName: nameForBlend(rawId),
        createdBy: 'seed',
        decidedBy: 'seed',
        decidedAt: new Date(),
        notes: 'Canonical pairing seeded from RAW_FG_TO_FG_MAP',
      },
    })
    if (created) inserted++
  }
  if (inserted > 0) console.log(`[Models] Seeded ${inserted} canonical FG input pairing(s)`)
}

db.seedFgInputPairings = seedFgInputPairings

module.exports = db
