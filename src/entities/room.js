import { DataTypes } from 'sequelize';

export const defineRoom = (sq) =>
  sq.define(
    'room',
    {
      id: { type: DataTypes.CHAR(36), primaryKey: true },
      room_no: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      name: { type: DataTypes.STRING(128), allowNull: false },
      host_player_id: { type: DataTypes.STRING(64), allowNull: false },
      base_chips: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
      status: { type: DataTypes.ENUM('active', 'dissolved'), allowNull: false },
      created_at: { type: DataTypes.DATE(3), allowNull: false },
      dissolved_at: { type: DataTypes.DATE(3), allowNull: true },
    },
    { tableName: 'room', timestamps: false, freezeTableName: true }
  );
