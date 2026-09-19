// §7.7：一致性重算（D12）——离线只读校验（fix 才写）
// 推导来源：feed_event 升序重建"发放绝对快照"（game_started / game_rebuilt / player_joined / player_returned），
// 动作增量以公屏中与 action 行一一对应的 action_* 事件回放（bet 负、collect/partial 正）。
export class ConsistencyService {
  constructor({
    sequelize,
    roomRepository,
    roomPlayerRepository,
    gameRepository,
    roundRepository,
    actionRepository,
    feedEventRepository,
    logger,
  }) {
    this.sequelize = sequelize;
    this.rooms = roomRepository;
    this.roomPlayers = roomPlayerRepository;
    this.games = gameRepository;
    this.rounds = roundRepository;
    this.actions = actionRepository;
    this.feedEvents = feedEventRepository;
    this.logger = logger;
  }

  async verify(roomNoOrNull) {
    const rooms = roomNoOrNull ? [await this.#roomByNo(roomNoOrNull)] : await this.rooms.listAll();
    const report = { rooms: [], issues: [] };
    for (const room of rooms) {
      if (!room) continue;
      report.rooms.push(room.room_no);
      report.issues.push(...(await this.#verifyRoom(room)));
    }
    return report;
  }

  async #roomByNo(roomNo) {
    const room = await this.rooms.findByRoomNo(roomNo);
    if (!room) throw new Error(`房间不存在：${roomNo}`);
    return room;
  }

  async #verifyRoom(room) {
    const issues = [];
    const issue = (object, id, field, stored, derived, message) =>
      issues.push({ roomNo: room.room_no, object, id, field, stored, derived, message });

    const feed = await this.feedEvents.listByRoomAsc(room.id);
    const actionRows = await this.actions.listByRoomAsc(room.id);
    const games = await this.games.listByRoom(room.id);
    const members = await this.roomPlayers.listByRoom(room.id);
    const roundsByGame = new Map();
    for (const game of games) {
      roundsByGame.set(game.id, await this.rounds.listByGame(game.id));
    }

    // ---- 1. 回放公屏事件，重建推导状态 ----
    let cur = { gameSeq: null, roundSeq: null, pool: 0, issued: 0, members: new Map() };
    const issuedByGame = new Map();
    const sealedByOldGame = new Map(); // game_rebuilt.oldGameSeq -> sealedPool
    const feedActionKeys = new Set();
    for (const e of feed) {
      let p;
      try {
        p = JSON.parse(e.payload);
      } catch {
        issue('feed_event', String(e.id), 'payload', e.payload, null, 'payload 不是合法 JSON');
        continue;
      }
      switch (e.type) {
        case 'game_started':
          cur = {
            gameSeq: p.gameSeq,
            roundSeq: null,
            pool: 0,
            issued: p.issuedChips,
            members: new Map(p.members.map((m) => [m.memberId, m.chips])),
          };
          break;
        case 'player_joined':
          cur.members.set(p.memberId, p.chipsIssued);
          cur.issued += p.chipsIssued;
          break;
        case 'player_returned':
          cur.members.set(p.memberId, p.chips);
          if (p.reissued) cur.issued += p.chips;
          break;
        case 'game_rebuilt':
          sealedByOldGame.set(p.oldGameSeq, p.sealedPool);
          cur = {
            gameSeq: p.newGameSeq,
            roundSeq: null,
            pool: 0,
            issued: p.issuedChips,
            members: new Map(p.members.map((m) => [m.memberId, m.chips])),
          };
          break;
        case 'round_opened':
          cur.roundSeq = p.roundSeq;
          cur.pool = 0;
          break;
        case 'round_closed':
          cur.pool = p.finalPool;
          break;
        case 'action_bet':
          feedActionKeys.add(`${p.gameSeq}:${p.roundSeq}:${p.actionSeq}:${p.memberId}`);
          cur.members.set(p.memberId, (cur.members.get(p.memberId) ?? 0) - p.amount);
          cur.pool += p.amount;
          break;
        case 'action_collect':
          feedActionKeys.add(`${p.gameSeq}:${p.roundSeq}:${p.actionSeq}:${p.memberId}`);
          cur.members.set(p.memberId, (cur.members.get(p.memberId) ?? 0) + p.amount);
          cur.pool = 0;
          break;
        case 'action_partial_collect':
          feedActionKeys.add(`${p.gameSeq}:${p.roundSeq}:${p.actionSeq}:${p.memberId}`);
          cur.members.set(p.memberId, (cur.members.get(p.memberId) ?? 0) + p.amount);
          cur.pool -= p.amount;
          break;
        default:
          break; // room_created / setting_changed / host_transferred / player_left / room_dissolved 不影响计数推导
      }
      if (cur.gameSeq !== null) issuedByGame.set(cur.gameSeq, cur.issued);
    }

    // ---- 2. action 流水与公屏动作事件一一对应（双份存储互为印证，§5.2）----
    const rowActionKeys = new Set();
    for (const a of actionRows) {
      rowActionKeys.add(`${a.game_seq}:${a.round_seq}:${a.seq}:${a.room_player_id}`);
    }
    for (const key of rowActionKeys) {
      if (!feedActionKeys.has(key))
        issue('action', key, 'feed_event', 'missing', 'expected', '动作流水缺少对应公屏事件');
    }
    for (const key of feedActionKeys) {
      if (!rowActionKeys.has(key))
        issue('feed_event', key, 'action', 'extra', 'unexpected', '公屏动作事件缺少对应动作流水');
    }

    // ---- 3. 缓存列比对 ----
    for (const member of members) {
      if (cur.members.has(member.id) && cur.members.get(member.id) !== member.chips) {
        issue(
          'room_player',
          member.id,
          'chips',
          member.chips,
          cur.members.get(member.id),
          '成员筹码缓存列与推导值不一致'
        );
      }
    }
    for (const game of games) {
      const derived = issuedByGame.get(game.seq);
      if (derived !== undefined && derived !== game.issued_chips) {
        issue(
          'game',
          game.id,
          'issued_chips',
          game.issued_chips,
          derived,
          `游戏 ${game.seq} 发放总额缓存列与推导值不一致`
        );
      }
    }
    for (const game of games) {
      for (const round of roundsByGame.get(game.id) ?? []) {
        if (
          round.status === 'in_progress' &&
          cur.gameSeq === game.seq &&
          cur.roundSeq === round.seq &&
          cur.pool !== round.pool
        ) {
          issue(
            'round',
            round.id,
            'pool',
            round.pool,
            cur.pool,
            `游戏 ${game.seq} 轮次 ${round.seq} 池缓存列与推导值不一致`
          );
        }
      }
    }

    // ---- 4. 结构断言 ----
    const gameSeqs = games.map((g) => g.seq).sort((a, b) => a - b);
    if (gameSeqs.some((seq, i) => seq !== i + 1)) {
      issue('game', room.id, 'seq', JSON.stringify(gameSeqs), '1..N 连续', '游戏序号不连续或复用（INV-4）');
    }
    if (games.filter((g) => g.status === 'in_progress').length > 1) {
      issue('game', room.id, 'status', 'multiple in_progress', '≤1', '同房间多个进行中的游戏（INV-3）');
    }
    for (const game of games) {
      const rounds = roundsByGame.get(game.id) ?? [];
      const roundSeqs = rounds.map((r) => r.seq).sort((a, b) => a - b);
      if (roundSeqs.some((seq, i) => seq !== i + 1)) {
        issue(
          'round',
          game.id,
          'seq',
          JSON.stringify(roundSeqs),
          '1..N 连续',
          `游戏 ${game.seq} 轮次序号不连续（INV-4）`
        );
      }
      if (rounds.filter((r) => r.status === 'in_progress').length > 1) {
        issue('round', game.id, 'status', 'multiple in_progress', '≤1', `游戏 ${game.seq} 多个进行中的轮次（INV-3）`);
      }
      for (const round of rounds) {
        if (round.status === 'closed' && round.pool !== 0) {
          const sealedOk = room.status === 'dissolved' || sealedByOldGame.get(game.seq) === round.pool;
          if (!sealedOk) {
            issue(
              'round',
              round.id,
              'pool',
              round.pool,
              0,
              `关闭轮次池非 0 且无封存记录（INV-6，游戏 ${game.seq} 轮次 ${round.seq}）`
            );
          }
        }
      }
    }
    const seqByRound = new Map();
    for (const a of actionRows) {
      const list = seqByRound.get(a.round_id) ?? [];
      list.push(a.seq);
      seqByRound.set(a.round_id, list);
    }
    for (const [roundId, seqs] of seqByRound) {
      const sorted = [...seqs].sort((a, b) => a - b);
      if (sorted.some((seq, i) => seq !== i + 1)) {
        issue('action', roundId, 'seq', JSON.stringify(sorted), '1..N 连续', '轮次内动作序号不连续（INV-4）');
      }
    }

    // ---- 5. 守恒断言（INV-2，仅对当前推导视图）----
    if (room.status === 'active' && cur.gameSeq !== null) {
      const totalChips = [...cur.members.values()].reduce((s, v) => s + v, 0);
      if (totalChips + cur.pool !== cur.issued) {
        issue(
          'room',
          room.id,
          'conservation',
          `${totalChips}+${cur.pool}`,
          String(cur.issued),
          `游戏 ${cur.gameSeq} 守恒不成立（Σ筹码+池 ≠ 发放总额）`
        );
      }
    }

    return issues;
  }

  // 以推导值回写缓存列（chips / pool / issued_chips）；修复本身也写 error 级日志（出现差异即为异常事件）
  async fix(report) {
    let fixed = 0;
    for (const it of report.issues) {
      if (it.object === 'room_player' && it.field === 'chips') {
        await this.roomPlayers.setChips(it.id, it.derived);
        fixed += 1;
      } else if (it.object === 'round' && it.field === 'pool') {
        await this.rounds.setPool(it.id, it.derived);
        fixed += 1;
      } else if (it.object === 'game' && it.field === 'issued_chips') {
        await this.games.setIssued(it.id, it.derived);
        fixed += 1;
      }
      this.logger.error('consistency issue detected', { ...it });
    }
    return fixed;
  }
}
