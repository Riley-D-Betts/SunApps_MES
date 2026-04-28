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
}

module.exports = db
