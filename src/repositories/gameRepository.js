import { fn, col } from 'sequelize';
import { translateDuplicate } from './translateError.js';
import { AppError, E } from '../common/errors.js';

export class GameRepository {
  constructor(sequelize, { Game }) {
    this.sequelize = sequelize;
    this.Game = Game;
  }

  async findById(id, t) {
    return this.Game.findByPk(id, { transaction: t });
  }

  // INV-3：同房间同一时刻至多一个进行中的游戏
  async findInProgress(roomId, t) {
    return this.Game.findOne({
      where: { room_id: roomId, status: 'in_progress' },
      order: [['seq', 'DESC']],
      transaction: t,
    });
  }

  async findLatestByRoom(roomId, t) {
    return this.Game.findOne({ where: { room_id: roomId }, order: [['seq', 'DESC']], transaction: t });
  }

  async listByRoom(roomId) {
    return this.Game.findAll({ where: { room_id: roomId }, order: [['seq', 'ASC']] });
  }

  // seq = max+1（房间队列串行下安全，D3）
  async nextSeq(roomId, t) {
    const [row] = await this.Game.findAll({
      attributes: [[fn('MAX', col('seq')), 'max_seq']],
      where: { room_id: roomId },
      transaction: t,
    });
    return (row?.get('max_seq') ?? 0) + 1;
  }

  async insert(game, t) {
    try {
      return await this.Game.create(game, { transaction: t });
    } catch (err) {
      translateDuplicate(
        err,
        {
          uniq_room_game_seq: () => new AppError(E.INTERNAL_ERROR, '游戏序号冲突（理论不可达）'),
          'fields:room_id,seq': () => new AppError(E.INTERNAL_ERROR, '游戏序号冲突（理论不可达）'),
        },
        'game.insert'
      );
      throw err;
    }
  }

  async markEnded(id, at, t) {
    await this.Game.update({ status: 'ended', ended_at: at }, { where: { id }, transaction: t });
  }

  async addIssued(gameId, delta, t) {
    await this.Game.increment({ issued_chips: delta }, { where: { id: gameId }, transaction: t });
  }

  async setIssued(gameId, issued, t) {
    await this.Game.update({ issued_chips: issued }, { where: { id: gameId }, transaction: t });
  }
}
