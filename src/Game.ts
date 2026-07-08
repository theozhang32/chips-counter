/*
 * @Author       : 张天昊
 * @Date         : 2026-07-08 16:01:43
 * @LastEditTime : 2026-07-08 16:02:49
 * @LastEditors  : 张天昊
 * @Description  : 游戏
 * @FilePath     : /chips-counter/src/Game.ts
 */

import { Player } from './Player';
import { Round } from './Round';
import type {
  GameSettlement,
  GameSnapshot,
  GameStatus,
} from './types';

let idCounter = 0;
const nextId = (prefix: string) => `${prefix}_${++idCounter}`;

export interface GameStartConfig {
  /** 各玩家本局起始筹码，key 为 playerId */
  buyIns: Record<string, number>;
}

export class Game {
  readonly id: string;
  status: GameStatus = 'active';

  private readonly players: Map<string, Player>;
  private readonly startingStacks = new Map<string, number>();
  private readonly rounds: Round[] = [];
  private currentRound: Round | null = null;

  constructor(players: Player[], config: GameStartConfig, id?: string) {
    this.id = id ?? nextId('game');
    this.players = new Map(players.map((p) => [p.id, p]));

    for (const [playerId, amount] of Object.entries(config.buyIns)) {
      if (amount <= 0) throw new Error('起始筹码必须大于 0');
      const player = this.players.get(playerId);
      if (!player) throw new Error(`找不到玩家 ${playerId}`);
      player.setChips(amount);
      this.startingStacks.set(playerId, amount);
    }
  }

  /** 开始新一局 */
  startRound(): Round {
    this.requireActive();
    if (this.currentRound?.status === 'active') {
      throw new Error('请先结束当前局');
    }
    if (this.players.size < 2) {
      throw new Error('至少需要 2 名玩家');
    }

    const round = new Round(nextId('round'), this.rounds.length + 1);
    this.currentRound = round;
    this.rounds.push(round);
    return round;
  }

  /** 玩家下注 */
  bet(playerId: string, amount?: number): void {
    const round = this.requireCurrentRound();
    const player = this.getPlayer(playerId);
    round.bet(player, amount);
  }

  /** 玩家收池（触发后本局结束） */
  collect(playerId: string, amount?: number): void {
    const round = this.requireCurrentRound();
    const player = this.getPlayer(playerId);
    round.collect(player, amount);
  }

  /** 房主结束本场游戏，结算盈亏 */
  end(): GameSettlement[] {
    if (this.currentRound?.status === 'active') {
      throw new Error('当前局进行中，请先收池结束本局');
    }
    this.status = 'ended';

    return [...this.players.values()].map((p) => {
      const starting = this.startingStacks.get(p.id) ?? 0;
      return {
        playerId: p.id,
        name: p.name,
        startingChips: starting,
        endingChips: p.chips,
        profit: p.chips - starting,
      };
    });
  }

  getPlayer(playerId: string): Player {
    const player = this.players.get(playerId);
    if (!player) throw new Error(`找不到玩家 ${playerId}`);
    return player;
  }

  getPlayers(): Player[] {
    return [...this.players.values()];
  }

  getCurrentRound(): Round | null {
    return this.currentRound;
  }

  getRounds(): readonly Round[] {
    return this.rounds;
  }

  toSnapshot(): GameSnapshot {
    const startingStacks: Record<string, number> = {};
    for (const [id, amount] of this.startingStacks) {
      startingStacks[id] = amount;
    }

    return {
      id: this.id,
      status: this.status,
      startingStacks,
      players: this.getPlayers().map((p) => p.toSnapshot()),
      currentRound: this.currentRound?.toSnapshot() ?? null,
      roundCount: this.rounds.length,
    };
  }

  private requireActive(): void {
    if (this.status === 'ended') throw new Error('本场游戏已结束');
  }

  private requireCurrentRound(): Round {
    if (!this.currentRound || this.currentRound.status === 'ended') {
      throw new Error('没有进行中的局');
    }
    return this.currentRound;
  }
}
