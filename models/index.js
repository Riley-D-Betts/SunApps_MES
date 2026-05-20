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

  // Seed MesFgInputPairings from the canonical RAW_FG_TO_FG_MAP. Idempotent —
  // findOrCreate on the unique (fgItemId, rawInputItemId) index skips existing
  // rows on every boot. Newly-added entries in RAW_FG_TO_FG_MAP get auto-seeded
  // on the next deploy; rows added by ops via the approval flow are untouched.
  await seedFgInputPairings()
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

module.exports = db
