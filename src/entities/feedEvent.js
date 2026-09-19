import { DataTypes } from 'sequelize';

export const defineFeedEvent = (sq) =>
  sq.define(
    'feed_event',
    {
      id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      room_id: { type: DataTypes.CHAR(36), allowNull: false },
      type: { type: DataTypes.STRING(32), allowNull: false },
      actor_player_id: { type: DataTypes.STRING(64), allowNull: true },
      payload: { type: DataTypes.TEXT, allowNull: false },
      created_at: { type: DataTypes.DATE(3), allowNull: false },
    },
    { tableName: 'feed_event', timestamps: false, freezeTableName: true }
  );
