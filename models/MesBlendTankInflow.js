module.exports = (sequelize, DataTypes) => {
  const MesBlendTankInflow = sequelize.define(
    'MesBlendTankInflow',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      blendTankBatchId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      line: {
        type: DataTypes.STRING(10),
        allowNull: false,
      },
      ingredientType: {
        type: DataTypes.STRING(100),
        allowNull: false,
      },
      totalLbs: {
        type: DataTypes.DECIMAL(12, 2),
        allowNull: false,
      },
      nsItemId: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      nsIssueId: {
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
      resetTime: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      destination: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      siloName: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'MesBlendTankInflows',
      timestamps: false,
    }
  )

  return MesBlendTankInflow
}
