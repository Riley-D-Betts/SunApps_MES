module.exports = (sequelize, DataTypes) => {
  const MesCostConfig = sequelize.define(
    'MesCostConfig',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      // Average milk cost, $/lb (e.g. 0.3400). The one required figure —
      // everything that prices waste multiplies by this.
      milkCostPerLb: {
        type: DataTypes.DECIMAL(10, 4),
        allowNull: false,
      },
      // Optional finished-goods price per case. Consumers that can pull a live
      // per-item price (the Portal reads NetSuite pricing) should prefer that;
      // this is the flat fallback.
      fgCasePrice: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },
      // Free-text provenance ("ops-provided Aug 2026", "Q4 contract"…).
      note: {
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
    },
    {
      // APPEND-ONLY: rows are never updated or deleted. The newest row
      // (effectiveFrom DESC, id DESC) is the current price; history is the
      // audit trail by construction. Seeded post-deploy via POST — a price is
      // business data and deliberately not baked into code (DEPLOY_CHECKLIST).
      tableName: 'MesCostConfigs',
      timestamps: false,
    }
  )

  return MesCostConfig
}
