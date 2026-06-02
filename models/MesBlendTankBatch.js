module.exports = (sequelize, DataTypes) => {
  const MesBlendTankBatch = sequelize.define(
    'MesBlendTankBatch',
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
      batchSize: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },
      fromEntName: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      toEntName: {
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
      // Measured mass that REACHED this tank (load-cell weight rise, summed).
      // Drives workOrderCompletion; cumulativeIssued − cumulativeOutput = waste.
      cumulativeOutputLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },
      // Last destination-level reading (lbs) used as the arrival baseline.
      lastDestLevelLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
      },
      // Computed at batch close: issued − output (lbs) and as a % of issued.
      wasteLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
      },
      wastePercent: {
        type: DataTypes.DECIMAL(8, 2),
        allowNull: true,
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
      tableName: 'MesBlendTankBatches',
      timestamps: false,
      indexes: [
        {
          fields: ['tankId', 'productName', 'status'],
          name: 'idx_tank_product_status',
        },
      ],
    }
  )

  return MesBlendTankBatch
}
