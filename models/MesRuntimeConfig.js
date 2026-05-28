module.exports = (sequelize, DataTypes) => {
  const MesRuntimeConfig = sequelize.define(
    'MesRuntimeConfig',
    {
      // Single-row table — id is fixed at 1 by application logic.
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
      },
      // Master switch. When true, the backend runs HistoricalProvider + sim
      // clock + accelerated CRONs. When false, baseProviderType (rest/mock)
      // and the env CRONs are in effect.
      replayMode: {
        type: DataTypes.BOOLEAN,
        allowNull: false,
        defaultValue: false,
      },
      // ISO timestamp where the sim clock starts ticking from when replay is
      // enabled. Null until set via the UI.
      simStart: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      // Sim clock multiplier vs wall clock. 60 = 1 wall-second per sim-minute.
      speedup: {
        type: DataTypes.INTEGER,
        allowNull: false,
        defaultValue: 60,
      },
      // JSON object with the six CRON expressions applied while replay mode
      // is ON. Stored as text since MSSQL doesn't have a native JSON column.
      // Shape: { separation, bulkMilk, blendTank, surgeTank, equipment, tick }
      replayCronsJson: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'MesRuntimeConfig',
      timestamps: false,
    }
  )

  return MesRuntimeConfig
}
