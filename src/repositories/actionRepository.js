import { fn, col } from 'sequelize';
import { translateDuplicate, isUniqueViolation, duplicateIndex, IdempotencyDuplicateSignal } from './translateError.js';
import { AppError, E } from '../common/errors.js';

export class ActionRepository {
  constructor(sequelize, { Action }) {
    this.sequelize = sequelize;
    this.Action = Action;
  }

  async insert(action, t) {
    try {
      return await this.Action.create(action, { transaction: t });
    } catch (err) {
      if (isUniqueViolation(err) && duplicateIndex(err) === 'uniq_action_idempotency') {
        // 并发双击同 key：抛信号给 service 回查复用首次结果（§7.4.4）
        throw new IdempotencyDuplicateSignal(action.idempotency_key);
      }
      translateDuplicate(
        err,
        {
          uniq_round_action_seq: () => new AppError(E.INTERNAL_ERROR, '动作序号冲突（理论不可达）'),
          'fields:round_id,seq': () => new AppError(E.INTERNAL_ERROR, '动作序号冲突（理论不可达）'),
        },
        'action.insert'
      );
      throw err;
    }
  }

  async nextSeq(roundId, t) {
    const [row] = await this.Action.findAll({
      attributes: [[fn('MAX', col('seq')), 'max_seq']],
      where: { round_id: roundId },
      transaction: t,
    });
    return (row?.get('max_seq') ?? 0) + 1;
  }

  // 含所属轮次/游戏上下文（game_seq、room_id）与成员归属，供幂等复用判定
  async findByIdempotencyKey(key) {
    return this.Action.findOne({
      where: { idempotency_key: key },
      include: [
        {
          association: 'round',
          attributes: ['id', 'seq', 'game_id'],
          include: [{ association: 'game', attributes: ['id', 'seq', 'room_id'] }],
        },
        { association: 'member', attributes: ['id', 'room_id', 'player_id'] },
      ],
    });
  }

  async listByRound(roundId, t) {
    return this.Action.findAll({ where: { round_id: roundId }, order: [['seq', 'ASC']], transaction: t });
  }

  // 一致性重算用：房间全量动作流水（升序，附 game_seq / round_seq / room_id）
  async listByRoomAsc(roomId) {
    const [rows] = await this.sequelize.query(
      `SELECT a.id, a.round_id, a.room_player_id, a.seq, a.type, a.amount, a.is_all_in, a.idempotency_key, a.created_at,
              r.seq AS round_seq, g.seq AS game_seq, g.room_id AS room_id
       FROM action a
       JOIN round r ON a.round_id = r.id
       JOIN game g ON r.game_id = g.id
       WHERE g.room_id = ?
       ORDER BY g.seq ASC, r.seq ASC, a.seq ASC`,
      { replacements: [roomId] }
    );
    return rows;
  }

  async countByRoom(roomId) {
    const [rows] = await this.sequelize.query(
      `SELECT COUNT(*) AS cnt FROM action a JOIN round r ON a.round_id = r.id JOIN game g ON r.game_id = g.id WHERE g.room_id = ?`,
      { replacements: [roomId] }
    );
    return Number(rows[0]?.cnt ?? 0);
  }
}
