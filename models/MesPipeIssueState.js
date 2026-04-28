module.exports = (sequelize, DataTypes) => {
  const MesPipeIssueState = sequelize.define(
    'MesPipeIssueState',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      blendTankBatchId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      line: {
        type: DataTypes.STRING(10),
        allowNull: false,
      },
      lastIssuedTotalizerLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },
      lastIssueAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      lastFlowRateGpm: {
        type: DataTypes.DECIMAL(10, 2),
        allowNull: true,
      },
      lastTotalizerLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
      },
      lastObservedAt: {
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
      tableName: 'MesPipeIssueStates',
      timestamps: false,
      indexes: [
        {
          fields: ['blendTankBatchId', 'line'],
          name: 'idx_pipeissue_batch_line',
          unique: true,
        },
      ],
    }
  )

  return MesPipeIssueState
}
