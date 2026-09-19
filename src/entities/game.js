import { DataTypes } from 'sequelize';

export const defineGame = (sq) =>
  sq.define(
    'game',
    {
      id: { type: DataTypes.CHAR(36), primaryKey: true },
      room_id: { type: DataTypes.CHAR(36), allowNull: false },
      seq: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      status: { type: DataTypes.ENUM('in_progress', 'ended'), allowNull: false },
      issued_chips: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      started_at: { type: DataTypes.DATE(3), allowNull: false },
      ended_at: { type: DataTypes.DATE(3), allowNull: true },
    },
    { tableName: 'game', timestamps: false, freezeTableName: true }
  );
