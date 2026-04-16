module.exports = (sequelize, DataTypes) => {
  const MesSeparationBatch = sequelize.define(
    'MesSeparationBatch',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      batchId: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      sourceSilo: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      inputVolume: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
      },
      creamVolume: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
      },
      skimVolume: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
      },
      wasteVolume: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },
      wastePercent: {
        type: DataTypes.DECIMAL(5, 2),
        allowNull: true,
      },
      batchStart: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      batchEnd: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // OEM transfer metadata (from separator XFR tags)
      transferName: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      destinations: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      itemId: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      unit: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      targetVolume: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: true,
      },
      nsTransactionId: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
      },
      errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      processedAt: {
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
      tableName: 'MesSeparationBatches',
      timestamps: false,
      indexes: [
        {
          unique: true,
          fields: ['batchId', 'sourceSilo', 'batchEnd'],
          name: 'idx_batch_silo_end',
        },
      ],
    }
  )

  return MesSeparationBatch
}
