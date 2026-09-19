import { AppError, E } from '../common/errors.js';
import { toIso } from '../common/clock.js';

export const serializeFeedEvent = (row) => ({
  id: Number(row.id),
  type: row.type,
  actorPlayerId: row.actor_player_id ?? null,
  actorNickname: row.actor_nickname ?? null,
  payload: typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload,
  createdAt: toIso(row.created_at),
});

// D11：append 必须在调用方事务内调用（同事务写公屏）
export class FeedService {
  constructor({ roomRepository, feedEventRepository }) {
    this.rooms = roomRepository;
    this.feedEvents = feedEventRepository;
  }

  async append(t, roomId, type, actorPlayerId, payload, actorNickname = null) {
    const event = await this.feedEvents.insert(
      { room_id: roomId, type, actor_player_id: actorPlayerId, payload, created_at: new Date() },
      t
    );
    // 广播用 DTO：payload 用原始对象，actorNickname 由调用方传入（其事务内已知晓）
    return {
      id: Number(event.id),
      type,
      actorPlayerId: actorPlayerId ?? null,
      actorNickname,
      payload,
      createdAt: toIso(event.created_at),
    };
  }

  // F1：公屏查询 / 断线补拉（D17：登录即可读）
  async list(roomNo, q) {
    const room = await this.rooms.findByRoomNo(roomNo);
    if (!room) throw new AppError(E.ROOM_NOT_FOUND, '房间不存在');
    const rows = await this.feedEvents.listPage(room.id, q);
    const hasMore = rows.length > q.limit;
    const kept = hasMore ? rows.slice(0, q.limit) : rows;
    const events = kept.map(serializeFeedEvent);
    const nextCursor = events.length ? events[events.length - 1].id : (q.afterId ?? q.beforeId ?? null);
    return { events, hasMore, nextCursor };
  }

  async latestId(roomNo) {
    const room = await this.rooms.findByRoomNo(roomNo);
    if (!room) throw new AppError(E.ROOM_NOT_FOUND, '房间不存在');
    return this.latestIdByRoom(room.id);
  }

  async latestIdByRoom(roomId) {
    return this.feedEvents.latestId(roomId);
  }
}
