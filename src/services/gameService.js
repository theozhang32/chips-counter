import { AppError, E } from '../common/errors.js';
import { now } from '../common/clock.js';
import { uuid } from '../common/ids.js';

// R8：重建游戏（概设 §6.4：仅重置在场成员，离开成员定格筹码不动）
export class GameService {
  constructor({
    roomRepository,
    roomPlayerRepository,
    gameRepository,
    roundRepository,
    feedService,
    queryService,
    roomQueues,
    logger,
  }) {
    this.rooms = roomRepository;
    this.roomPlayers = roomPlayerRepository;
    this.games = gameRepository;
    this.rounds = roundRepository;
    this.feed = feedService;
    this.query = queryService;
    this.queues = roomQueues;
    this.logger = logger;
  }

  async rebuild(openid, roomNo, confirmPoolLoss = false) {
    const room0 = await this.rooms.findByRoomNo(roomNo);
    if (!room0) throw new AppError(E.ROOM_NOT_FOUND, '房间不存在');
    return this.queues.run(room0.id, async (t) => {
      const room = await this.rooms.findById(room0.id, t);
      if (!room) throw new AppError(E.ROOM_NOT_FOUND, '房间不存在');
      if (room.status !== 'active') throw new AppError(E.ROOM_DISSOLVED, '房间已解散');
      const member = await this.roomPlayers.findByRoomAndPlayer(room.id, openid, t);
      if (!member || member.status !== 'active') throw new AppError(E.NOT_MEMBER, '不是本房间的在场成员');
      if (room.host_player_id !== openid) throw new AppError(E.NOT_HOST, '仅房主可执行该操作');

      const oldGame = await this.games.findInProgress(room.id, t);
      if (!oldGame) {
        this.logger.error('rebuild: active room without in-progress game', { roomId: room.id });
        throw new AppError(E.GAME_NOT_ACTIVE, '房间无进行中的游戏');
      }
      const oldRound = await this.rounds.findInProgress(oldGame.id, t);
      if (!oldRound) {
        this.logger.error('rebuild: in-progress game without in-progress round', { roomId: room.id });
        throw new AppError(E.GAME_NOT_ACTIVE, '游戏无进行中的轮次');
      }

      const sealedPool = oldRound.pool;
      // FR-203：池非 0 且未确认 → 409 二次确认提示，不产生任何变更
      if (sealedPool > 0 && confirmPoolLoss !== true) {
        throw new AppError(E.REBUILD_CONFIRM_REQUIRED, '当前筹码池非 0，需确认封存后重建', { currentPool: sealedPool });
      }

      const at = now();
      await this.games.markEnded(oldGame.id, at, t);
      await this.rounds.markClosed(oldRound.id, at, t); // pool 列保留封存值

      const activeMembers = (await this.roomPlayers.listByRoom(room.id, t)).filter((m) => m.status === 'active');
      const issuedChips = activeMembers.length * room.base_chips;
      for (const m of activeMembers) await this.roomPlayers.setChips(m.id, room.base_chips, t);

      const newGameSeq = await this.games.nextSeq(room.id, t);
      const newGame = await this.games.insert(
        {
          id: uuid(),
          room_id: room.id,
          seq: newGameSeq,
          status: 'in_progress',
          issued_chips: issuedChips,
          started_at: at,
          ended_at: null,
        },
        t
      );
      await this.rounds.insert(
        { id: uuid(), game_id: newGame.id, seq: 1, status: 'in_progress', pool: 0, opened_at: at, closed_at: null },
        t
      );

      const events = [
        await this.feed.append(
          t,
          room.id,
          'round_closed',
          openid,
          { gameSeq: oldGame.seq, roundSeq: oldRound.seq, finalPool: sealedPool },
          member.nickname
        ),
        await this.feed.append(
          t,
          room.id,
          'game_rebuilt',
          openid,
          {
            oldGameSeq: oldGame.seq,
            newGameSeq,
            baseChips: room.base_chips,
            sealedPool,
            issuedChips,
            members: activeMembers.map((m) => ({ memberId: m.id, chips: room.base_chips })),
          },
          member.nickname
        ),
        await this.feed.append(
          t,
          room.id,
          'round_opened',
          openid,
          { gameSeq: newGameSeq, roundSeq: 1 },
          member.nickname
        ),
      ];
      const snapshot = await this.query.snapshot(room.id, t);
      const overview = await this.query.overviewFor(room, openid, t);
      return { reply: overview, broadcast: { events, snapshot } };
    });
  }
}
