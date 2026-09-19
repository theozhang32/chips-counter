import { randomInt } from 'node:crypto';
import { toDbString } from '../common/clock.js';

const toUtcDate = (v) => (v instanceof Date ? v : new Date(`${String(v).replace(' ', 'T')}Z`));

export class PlayerRepository {
  constructor(sequelize, { Player }) {
    this.sequelize = sequelize;
    this.Player = Player;
  }

  async findById(id, t) {
    return this.Player.findByPk(id, { transaction: t });
  }

  // 首次注册：默认昵称"玩家+4 位随机"（§7.1）。
  // 用 FOR UPDATE 锁定读（读最新已提交版本）判定存在性——REPEATABLE READ 下，
  // 并发事务 INSERT ... ON DUPLICATE KEY 更新过的行对同事务的普通 SELECT（快照读）不可见。
  async findOrCreate(id, t) {
    const lockRead = () =>
      this.sequelize.query('SELECT id, nickname, created_at FROM player WHERE id = ? FOR UPDATE', {
        replacements: [id],
        transaction: t,
      });
    let [rows] = await lockRead();
    if (rows.length) return { ...rows[0], created_at: toUtcDate(rows[0].created_at) };

    const nickname = `玩家${Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('')}`;
    const createdAt = new Date();
    await this.sequelize.query(
      'INSERT INTO player (id, nickname, created_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE id = id',
      { replacements: [id, nickname, toDbString(createdAt)], transaction: t }
    );
    [rows] = await lockRead();
    return { ...rows[0], created_at: toUtcDate(rows[0].created_at) };
  }

  async updateNickname(id, nickname, t) {
    await this.Player.update({ nickname }, { where: { id }, transaction: t });
  }
}
