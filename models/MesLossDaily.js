module.exports = (sequelize, DataTypes) => {
  // Persisted daily loss history (SD-729). One row per plant-local close DAY
  // × stage × equipment × family, written by jobs/lossRollupJob.js (and the
  // backfill script) from the same query the live loss report runs, so the
  // executive trend is stable against late batch corrections and raw-milk
  // price drift: wasteUsd is frozen at the $/lb in effect when the row was
  // rolled up (pricePerLb records it). Re-running the rollup over a window
  // deliberately re-prices it. Nothing in the live batch tables is touched.
  //
  // Stage values today: 'separation' | 'blend' | 'surge'. The NetSuite-derived
  // v2 stages ('received', 'packaging') land in this same table.
  //
  // Schema note: this table was born in 1.0.13, so sequelize.sync() creates
  // it. Any column added LATER needs a guarded block in
  // db.ensureRuntimeSchema() (models/index.js) — sync never ALTERs.
  const MesLossDaily = sequelize.define('MesLossDaily', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // Plant-local (America/Boise) calendar date the batch CLOSED on.
    day: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    stage: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    // ST81…ST84 / BlendTank1A… / MSilo1… ; 'unknown' when the batch has none.
    equipment: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    // Surge/blend: UHT1 | UHT2 (feedingUhtId). Separation: null.
    equipmentGroup: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    // Raw-milk cost family (rawMilkPriceService.FAMILIES) or 'unclassified'.
    family: {
      type: DataTypes.STRING(24),
      allowNull: false,
    },
    lbsIn: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
    },
    // Input lb of the batches whose loss is MEASURED (excludes upper-bound-only
    // batches) — the denominator for "Ignore upper bounds". Null on rows rolled
    // up before 1.0.13's SD-722 follow-up; re-run the rollup to fill it.
    lbsInMeasured: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: true,
    },
    // Best estimate: measured batches at measured waste + unmeasurable batches
    // at their upper bound. wasteLbs = wasteMeasuredLbs + wasteUpperBoundLbs.
    wasteLbs: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
    },
    wasteMeasuredLbs: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
    },
    wasteUpperBoundLbs: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
    },
    // Priced at pricePerLb; null when the family had no price at rollup time.
    wasteUsd: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: true,
    },
    wasteMeasuredUsd: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: true,
    },
    // Forgone FG revenue on the wasted lb — the second $ basis, a peer of
    // wasteUsd (never added to it). Null for separation / unrated items.
    lostRevenueUsd: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: true,
    },
    lostRevenueMeasuredUsd: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: true,
    },
    pricePerLb: {
      type: DataTypes.DECIMAL(10, 4),
      allowNull: true,
    },
    batchCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    unmeasuredBatchCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // Closed batches with <100 lb issued — production the MES could not
    // account for (item mis-pin / layer skip). Never counted as loss.
    zeroIssuedCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    // Separation batches held pending_ns (mass-balance review) — input lb only.
    heldLbs: {
      type: DataTypes.DECIMAL(14, 2),
      allowNull: false,
    },
    computedAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
  }, {
    tableName: 'MesLossDaily',
    timestamps: false,
    indexes: [
      { name: 'ux_lossdaily_key', unique: true, fields: ['day', 'stage', 'equipment', 'family'] },
      { name: 'idx_lossdaily_day', fields: ['day'] },
    ],
  })

  return MesLossDaily
}
