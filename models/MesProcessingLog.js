module.exports = (sequelize, DataTypes) => {
  const MesProcessingLog = sequelize.define(
    'MesProcessingLog',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      eventType: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      sourceId: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      nsTransactionType: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      nsTransactionId: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      payload: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      result: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      success: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
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
      tableName: 'MesProcessingLog',
      timestamps: false,
    }
  )

  return MesProcessingLog
}
