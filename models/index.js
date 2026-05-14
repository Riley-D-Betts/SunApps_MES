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
}

module.exports = db
