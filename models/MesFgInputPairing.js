module.exports = (sequelize, DataTypes) => {
  const MesFgInputPairing = sequelize.define(
    'MesFgInputPairing',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      // NS internal ID of the FG (surge-tank assembly, e.g. 4498 Kirkland 2%).
      fgItemId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      // NS internal ID of the raw component issued against the FG (e.g.
      // 8344 Raw Kirkland 2%, 8361 Raw Conv Milk 2%, 5415 Raw Conv 1%, etc.).
      rawInputItemId: {
        type: DataTypes.INTEGER,
        allowNull: false,
      },
      // 'approved' — whitelisted, batches proceed silently.
      // 'pending'  — first-time pairing seen at runtime, awaiting human review.
      //              If ops doesn't want this combo, they just leave it pending;
      //              future batches keep landing as pending_review (no blocklist).
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'pending',
      },
      // Free-text label for UI / audit. Optional name of the FG/raw pair if
      // we want quick read in the table without joining to NS item lookups.
      fgName: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      rawInputName: {
        type: DataTypes.STRING(200),
        allowNull: true,
      },
      createdBy: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      decidedBy: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
      decidedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      notes: {
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
      tableName: 'MesFgInputPairings',
      timestamps: false,
      indexes: [
        {
          unique: true,
          fields: ['fgItemId', 'rawInputItemId'],
          name: 'uq_fgpairing_fg_raw',
        },
        {
          fields: ['status'],
          name: 'idx_fgpairing_status',
        },
      ],
    }
  )

  return MesFgInputPairing
}
