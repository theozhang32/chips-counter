import { DataTypes } from 'sequelize';

// §3.4：属性名 = 列名；timestamps: false，*_at 由 service 显式赋值
export const definePlayer = (sq) =>
  sq.define(
    'player',
    {
      id: { type: DataTypes.STRING(64), primaryKey: true },
      nickname: { type: DataTypes.STRING(64), allowNull: false },
      created_at: { type: DataTypes.DATE(3), allowNull: false },
    },
    { tableName: 'player', timestamps: false, freezeTableName: true }
  );
