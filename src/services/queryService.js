import { AppError, E } from '../common/errors.js';
import { toIso } from '../common/clock.js';
import { quickBets } from '../common/quickBets.js';

// 查询服务：总览 / 筹码榜 / 快照（读路径不进队列、不开事务；命令闭包内可传 t 保持同事务可见性）
export class QueryService {
  constructor({ roomRepository, roomPlayerRepository, gameRepository, roundRepository }) {
    this.rooms = roomRepository;
    this.roomPlayers = roomPlayerRepository;
    this.games = gameRepository;
    this.rounds = roundRepository;
  }

  async #loadState(room, t) {
    const members = await this.roomPlayers.listByRoom(room.id, t);
    const game =
      (await this.games.findInProgress(room.id, t)) ?? (await this.games.findLatestByRoom(room.id, t)) ?? null;
    const round = game
      ? ((await this.rounds.findInProgress(game.id, t)) ?? (await this.rounds.findLatestByGame(game.id, t)) ?? null)
      : null;
    return { room, members, game, round };
  }

  #snapshotDTO({ room, members, game, round }) {
    return {
      roomNo: room.room_no,
      status: room.status,
      baseChips: room.base_chips,
      gameSeq: game?.seq ?? null,
      issuedChips: game?.issued_chips ?? null,
      roundSeq: round?.seq ?? null,
      pool: round?.pool ?? null,
      members: members.map((m) => ({
        memberId: m.id,
        nickname: m.nickname,
        chips: m.chips,
        status: m.status,
        isHost: m.player_id === room.host_player_id,
      })),
    };
  }

  #overviewDTO(state, viewerOpenid) {
    const { room } = state;
    let me = null;
    if (viewerOpenid) {
      const mine = state.members.find((m) => m.player_id === viewerOpenid);
      if (mine) me = { memberId: mine.id, isHost: mine.player_id === room.host_player_id };
    }
    return {
      ...this.#snapshotDTO(state),
      name: room.name,
      createdAt: toIso(room.created_at),
      hostPlayerId: room.host_player_id,
      betOptions: quickBets(room.base_chips), // D19：快捷档位随总览下发
      me,
    };
  }

  // R4：房间总览（D17：登录即可读）
  async overview(roomNo, viewerOpenid) {
    const room = await this.rooms.findByRoomNo(roomNo);
    if (!room) throw new AppError(E.ROOM_NOT_FOUND, '房间不存在');
    const state = await this.#loadState(room);
    return this.#overviewDTO(state, viewerOpenid);
  }

  // 命令闭包内构造回复（同事务读，能看到未提交的本命令变更）
  async overviewFor(room, viewerOpenid, t) {
    const state = await this.#loadState(room, t);
    return this.#overviewDTO(state, viewerOpenid);
  }

  // R5：筹码榜（chips 降序，并列按 joined_at 升序）
  async leaderboard(roomNo) {
    const room = await this.rooms.findByRoomNo(roomNo);
    if (!room) throw new AppError(E.ROOM_NOT_FOUND, '房间不存在');
    const members = await this.roomPlayers.listByRoom(room.id);
    const ranking = [...members]
      .sort((a, b) => b.chips - a.chips || a.joined_at - b.joined_at)
      .map((m) => ({
        memberId: m.id,
        nickname: m.nickname,
        chips: m.chips,
        status: m.status,
        isHost: m.player_id === room.host_player_id,
      }));
    return { ranking };
  }

  // SnapshotDTO（WS welcome / events 帧附带）
  async snapshot(roomId, t) {
    const room = await this.rooms.findById(roomId, t);
    if (!room) return null;
    return this.#snapshotDTO(await this.#loadState(room, t));
  }
}
