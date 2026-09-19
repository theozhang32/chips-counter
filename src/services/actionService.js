import { AppError, E } from '../common/errors.js';
import { now } from '../common/clock.js';
import { uuid } from '../common/ids.js';
import { IdempotencyDuplicateSignal } from '../repositories/translateError.js';

// §7.4：四种动作命令共用骨架（统一校验链 → 状态变更 → 同事务公屏 → 提交后广播）
export class ActionService {
  constructor({
    roomRepository,
    roomPlayerRepository,
    gameRepository,
    roundRepository,
    actionRepository,
    feedEventRepository,
    feedService,
    queryService,
    roomQueues,
    logger,
  }) {
    this.rooms = roomRepository;
    this.roomPlayers = roomPlayerRepository;
    this.games = gameRepository;
    this.rounds = roundRepository;
    this.actions = actionRepository;
    this.feedEvents = feedEventRepository;
    this.feed = feedService;
    this.query = queryService;
    this.queues = roomQueues;
    this.logger = logger;
  }

  async #findRoom(roomNo) {
    const room = await this.rooms.findByRoomNo(roomNo);
    if (!room) throw new AppError(E.ROOM_NOT_FOUND, '房间不存在');
    return room;
  }

  // §7.4.1 统一校验链：在场成员 + 房间 active + 游戏/轮次进行中
  async #prepare(t, openid, roomId) {
    const room = await this.rooms.findById(roomId, t);
    if (!room) throw new AppError(E.ROOM_NOT_FOUND, '房间不存在');
    if (room.status !== 'active') throw new AppError(E.ROOM_DISSOLVED, '房间已解散');
    const member = await this.roomPlayers.findByRoomAndPlayer(room.id, openid, t);
    if (!member || member.status !== 'active') throw new AppError(E.NOT_MEMBER, '不是本房间的在场成员');
    const game = await this.games.findInProgress(room.id, t);
    if (!game) {
      this.logger.error('action: active room without in-progress game', { roomId: room.id });
      throw new AppError(E.GAME_NOT_ACTIVE, '房间无进行中的游戏');
    }
    const round = await this.rounds.findInProgress(game.id, t);
    if (!round) {
      this.logger.error('action: in-progress game without in-progress round', { roomId: room.id });
      throw new AppError(E.GAME_NOT_ACTIVE, '游戏无进行中的轮次');
    }
    return { room, member, game, round };
  }

  // §7.4.4 幂等预检：命中且同房间同成员同类型（金额一致——服务端派生金额的动作跳过金额比对）→ 复用上次 ActionAck
  async #tryReplay(key, room, openid, type, clientAmount) {
    if (!key) return null;
    const action = await this.actions.findByIdempotencyKey(key);
    if (!action) return null;
    const sameRoom = action.round?.game?.room_id === room.id;
    const sameMember = action.member?.player_id === openid;
    const sameType = action.type === type;
    const amountMatch = clientAmount === undefined || action.amount === clientAmount;
    if (!(sameRoom && sameMember && sameType && amountMatch)) {
      throw new AppError(E.IDEMPOTENCY_CONFLICT, '幂等键已用于其他请求');
    }
    const replay = await this.#rebuildAck(action);
    if (!replay) throw new AppError(E.IDEMPOTENCY_CONFLICT, '幂等记录不完整');
    return replay;
  }

  // 从 action 行 + 对应公屏事件 payload 还原当时的 ActionAck（chipsAfter/poolAfter/newRoundSeq 在 payload 中）
  async #rebuildAck(action) {
    const payloads = await this.feedEvents.findActionPayloads(
      action.round.game.room_id,
      `action_${action.type}`,
      action.member.player_id
    );
    const match = payloads.find(
      (p) =>
        p.gameSeq === action.round.game.seq &&
        p.roundSeq === action.round.seq &&
        p.actionSeq === action.seq &&
        p.memberId === action.member.id
    );
    return {
      actionId: action.id,
      type: action.type,
      amount: action.amount,
      isAllIn: action.is_all_in === 1,
      chipsAfter: match?.chipsAfter ?? null,
      poolAfter: match?.poolAfter ?? null,
      gameSeq: action.round.game.seq,
      roundSeq: action.round.seq,
      ...(action.type === 'collect' ? { newRoundSeq: match?.newRoundSeq ?? null } : {}),
    };
  }

  #assertPositiveAmount(amount) {
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new AppError(E.AMOUNT_INVALID, '金额必须为正整数');
    }
  }

  // C1：下注（快捷值 / 手动共用；快捷档位不做服务端强校验，§7.4.1）
  async bet(openid, roomNo, amount, key) {
    this.#assertPositiveAmount(amount);
    const room = await this.#findRoom(roomNo);
    try {
      return await this.queues.run(room.id, async (t) => {
        const replay = await this.#tryReplay(key, room, openid, 'bet', amount);
        if (replay) return { reply: replay };
        const { room: rm, member, game, round } = await this.#prepare(t, openid, room.id);
        if (amount > member.chips) {
          throw new AppError(E.BET_EXCEEDS_CHIPS, '下注金额超过当前筹码', { chips: member.chips, amount });
        }
        const isAllIn = amount === member.chips;
        const seq = await this.actions.nextSeq(round.id, t);
        const action = await this.actions.insert(
          {
            id: uuid(),
            round_id: round.id,
            room_player_id: member.id,
            seq,
            type: 'bet',
            amount,
            is_all_in: isAllIn ? 1 : 0,
            idempotency_key: key ?? null,
            created_at: now(),
          },
          t
        );
        const chipsAfter = member.chips - amount;
        const poolAfter = round.pool + amount;
        await this.roomPlayers.setChips(member.id, chipsAfter, t);
        await this.rounds.setPool(round.id, poolAfter, t);
        const event = await this.feed.append(
          t,
          rm.id,
          'action_bet',
          openid,
          {
            gameSeq: game.seq,
            roundSeq: round.seq,
            actionSeq: seq,
            memberId: member.id,
            nickname: member.nickname,
            amount,
            isAllIn,
            chipsAfter,
            poolAfter,
          },
          member.nickname
        );
        const snapshot = await this.query.snapshot(rm.id, t);
        return {
          reply: {
            actionId: action.id,
            type: 'bet',
            amount,
            isAllIn,
            chipsAfter,
            poolAfter,
            gameSeq: game.seq,
            roundSeq: round.seq,
          },
          broadcast: { events: [event], snapshot },
        };
      });
    } catch (err) {
      if (err instanceof IdempotencyDuplicateSignal)
        return this.#resolveDuplicateKey(err.key, room, openid, 'bet', amount);
      throw err;
    }
  }

  // C2：全下（金额由服务端取当前筹码）
  async allIn(openid, roomNo, key) {
    const room = await this.#findRoom(roomNo);
    try {
      return await this.queues.run(room.id, async (t) => {
        const replay = await this.#tryReplay(key, room, openid, 'bet', undefined);
        if (replay) return { reply: replay };
        const { room: rm, member, game, round } = await this.#prepare(t, openid, room.id);
        const amount = member.chips;
        if (amount <= 0) throw new AppError(E.BET_EXCEEDS_CHIPS, '当前无筹码可下注', { chips: 0 });
        const seq = await this.actions.nextSeq(round.id, t);
        const action = await this.actions.insert(
          {
            id: uuid(),
            round_id: round.id,
            room_player_id: member.id,
            seq,
            type: 'bet',
            amount,
            is_all_in: 1,
            idempotency_key: key ?? null,
            created_at: now(),
          },
          t
        );
        const chipsAfter = 0;
        const poolAfter = round.pool + amount;
        await this.roomPlayers.setChips(member.id, chipsAfter, t);
        await this.rounds.setPool(round.id, poolAfter, t);
        const event = await this.feed.append(
          t,
          rm.id,
          'action_bet',
          openid,
          {
            gameSeq: game.seq,
            roundSeq: round.seq,
            actionSeq: seq,
            memberId: member.id,
            nickname: member.nickname,
            amount,
            isAllIn: true,
            chipsAfter,
            poolAfter,
          },
          member.nickname
        );
        const snapshot = await this.query.snapshot(rm.id, t);
        return {
          reply: {
            actionId: action.id,
            type: 'bet',
            amount,
            isAllIn: true,
            chipsAfter,
            poolAfter,
            gameSeq: game.seq,
            roundSeq: round.seq,
          },
          broadcast: { events: [event], snapshot },
        };
      });
    } catch (err) {
      if (err instanceof IdempotencyDuplicateSignal)
        return this.#resolveDuplicateKey(err.key, room, openid, 'bet', undefined);
      throw err;
    }
  }

  // C3：收池（自动换轮，INV-6：收池、旧轮关闭、新轮开启同一事务）
  async collect(openid, roomNo, key) {
    const room = await this.#findRoom(roomNo);
    try {
      return await this.queues.run(room.id, async (t) => {
        const replay = await this.#tryReplay(key, room, openid, 'collect', undefined);
        if (replay) return { reply: replay };
        const { room: rm, member, game, round } = await this.#prepare(t, openid, room.id);
        const amount = round.pool;
        if (amount <= 0) throw new AppError(E.POOL_EMPTY, '当前筹码池为 0');

        const at = now();
        const seq = await this.actions.nextSeq(round.id, t);
        const action = await this.actions.insert(
          {
            id: uuid(),
            round_id: round.id,
            room_player_id: member.id,
            seq,
            type: 'collect',
            amount,
            is_all_in: 0,
            idempotency_key: key ?? null,
            created_at: at,
          },
          t
        );
        const chipsAfter = member.chips + amount;
        await this.roomPlayers.setChips(member.id, chipsAfter, t);
        await this.rounds.setPool(round.id, 0, t);
        await this.rounds.markClosed(round.id, at, t);
        const newRoundSeq = await this.rounds.nextSeq(game.id, t);
        await this.rounds.insert(
          {
            id: uuid(),
            game_id: game.id,
            seq: newRoundSeq,
            status: 'in_progress',
            pool: 0,
            opened_at: at,
            closed_at: null,
          },
          t
        );
        const events = [
          await this.feed.append(
            t,
            rm.id,
            'action_collect',
            openid,
            {
              gameSeq: game.seq,
              roundSeq: round.seq,
              actionSeq: seq,
              memberId: member.id,
              nickname: member.nickname,
              amount,
              chipsAfter,
              poolAfter: 0,
              newRoundSeq,
            },
            member.nickname
          ),
          await this.feed.append(
            t,
            rm.id,
            'round_closed',
            openid,
            { gameSeq: game.seq, roundSeq: round.seq, finalPool: 0 },
            member.nickname
          ),
          await this.feed.append(
            t,
            rm.id,
            'round_opened',
            openid,
            { gameSeq: game.seq, roundSeq: newRoundSeq },
            member.nickname
          ),
        ];
        const snapshot = await this.query.snapshot(rm.id, t);
        return {
          reply: {
            actionId: action.id,
            type: 'collect',
            amount,
            isAllIn: false,
            chipsAfter,
            poolAfter: 0,
            gameSeq: game.seq,
            roundSeq: round.seq,
            newRoundSeq,
          },
          broadcast: { events, snapshot },
        };
      });
    } catch (err) {
      if (err instanceof IdempotencyDuplicateSignal)
        return this.#resolveDuplicateKey(err.key, room, openid, 'collect', undefined);
      throw err;
    }
  }

  // C4：部分收注（0 < amount < pool，本轮继续）
  async partialCollect(openid, roomNo, amount, key) {
    this.#assertPositiveAmount(amount);
    const room = await this.#findRoom(roomNo);
    try {
      return await this.queues.run(room.id, async (t) => {
        const replay = await this.#tryReplay(key, room, openid, 'partial_collect', amount);
        if (replay) return { reply: replay };
        const { room: rm, member, game, round } = await this.#prepare(t, openid, room.id);
        if (amount >= round.pool) {
          throw new AppError(E.PARTIAL_GE_POOL, '部分收注金额须小于当前池（等于整池请使用收池）', { pool: round.pool });
        }
        const seq = await this.actions.nextSeq(round.id, t);
        const action = await this.actions.insert(
          {
            id: uuid(),
            round_id: round.id,
            room_player_id: member.id,
            seq,
            type: 'partial_collect',
            amount,
            is_all_in: 0,
            idempotency_key: key ?? null,
            created_at: now(),
          },
          t
        );
        const chipsAfter = member.chips + amount;
        const poolAfter = round.pool - amount;
        await this.roomPlayers.setChips(member.id, chipsAfter, t);
        await this.rounds.setPool(round.id, poolAfter, t);
        const event = await this.feed.append(
          t,
          rm.id,
          'action_partial_collect',
          openid,
          {
            gameSeq: game.seq,
            roundSeq: round.seq,
            actionSeq: seq,
            memberId: member.id,
            nickname: member.nickname,
            amount,
            chipsAfter,
            poolAfter,
          },
          member.nickname
        );
        const snapshot = await this.query.snapshot(rm.id, t);
        return {
          reply: {
            actionId: action.id,
            type: 'partial_collect',
            amount,
            isAllIn: false,
            chipsAfter,
            poolAfter,
            gameSeq: game.seq,
            roundSeq: round.seq,
          },
          broadcast: { events: [event], snapshot },
        };
      });
    } catch (err) {
      if (err instanceof IdempotencyDuplicateSignal)
        return this.#resolveDuplicateKey(err.key, room, openid, 'partial_collect', amount);
      throw err;
    }
  }

  // 并发双击兜底：唯一索引冲突 → 事务已回滚 → 回查首次结果复用；内容不符则冲突（§7.4.4）
  async #resolveDuplicateKey(key, room, openid, type, clientAmount) {
    const replay = await this.#tryReplay(key, room, openid, type, clientAmount).catch((err) => {
      if (err instanceof AppError && err.code === E.IDEMPOTENCY_CONFLICT) return null;
      throw err;
    });
    if (replay) return replay;
    throw new AppError(E.IDEMPOTENCY_CONFLICT, '幂等键已用于其他请求');
  }
}
