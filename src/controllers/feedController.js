import { AppError, E } from '../common/errors.js';
import { parseRoomNo } from '../common/validator.js';

// F1 query：afterId/beforeId（互斥）+ limit（默认 50，最大 200）+ order + actor + type（逗号多选）
const ALLOWED_TYPES = new Set([
  'room_created',
  'setting_changed',
  'host_transferred',
  'room_dissolved',
  'player_joined',
  'player_left',
  'player_returned',
  'game_started',
  'game_rebuilt',
  'round_opened',
  'round_closed',
  'action_bet',
  'action_collect',
  'action_partial_collect',
]);

const parseCursor = (raw, name) => {
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw))
    throw new AppError(E.INVALID_PARAMS, `${name} 需为正整数`, [{ field: name, reason: 'must be a positive integer' }]);
  return Number(raw);
};

export class FeedController {
  constructor({ feedService }) {
    this.feed = feedService;
  }

  list = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    const q = ctx.query;
    const afterId = parseCursor(q.afterId, 'afterId');
    const beforeId = parseCursor(q.beforeId, 'beforeId');
    if (afterId !== undefined && beforeId !== undefined) {
      throw new AppError(E.INVALID_PARAMS, 'afterId 与 beforeId 互斥', [
        { field: 'afterId/beforeId', reason: 'mutually exclusive' },
      ]);
    }
    let limit = 50;
    if (q.limit !== undefined && q.limit !== '') {
      if (!/^\d+$/.test(q.limit))
        throw new AppError(E.INVALID_PARAMS, 'limit 需为正整数', [
          { field: 'limit', reason: 'must be a positive integer' },
        ]);
      limit = Math.min(Number(q.limit), 200);
      if (limit < 1) throw new AppError(E.INVALID_PARAMS, 'limit 需 ≥ 1', [{ field: 'limit', reason: 'must be >= 1' }]);
    }
    const order = q.order === 'asc' ? 'asc' : 'desc';
    let types;
    if (q.type) {
      types = String(q.type)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const bad = types.filter((tp) => !ALLOWED_TYPES.has(tp));
      if (bad.length)
        throw new AppError(E.INVALID_PARAMS, `未知事件类型：${bad.join(',')}`, [
          { field: 'type', reason: `unknown types: ${bad.join(',')}` },
        ]);
    }
    ctx.body = await this.feed.list(roomNo, {
      afterId,
      beforeId,
      limit,
      order,
      actorPlayerId: q.actor || undefined,
      types,
    });
  };
  // F2：GET /rooms/:roomNo/feed/latest —— 游标
  latest = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    ctx.body = { latestEventId: await this.feed.latestId(roomNo) };
  };
}
