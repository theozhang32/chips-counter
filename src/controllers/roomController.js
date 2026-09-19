import { E } from '../common/errors.js';
import { readString, readInt, readBoolean, parseRoomNo } from '../common/validator.js';

export class RoomController {
  constructor({ roomService, gameService, queryService }) {
    this.rooms = roomService;
    this.games = gameService;
    this.query = queryService;
  }

  // R1：POST /rooms —— 建房
  create = async (ctx) => {
    const body = ctx.request.body ?? {};
    const input = {
      name: readString(body, 'name', { optional: true, min: 1, max: 24 }),
      baseChips: readInt(body, 'baseChips', { code: E.BASE_CHIPS_INVALID }),
      nickname: readString(body, 'nickname', { optional: true, min: 1, max: 16, code: E.NICKNAME_INVALID }),
    };
    ctx.status = 201;
    ctx.body = await this.rooms.create(ctx.state.openid, input);
  };

  // R2：POST /rooms/:roomNo/join —— 加入 / 回归
  join = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    const body = ctx.request.body ?? {};
    const nickname = readString(body, 'nickname', { optional: true, min: 1, max: 16, code: E.NICKNAME_INVALID });
    ctx.body = await this.rooms.join(ctx.state.openid, roomNo, { nickname });
  };

  // R3：POST /rooms/:roomNo/leave —— 离开
  leave = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    await this.rooms.leave(ctx.state.openid, roomNo);
    ctx.status = 204;
    ctx.body = null;
  };

  // R4：GET /rooms/:roomNo —— 房间总览（D17：登录即可读）
  getOverview = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    ctx.body = await this.query.overview(roomNo, ctx.state.openid);
  };

  // R5：GET /rooms/:roomNo/leaderboard —— 筹码榜
  getLeaderboard = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    ctx.body = await this.query.leaderboard(roomNo);
  };

  // R6：PUT /rooms/:roomNo/settings/base-chips —— 设置本金（房主）
  updateBaseChips = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    const baseChips = readInt(ctx.request.body ?? {}, 'baseChips', { code: E.BASE_CHIPS_INVALID });
    ctx.body = await this.rooms.setBaseChips(ctx.state.openid, roomNo, baseChips);
  };

  // R7：POST /rooms/:roomNo/host/transfer —— 移交房主（房主）
  transferHost = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    const toMemberId = readString(ctx.request.body ?? {}, 'toMemberId', { min: 1, max: 64 });
    ctx.body = await this.rooms.transferHost(ctx.state.openid, roomNo, toMemberId);
  };

  // R8：POST /rooms/:roomNo/rebuild —— 重建游戏（房主）
  rebuild = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    const confirmPoolLoss = readBoolean(ctx.request.body ?? {}, 'confirmPoolLoss', { optional: true }) ?? false;
    ctx.body = await this.games.rebuild(ctx.state.openid, roomNo, confirmPoolLoss);
  };

  // R9：POST /rooms/:roomNo/dissolve —— 解散（房主）
  dissolve = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    await this.rooms.dissolve(ctx.state.openid, roomNo);
    ctx.status = 204;
    ctx.body = null;
  };
}
