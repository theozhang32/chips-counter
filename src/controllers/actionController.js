import { E } from '../common/errors.js';
import { readInt, readString, parseRoomNo } from '../common/validator.js';

const readIdempotencyKey = (body) => readString(body, 'idempotencyKey', { optional: true, min: 8, max: 64 });

export class ActionController {
  constructor({ actionService }) {
    this.actions = actionService;
  }

  // C1：POST /rooms/:roomNo/actions/bet
  bet = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    const body = ctx.request.body ?? {};
    const amount = readInt(body, 'amount', { code: E.AMOUNT_INVALID });
    const idempotencyKey = readIdempotencyKey(body);
    ctx.body = await this.actions.bet(ctx.state.openid, roomNo, amount, idempotencyKey);
  };

  // C2：POST /rooms/:roomNo/actions/all-in（金额由服务端取当前筹码）
  allIn = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    const idempotencyKey = readIdempotencyKey(ctx.request.body ?? {});
    ctx.body = await this.actions.allIn(ctx.state.openid, roomNo, idempotencyKey);
  };

  // C3：POST /rooms/:roomNo/actions/collect（自动换轮）
  collect = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    const idempotencyKey = readIdempotencyKey(ctx.request.body ?? {});
    ctx.body = await this.actions.collect(ctx.state.openid, roomNo, idempotencyKey);
  };

  // C4：POST /rooms/:roomNo/actions/partial-collect
  partialCollect = async (ctx) => {
    const roomNo = parseRoomNo(ctx.params.roomNo);
    const body = ctx.request.body ?? {};
    const amount = readInt(body, 'amount', { code: E.AMOUNT_INVALID });
    const idempotencyKey = readIdempotencyKey(body);
    ctx.body = await this.actions.partialCollect(ctx.state.openid, roomNo, amount, idempotencyKey);
  };
}
