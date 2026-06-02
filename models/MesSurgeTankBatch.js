module.exports = (sequelize, DataTypes) => {
  const MesSurgeTankBatch = sequelize.define(
    'MesSurgeTankBatch',
    {
      id: {
        type: DataTypes.INTEGER,
        primaryKey: true,
        autoIncrement: true,
      },
      tankId: {
        type: DataTypes.STRING(50),
        allowNull: false,
      },
      productName: {
        type: DataTypes.STRING(200),
        allowNull: false,
      },
      mesItem: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      // UHT feeding this surge tank. The UHT-inflow software totalizer lives on
      // restProvider._uhtMilkGal[uhtId] — we track which UHT to read per batch.
      feedingUhtId: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      // Source entity feeding the UHT — either a silo (MSilo*/CSilo*) or a
      // blend tank (BlendTank*). Drives component resolution + issue source bin.
      feedingFromEntName: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      // Layer-3 component pinned at WO-create by resolveLayer3Component. The
      // surge WO is built with this as its sole custom component, so every
      // tick issues against the same NS item without re-resolving.
      componentItemId: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      componentBinId: {
        type: DataTypes.INTEGER,
        allowNull: true,
      },
      // 'blend-tank' | 'silo-line-product' | 'silo-bulk-fallback'
      // (canonical vs non-canonical is now tracked via MesFgInputPairings, not
      // baked into this column — see pairingStatus.)
      componentResolvedFrom: {
        type: DataTypes.STRING(40),
        allowNull: true,
      },
      // null = canonical 3-layer flow.
      // 'layer-2-skip'         = Layer 1 ran (post-separator component), Layer 2 bypassed.
      // 'layer-1-and-2-skip'   = bulk raw milk piped straight to UHT.
      layerSkipReason: {
        type: DataTypes.STRING(30),
        allowNull: true,
      },
      // 'ok'             = (fgItemId, componentItemId) pairing is approved in MesFgInputPairings.
      // 'pending_review' = pairing is unknown or pending; UI surfaces it for ops to approve.
      // null             = legacy batches predating the pairing flow.
      pairingStatus: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      parserConfidence: {
        type: DataTypes.STRING(20),
        allowNull: true,
      },
      nsWorkOrderId: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      nsWorkOrderNumber: {
        type: DataTypes.STRING(50),
        allowNull: true,
      },
      status: {
        type: DataTypes.STRING(20),
        allowNull: false,
        defaultValue: 'active',
      },
      errorMessage: {
        type: DataTypes.TEXT,
        allowNull: true,
      },
      detectedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      completedAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      cumulativeIssuedLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },
      cumulativeCompletedLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },
      // Measured mass that REACHED this tank (surge level rise ×8.6, summed).
      // Drives workOrderCompletion; cumulativeIssued − cumulativeOutput = waste
      // (the UHT-leg loss between FT1102 inlet and the surge tank).
      cumulativeOutputLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: false,
        defaultValue: 0,
      },
      // Last destination-level reading (lbs) used as the arrival baseline.
      lastDestLevelLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
      },
      // Computed at batch close: issued − output (lbs) and as a % of issued.
      wasteLbs: {
        type: DataTypes.DECIMAL(14, 2),
        allowNull: true,
      },
      wastePercent: {
        type: DataTypes.DECIMAL(8, 2),
        allowNull: true,
      },
      lastIssueAt: {
        type: DataTypes.DATE,
        allowNull: true,
      },
      lastCompletionAt: {
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
      tableName: 'MesSurgeTankBatches',
      timestamps: false,
      indexes: [
        {
          fields: ['tankId', 'productName', 'status'],
          name: 'idx_surgetank_tank_product_status',
        },
      ],
    }
  )

  return MesSurgeTankBatch
}
