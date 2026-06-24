module.exports = (sequelize, DataTypes) => {
  const MesSurgeTankIssueState = sequelize.define(
    'MesSurgeTankIssueState',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      surgeTankBatchId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      uhtId: {
        type: DataTypes.STRING(20),
        allowNull: false,
      },
      // The UHT software totalizer value (gallons) at the moment of the last
      // successfully-fired NS issue. Next tick's delta = current - this.
      lastIssuedUhtGal: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },
      lastIssueAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Most-recent totalizer observation regardless of whether an issue fired
      // — used by the dashboard to show live throughput and by restart recovery.
      lastTotalizerGal: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
      },
      lastObservedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Snapshots of feeding source at last observation — gives restart-recovery
      // enough context to resolve the component without re-reading the historian.
      lastFromEntName: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      lastProductName: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      createdAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'MesSurgeTankIssueStates',
      timestamps: false,
      indexes: [
        {
          fields: ['surgeTankBatchId', 'uhtId'],
          name: 'idx_surgetank_issue_batch_uht',
          unique: true,
        },
      ],
    }
  )

  return MesSurgeTankIssueState
}
