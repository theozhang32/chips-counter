import { AppError, E } from '../common/errors.js';
import { now } from '../common/clock.js';
import { uuid } from '../common/ids.js';
import { PRESET_BASE_CHIPS, quickBets } from '../common/quickBets.js';

export class RoomService {
  constructor({
    roomRepository,
    roomPlayerRepository,
    gameRepository,
    roundRepository,
    playerRepository,
    feedService,
    queryService,
    roomQueues,
    logger,
  }) {
    this.rooms = roomRepository;
    this.roomPlayers = roomPlayerRepository;
    this.games = gameRepository;
    this.rounds = roundRepository;
    this.players = playerRepository;
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

  // 闭包内重读房间并校验 active（解散竞态收口）
  async #activeRoomInTx(roomId, t) {
    const room = await this.rooms.findById(roomId, t);
    if (!room) throw new AppError(E.ROOM_NOT_FOUND, '房间不存在');
    if (room.status !== 'active') throw new AppError(E.ROOM_DISSOLVED, '房间已解散');
    return room;
  }

  // R1：建房（§7.2；只与新房间自身数据交互，无跨房间共享状态——经以新房 id 为键的空队列执行，等价单事务）
  async create(openid, { name, baseChips, nickname }) {
    if (!PRESET_BASE_CHIPS.includes(baseChips)) {
      throw new AppError(E.BASE_CHIPS_INVALID, '本金必须是预设值（100/200/400/500/800/1000）');
    }
    const player = await this.players.findOrCreate(openid);
    const roomNickname = nickname ?? player.nickname;
    const roomName = name ?? `${roomNickname}的房间`;
    const createdAt = now();
    const roomId = uuid();

    return this.queues.run(roomId, async (t) => {
      // INV-7 前置检查（player 注册已由入口 ensurePlayer 完成）；并发竞态由 uniq_room_player_active 兜底
      const active = await this.roomPlayers.findActiveByPlayer(openid, t);
      if (active) throw new AppError(E.ALREADY_IN_ROOM, '已在某个房间中（一人一房间）');

      const room = await this.rooms.insertWithRoomNoRetry(
        (roomNo) => ({
          id: roomId,
          room_no: roomNo,
          name: roomName,
          host_player_id: openid,
          base_chips: baseChips,
          status: 'active',
          created_at: createdAt,
          dissolved_at: null,
        }),
        t
      );

      const member = await this.roomPlayers.insert(
        {
          id: uuid(),
          room_id: room.id,
          player_id: openid,
          nickname: roomNickname,
          chips: baseChips,
          status: 'active',
          joined_at: createdAt,
          left_at: null,
        },
        t
      );
      // 建房即自动开局（FR-201/301）
      const game = await this.games.insert(
        {
          id: uuid(),
          room_id: room.id,
          seq: 1,
          status: 'in_progress',
          issued_chips: baseChips,
          started_at: createdAt,
          ended_at: null,
        },
        t
      );
      await this.rounds.insert(
        { id: uuid(), game_id: game.id, seq: 1, status: 'in_progress', pool: 0, opened_at: createdAt, closed_at: null },
        t
      );

      const events = [
        await this.feed.append(
          t,
          room.id,
          'room_created',
          openid,
          { roomName, baseChips, hostNickname: roomNickname },
          roomNickname
        ),
        await this.feed.append(
          t,
          room.id,
          'game_started',
          openid,
          { gameSeq: 1, baseChips, issuedChips: baseChips, members: [{ memberId: member.id, chips: baseChips }] },
          roomNickname
        ),
        await this.feed.append(t, room.id, 'round_opened', openid, { gameSeq: 1, roundSeq: 1 }, roomNickname),
      ];
      const snapshot = await this.query.snapshot(room.id, t);
      const reply = await this.query.overviewFor(room, openid, t);
      return { reply, broadcast: { events, snapshot } };
    });
  }

