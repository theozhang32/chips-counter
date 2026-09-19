import { DataTypes } from 'sequelize';

export const defineAction = (sq) =>
  sq.define(
    'action',
    {
      id: { type: DataTypes.CHAR(36), primaryKey: true },
      round_id: { type: DataTypes.CHAR(36), allowNull: false },
      room_player_id: { type: DataTypes.CHAR(36), allowNull: false },
      seq: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      type: { type: DataTypes.ENUM('bet', 'collect', 'partial_collect'), allowNull: false },
      amount: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      is_all_in: { type: DataTypes.TINYINT.UNSIGNED, allowNull: false, defaultValue: 0 },
      idempotency_key: { type: DataTypes.STRING(64), allowNull: true },
      created_at: { type: DataTypes.DATE(3), allowNull: false },
    },
    { tableName: 'action', timestamps: false, freezeTableName: true }
  );
