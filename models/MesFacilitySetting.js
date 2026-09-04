module.exports = (sequelize, DataTypes) => {
  // Key/value JSON settings for the facility map (admin assignments etc.).
  // Table name is env-prefixed by the beforeDefine hook in config/index.js.
  const MesFacilitySetting = sequelize.define(
    'MesFacilitySetting',
    {
      key: {
        type: DataTypes.STRING(100),
        primaryKey: true,
      },
      // JSON stored as text — MSSQL has no native JSON column.
      valueJson: {
        type: DataTypes.TEXT,
        allowNull: false,
      },
      updatedAt: {
        type: DataTypes.DATE,
        allowNull: false,
        defaultValue: DataTypes.NOW,
      },
    },
    {
      tableName: 'MesFacilitySettings',
      timestamps: false,
    }
  )
  return MesFacilitySetting
}