  // R2：加入 / 回归（同一端点，§7.3）
  async join(openid, roomNo, { nickname } = {}) {
    const room0 = await this.#findRoom(roomNo);
    // player 注册在房间事务外完成（独立小事务即刻提交）——避免跨房间并发加入时
    // 在同一行上的注册写与房间事务长锁交叉，触发缺口锁死锁（§3.5 并发说明）
    const player = await this.players.findOrCreate(openid);
    return this.queues.run(room0.id, async (t) => {
      const room = await this.#activeRoomInTx(room0.id, t);
      const active = await this.roomPlayers.findActiveByPlayer(openid, t);
      if (active) throw new AppError(E.ALREADY_IN_ROOM, '已在某个房间中（一人一房间）');

      const game = await this.games.findInProgress(room.id, t);
      if (!game) throw new AppError(E.GAME_NOT_ACTIVE, '房间无进行中的游戏');

      const existing = await this.roomPlayers.findByRoomAndPlayer(room.id, openid, t);
      const events = [];
      if (!existing) {
        const memberNickname = nickname ?? player.nickname;
        const member = await this.roomPlayers.insert(
          {
            id: uuid(),
            room_id: room.id,
            player_id: openid,
            nickname: memberNickname,
            chips: room.base_chips,
            status: 'active',
            joined_at: now(),
            left_at: null,
          },
          t
        );
        await this.games.addIssued(game.id, room.base_chips, t);
        events.push(
          await this.feed.append(
            t,
            room.id,
            'player_joined',
            openid,
            { memberId: member.id, nickname: memberNickname, chipsIssued: room.base_chips },
            memberNickname
          )
        );
      } else {
        // 回归：昵称可顺带修改（占用则 NICKNAME_TAKEN）
        let memberNickname = existing.nickname;
        if (nickname && nickname !== existing.nickname) {
          await this.roomPlayers.updateNickname(existing.id, nickname, t);
          memberNickname = nickname;
        }
        // D20：当前游戏 started_at > left_at → 按本金重发并计入 issued；否则恢复定格筹码
        const reissue = game.started_at > existing.left_at;
        if (reissue) {
          await this.roomPlayers.setChips(existing.id, room.base_chips, t);
          await this.games.addIssued(game.id, room.base_chips, t);
        }
        await this.roomPlayers.markActive(existing.id, t);
        events.push(
          await this.feed.append(
            t,
            room.id,
            'player_returned',
            openid,
            {
              memberId: existing.id,
              nickname: memberNickname,
              reissued: reissue,
              chips: reissue ? room.base_chips : existing.chips,
            },
            memberNickname
          )
        );
      }

      const snapshot = await this.query.snapshot(room.id, t);
      const overview = await this.query.overviewFor(room, openid, t);
      return { reply: overview, broadcast: { events, snapshot } };
    });
  }

  // R3：离开（筹码定格、公屏留痕）
  async leave(openid, roomNo) {
    const room0 = await this.#findRoom(roomNo);
    await this.queues.run(room0.id, async (t) => {
      const room = await this.#activeRoomInTx(room0.id, t);
      const member = await this.roomPlayers.findByRoomAndPlayer(room.id, openid, t);
      if (!member || member.status !== 'active') throw new AppError(E.NOT_MEMBER, '不是本房间的在场成员');
      await this.roomPlayers.markLeft(member.id, now(), t);
      const event = await this.feed.append(
        t,
        room.id,
        'player_left',
        openid,
        { memberId: member.id, nickname: member.nickname, chipsLeft: member.chips },
        member.nickname
      );
      const snapshot = await this.query.snapshot(room.id, t);
      return { reply: undefined, broadcast: { events: [event], snapshot } };
    });
  }

