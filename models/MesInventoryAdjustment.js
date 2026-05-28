module.exports = (sequelize, DataTypes) => {
  const MesInventoryAdjustment = sequelize.define(
    'MesInventoryAdjustment',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      // 'sweep'     = posted by the 5-min tank-at-rest reconciliation job.
      // 'shortfall' = posted inline when a WO issue / assembly unbuild caller
      //               hit insufficient inventory and we bumped the source bin
      //               up by exactly the shortfall before retrying.
      source: {
        type: DataTypes.STRING(20),
        allowNull: false,
      },
      tankName: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      binId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      itemId: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      // Signed delta in lbs (positive = adjust up, negative = adjust down).
      qtyDelta: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
      },
      // Observed 5-min avg and NS on-hand at adjustment time. Null on shortfall
      // rows where we didn't read the tank — only the shortfall number matters.
      observedLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
      },
      nsQtyBefore: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
      },
      lotId: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      lotName: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      nsAdjustmentId: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      memo: {
        type: DataTypes.STRING(500),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'submitted',
      },
      errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'MesInventoryAdjustments',
      timestamps: false,
      indexes: [
        {
          fields: ['source', 'createdAt'],
          name: 'idx_invadjust_source_created',
        },
        {
          fields: ['binId', 'itemId'],
          name: 'idx_invadjust_bin_item',
        },
      ],
    }
  )

  return MesInventoryAdjustment
}
