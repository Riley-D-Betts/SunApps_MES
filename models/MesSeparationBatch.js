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
      // Reason the state machine closed the batch (one of:
      // transfer_complete, source_changed, destination_changed,
      // product_index_changed, cip_started, idle_rpm, idle_feedpermit).
      // Null while status='running'.
      endReason: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      // Snapshots taken at each tick — let us detect boundary changes by
      // comparing the previous tick's value to the current one. Updated
      // every tick while batch is open. Cleared on close.
      prevSourceSilo: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      prevDestinationsJson: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      prevIndexCodesJson: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      // Last per-tick observation timestamp. lastTickAt vs createdAt tells us
      // batch lifetime; lastTickAt vs now() on restart tells us how stale the
      // open row is.
      lastTickAt: {
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