  // R6：设置本金（仅房主；仅影响后续游戏）
  async setBaseChips(openid, roomNo, baseChips) {
    if (!PRESET_BASE_CHIPS.includes(baseChips)) {
      throw new AppError(E.BASE_CHIPS_INVALID, '本金必须是预设值（100/200/400/500/800/1000）');
    }
    const room0 = await this.#findRoom(roomNo);
    return this.queues.run(room0.id, async (t) => {
      const room = await this.#activeRoomInTx(room0.id, t);
      const member = await this.roomPlayers.findByRoomAndPlayer(room.id, openid, t);
      if (!member || member.status !== 'active') throw new AppError(E.NOT_MEMBER, '不是本房间的在场成员');
      if (room.host_player_id !== openid) throw new AppError(E.NOT_HOST, '仅房主可执行该操作');
      const oldValue = room.base_chips;
      await this.rooms.updateBaseChips(room.id, baseChips, t);
      const event = await this.feed.append(
        t,
        room.id,
        'setting_changed',
        openid,
        { item: 'base_chips', oldValue, newValue: baseChips },
        member.nickname
      );
      const snapshot = await this.query.snapshot(room.id, t);
      return {
        reply: { baseChips, betOptions: quickBets(baseChips) },
        broadcast: { events: [event], snapshot },
      };
    });
  }

  // R7：移交房主（目标须为在场其他成员）
  async transferHost(openid, roomNo, toMemberId) {
    const room0 = await this.#findRoom(roomNo);
    return this.queues.run(room0.id, async (t) => {
      const room = await this.#activeRoomInTx(room0.id, t);
      const member = await this.roomPlayers.findByRoomAndPlayer(room.id, openid, t);
      if (!member || member.status !== 'active') throw new AppError(E.NOT_MEMBER, '不是本房间的在场成员');
      if (room.host_player_id !== openid) throw new AppError(E.NOT_HOST, '仅房主可执行该操作');
      if (toMemberId === member.id) throw new AppError(E.TRANSFER_SELF, '移交目标不能是本人');
      const target = await this.roomPlayers.findById(toMemberId, t);
      if (!target || target.room_id !== room.id || target.status !== 'active' || target.player_id === openid) {
        throw new AppError(E.TRANSFER_TARGET_INVALID, '移交目标必须是房间内的在场成员');
      }
      await this.rooms.updateHost(room.id, target.player_id, t);
      room.host_player_id = target.player_id; // 供同事务内构建的 overview 使用
      const event = await this.feed.append(
        t,
        room.id,
        'host_transferred',
        openid,
        { fromNickname: member.nickname, toNickname: target.nickname, toPlayerId: target.player_id },
        member.nickname
      );
      const snapshot = await this.query.snapshot(room.id, t);
      const overview = await this.query.overviewFor(room, openid, t);
      return { reply: overview, broadcast: { events: [event], snapshot } };
    });
  }

  // R9：解散（§5.3：房间 dissolved、游戏/轮次收尾、成员置 left、频道保留只读）
  async dissolve(openid, roomNo) {
    const room0 = await this.#findRoom(roomNo);
    const roomId = room0.id;
    await this.queues.run(roomId, async (t) => {
      const room = await this.#activeRoomInTx(roomId, t);
      const member = await this.roomPlayers.findByRoomAndPlayer(room.id, openid, t);
      if (!member || member.status !== 'active') throw new AppError(E.NOT_MEMBER, '不是本房间的在场成员');
      if (room.host_player_id !== openid) throw new AppError(E.NOT_HOST, '仅房主可执行该操作');

      const at = now();
      const memberCount = await this.roomPlayers.activeCount(room.id, t);
      const game = await this.games.findInProgress(room.id, t);
      if (game) {
        await this.games.markEnded(game.id, at, t);
        const round = await this.rounds.findInProgress(game.id, t);
        if (round) await this.rounds.markClosed(round.id, at, t); // 池值保留封存
      }
      await this.roomPlayers.markAllLeft(room.id, at, t);
      await this.rooms.markDissolved(room.id, at, t);
      const event = await this.feed.append(t, room.id, 'room_dissolved', openid, { memberCount }, member.nickname);
      const snapshot = await this.query.snapshot(room.id, t);
      return { reply: undefined, broadcast: { events: [event], snapshot } };
    });
    this.queues.destroy(roomId);
  }
}
