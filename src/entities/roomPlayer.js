import { DataTypes } from 'sequelize';

// 生成列 active_player_key 不映射、不写入（§3.4）
export const defineRoomPlayer = (sq) =>
  sq.define(
    'room_player',
    {
      id: { type: DataTypes.CHAR(36), primaryKey: true },
      room_id: { type: DataTypes.CHAR(36), allowNull: false },
      player_id: { type: DataTypes.STRING(64), allowNull: false },
      nickname: { type: DataTypes.STRING(64), allowNull: false },
      chips: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      status: { type: DataTypes.ENUM('active', 'left'), allowNull: false },
      joined_at: { type: DataTypes.DATE(3), allowNull: false },
      left_at: { type: DataTypes.DATE(3), allowNull: true },
    },
    { tableName: 'room_player', timestamps: false, freezeTableName: true }
  );
