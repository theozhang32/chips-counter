import { toDbString } from '../common/clock.js';

const ACTOR_NICKNAME_JOIN = `
  FROM feed_event e
  LEFT JOIN player p ON p.id = e.actor_player_id
  LEFT JOIN room_player rp ON rp.room_id = e.room_id AND rp.player_id = e.actor_player_id`;

export class FeedEventRepository {
  constructor(sequelize, { FeedEvent }) {
    this.sequelize = sequelize;
    this.FeedEvent = FeedEvent;
  }

  async insert(event, t) {
    return this.FeedEvent.create(
      {
        room_id: event.room_id,
        type: event.type,
        actor_player_id: event.actor_player_id ?? null,
        payload: JSON.stringify(event.payload),
        created_at: event.created_at,
      },
      { transaction: t }
    );
  }

  // F1：afterId（正序补拉）/ beforeId（倒序翻页）+ limit + order + actor + type 多选
  // 多取 1 条计算 hasMore；order 已白名单化（asc|desc）后内插
  async listPage(roomId, q) {
    const conditions = ['e.room_id = ?'];
    const params = [roomId];
    if (q.afterId !== undefined) {
      conditions.push('e.id > ?');
      params.push(q.afterId);
    }
    if (q.beforeId !== undefined) {
      conditions.push('e.id < ?');
      params.push(q.beforeId);
    }
    if (q.actorPlayerId) {
      conditions.push('e.actor_player_id = ?');
      params.push(q.actorPlayerId);
    }
    if (q.types?.length) {
      conditions.push(`e.type IN (${q.types.map(() => '?').join(',')})`);
      params.push(...q.types);
    }
    const order = q.order === 'asc' ? 'ASC' : 'DESC';
    const sql = `SELECT e.id, e.type, e.actor_player_id, e.payload, e.created_at,
       COALESCE(rp.nickname, p.nickname) AS actor_nickname
       ${ACTOR_NICKNAME_JOIN}
       WHERE ${conditions.join(' AND ')}
       ORDER BY e.id ${order}
       LIMIT ${Number(q.limit) + 1}`;
    const [rows] = await this.sequelize.query(sql, { replacements: params });
    return rows;
  }

  async latestId(roomId) {
    const [rows] = await this.sequelize.query('SELECT MAX(id) AS max_id FROM feed_event WHERE room_id = ?', {
      replacements: [roomId],
    });
    return Number(rows[0]?.max_id ?? 0);
  }

  // 一致性重算用：房间全量事件（升序）
  async listByRoomAsc(roomId) {
    const [rows] = await this.sequelize.query(
      `SELECT e.id, e.type, e.actor_player_id, e.payload, e.created_at ${ACTOR_NICKNAME_JOIN}
       WHERE e.room_id = ? ORDER BY e.id ASC`,
      { replacements: [roomId] }
    );
    return rows;
  }

  // 幂等复用时回查动作类事件的 payload（含 chipsAfter/poolAfter/newRoundSeq）
  async findActionPayloads(roomId, type, actorPlayerId) {
    const [rows] = await this.sequelize.query(
      `SELECT e.payload FROM feed_event e
       WHERE e.room_id = ? AND e.type = ? AND e.actor_player_id = ?
       ORDER BY e.id DESC LIMIT 500`,
      { replacements: [roomId, type, actorPlayerId] }
    );
    return rows.map((r) => JSON.parse(r.payload));
  }

  async countByRoom(roomId) {
    const [rows] = await this.sequelize.query('SELECT COUNT(*) AS cnt FROM feed_event WHERE room_id = ?', {
      replacements: [roomId],
    });
    return Number(rows[0]?.cnt ?? 0);
  }

  // 测试/运维用：按原始 SQL 直写（篡改模拟等，不走模型层）
  async rawQuery(sql, replacements) {
    return this.sequelize.query(sql, { replacements });
  }

  // 备用：当前时间的 DB 字符串形式
  static nowDbString() {
    return toDbString(new Date());
  }
}
