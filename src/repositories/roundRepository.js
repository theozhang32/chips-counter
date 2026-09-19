import { fn, col } from 'sequelize';
import { translateDuplicate } from './translateError.js';
import { AppError, E } from '../common/errors.js';

export class RoundRepository {
  constructor(sequelize, { Round }) {
    this.sequelize = sequelize;
    this.Round = Round;
  }

  async findById(id, t) {
    return this.Round.findByPk(id, { transaction: t });
  }

  // INV-3：同游戏同一时刻至多一个进行中的轮次
  async findInProgress(gameId, t) {
    return this.Round.findOne({
      where: { game_id: gameId, status: 'in_progress' },
      order: [['seq', 'DESC']],
      transaction: t,
    });
  }

  async findLatestByGame(gameId, t) {
    return this.Round.findOne({ where: { game_id: gameId }, order: [['seq', 'DESC']], transaction: t });
  }

  async listByGame(gameId) {
    return this.Round.findAll({ where: { game_id: gameId }, order: [['seq', 'ASC']] });
  }

  async nextSeq(gameId, t) {
    const [row] = await this.Round.findAll({
      attributes: [[fn('MAX', col('seq')), 'max_seq']],
      where: { game_id: gameId },
      transaction: t,
    });
    return (row?.get('max_seq') ?? 0) + 1;
  }

  async insert(round, t) {
    try {
      return await this.Round.create(round, { transaction: t });
    } catch (err) {
      translateDuplicate(
        err,
        {
          uniq_game_round_seq: () => new AppError(E.INTERNAL_ERROR, '轮次序号冲突（理论不可达）'),
          'fields:game_id,seq': () => new AppError(E.INTERNAL_ERROR, '轮次序号冲突（理论不可达）'),
        },
        'round.insert'
      );
      throw err;
    }
  }

  async markClosed(id, at, t) {
    await this.Round.update({ status: 'closed', closed_at: at }, { where: { id }, transaction: t });
  }

  async setPool(id, pool, t) {
    await this.Round.update({ pool }, { where: { id }, transaction: t });
  }
}
