module.exports = (sequelize, DataTypes) => {
  const MesBulkMilkRun = sequelize.define(
    'MesBulkMilkRun',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      workOrderId: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      workOrderNumber: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active',
      },
      cumulativeCream: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },
      cumulativeSkim: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
        defaultValue: 0,
      },
      registeredBy: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      registeredAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
    },
    {
      tableName: 'MesBulkMilkRuns',
      timestamps: false,
    }
  )

  return MesBulkMilkRun
}
