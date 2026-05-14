module.exports = (sequelize, DataTypes) => {
  const MesSurgeTankBatch = sequelize.define(
    'MesSurgeTankBatch',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      tankId: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      productName: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      mesItem: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      // UHT feeding this surge tank. The UHT-inflow software totalizer lives on
      // restProvider._uhtMilkGal[uhtId] — we track which UHT to read per batch.
      feedingUhtId: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      // Source entity feeding the UHT — either a silo (MSilo*/CSilo*) or a
      // blend tank (BlendTank*). Drives component resolution + issue source bin.
      feedingFromEntName: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      parserConfidence: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      nsWorkOrderId: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      nsWorkOrderNumber: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active',
      },
      errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      detectedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      cumulativeIssuedLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },
      cumulativeCompletedLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },
      lastIssueAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      lastCompletionAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'MesSurgeTankBatches',
      timestamps: false,
      indexes: [
        {
          fields: ['tankId', 'productName', 'status'],
          name: 'idx_surgetank_tank_product_status',
        },
      ],
    }
  )

  return MesSurgeTankBatch
}
