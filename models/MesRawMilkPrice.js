module.exports = (sequelize, DataTypes) => {
  const MesRawMilkPrice = sequelize.define('MesRawMilkPrice', {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    // Raw-milk cost family: 'organic' | 'conventional' | 'a2' |
    // 'cream_organic' | 'cream_conventional'. The canonical list lives in
    // services/rawMilkPriceService.js FAMILY_INTAKE_ITEMS.
    family: {
      type: DataTypes.STRING(24),
      allowNull: false,
    },
    pricePerLb: {
      type: DataTypes.DECIMAL(10, 4),
      allowNull: false,
    },
    // 'ns' = derived by the daily price-sync job from NetSuite purchase
    // transactions; 'manual' = entered via POST /api/mes/config/costs/raw-milk
    // (the only path for families NS can't price, e.g. A2).
    source: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: 'manual',
    },
    // Human-readable derivation note, e.g.
    // "VendBill wavg 30d · item 5404 · 7,022,220 lb". Audit context only.
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
    tableName: 'MesRawMilkPrices',
    // Append-only, like MesCostConfigs: rows are never updated or deleted.
    // The newest row per family (effectiveFrom DESC, id DESC) is the current
    // price; everything older is the audit history.
    timestamps: false,
    indexes: [
      { name: 'idx_rawmilkprice_family_effective', fields: ['family', 'effectiveFrom'] },
    ],
  })

  return MesRawMilkPrice
}
