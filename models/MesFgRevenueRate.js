module.exports = (sequelize, DataTypes) => {
  const MesFgRevenueRate = sequelize.define('MesFgRevenueRate', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // Bulk FG assembly NS id (the mesItem on surge batches, e.g. 6420) —
    // NOT the packaged SKU. The rate already folds the SKU mix in.
    fgItemId: {
      type: DataTypes.STRING(50),
      allowNull: false,
    },
    // What one pound of this bulk FG would have earned as invoiced finished
    // goods: Σ(outCases × invoice $/case) / Σ(bulk lbs consumed) over the
    // packaging WOs + invoices of the trailing window.
    revenuePerLb: {
      type: DataTypes.DECIMAL(10, 4),
      allowNull: false,
    },
    // 'ns' = derived by the daily price-sync job; 'manual' = entered via
    // POST /api/mes/config/costs/fg-revenue.
    source: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'manual',
    },
    // Derivation note, e.g. "6422 $8.57/case ÷ 10.0 lb/case · 1 SKU · 90d".
    basis: {
      type: DataTypes.STRING(200),
      allowNull: true,
    },
    effectiveFrom: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
    },
  }, {
    tableName: 'MesFgRevenueRates',
    // Append-only, like MesRawMilkPrices: newest row per fgItemId
    // (effectiveFrom DESC, id DESC) is current; the rest is audit history.
    timestamps: false,
    indexes: [
      { name: 'idx_fgrevenuerate_item_effective', fields: ['fgItemId', 'effectiveFrom'] },
    ],
  })

  return MesFgRevenueRate
}
