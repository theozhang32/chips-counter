import { DataTypes } from 'sequelize';

export const defineRound = (sq) =>
  sq.define(
    'round',
    {
      id: { type: DataTypes.CHAR(36), primaryKey: true },
      game_id: { type: DataTypes.CHAR(36), allowNull: false },
      seq: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      status: { type: DataTypes.ENUM('in_progress', 'closed'), allowNull: false },
      pool: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      opened_at: { type: DataTypes.DATE(3), allowNull: false },
      closed_at: { type: DataTypes.DATE(3), allowNull: true },
    },
    { tableName: 'round', timestamps: false, freezeTableName: true }
  );
