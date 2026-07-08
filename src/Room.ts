/*
 * @Author       : 张天昊
 * @Date         : 2026-07-08 16:01:14
 * @LastEditTime : 2026-07-08 16:01:16
 * @LastEditors  : 张天昊
 * @Description  : 房间
 * @FilePath     : /chips-counter/src/Room.ts
 */

import { Game } from './Game';
import { Player } from './Player';
import { Round } from './Round';
import type {
  GameSettlement,
  RoomSnapshot,
  RoomStatus,
} from './types';

let roomCounter = 0;
let playerCounter = 0;
const nextRoomCode = () => String(100000 + (++roomCounter % 900000));
const nextPlayerId = () => `player_${++playerCounter}`;

export class Room {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  hostPlayerId: string;
  status: RoomStatus = 'waiting';

  private readonly players = new Map<string, Player>();
  private currentGame: Game | null = null;

  constructor(
    name: string,
    hostName: string,
    options?: { id?: string; code?: string },
  ) {
    this.id = options?.id ?? `room_${Date.now()}`;
    this.name = name;
    this.code = options?.code ?? nextRoomCode();

    const host = this.addMember(hostName);
    this.hostPlayerId = host.id;
  }

  /** 玩家加入房间（仅登记，筹码在开局时由房主设置） */
  join(name: string): Player {
    if (this.status === 'closed') throw new Error('房间已关闭');
    if (this.currentGame?.status === 'active') {
      throw new Error('游戏进行中，无法加入');
    }
    return this.addMember(name);
  }

  /** 玩家离开 */
  leave(playerId: string): void {
    if (playerId === this.hostPlayerId) {
      throw new Error('房主不能离开，请关闭房间');
    }
    if (this.currentGame?.status === 'active') {
      throw new Error('游戏进行中，无法离开');
    }
    this.players.delete(playerId);
    if (this.players.size < 2) {
      this.status = 'waiting';
    }
  }

  /**
   * 房主开始一场游戏，重置各玩家起始筹码。
   * buyIns: { [playerId]: 起始筹码 }
   */
  startGame(hostPlayerId: string, buyIns: Record<string, number>): Game {
    this.requireHost(hostPlayerId);
    if (this.currentGame?.status === 'active') {
      throw new Error('当前游戏尚未结束');
    }
    if (this.players.size < 2) {
      throw new Error('至少需要 2 名玩家');
    }

    for (const playerId of Object.keys(buyIns)) {
      if (!this.players.has(playerId)) {
        throw new Error(`玩家 ${playerId} 不在房间内`);
      }
    }

    this.currentGame = new Game([...this.players.values()], { buyIns });
    this.status = 'playing';
    return this.currentGame;
  }

  /** 房主结束本场游戏，返回盈亏结算 */
  endGame(hostPlayerId: string): GameSettlement[] {
    this.requireHost(hostPlayerId);
    if (!this.currentGame || this.currentGame.status === 'ended') {
      throw new Error('没有进行中的游戏');
    }
    const settlement = this.currentGame.end();
    this.currentGame = null;
    this.status = 'waiting';
    return settlement;
  }

  /** 开始新一局 */
  startRound(): Round {
    return this.requireGame().startRound();
  }

  /** 玩家下注（amount 省略表示 all-in） */
  bet(playerId: string, amount?: number): void {
    this.requireGame().bet(playerId, amount);
  }

  /** 玩家收池，本局结束 */
  collect(playerId: string, amount?: number): void {
    this.requireGame().collect(playerId, amount);
  }

  close(): void {
    this.status = 'closed';
  }

  getGame(): Game | null {
    return this.currentGame;
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
    return this.currentGame?.getCurrentRound() ?? null;
  }

  toSnapshot(): RoomSnapshot {
    return {
      roomId: this.id,
      roomName: this.name,
      roomCode: this.code,
      status: this.status,
      hostPlayerId: this.hostPlayerId,
      game: this.currentGame?.toSnapshot() ?? null,
    };
  }

  private addMember(name: string): Player {
    const player = new Player(nextPlayerId(), name);
    this.players.set(player.id, player);
    return player;
  }

  private requireGame(): Game {
    if (!this.currentGame || this.currentGame.status === 'ended') {
      throw new Error('没有进行中的游戏，请房主先开始游戏');
    }
    return this.currentGame;
  }

  private requireHost(hostPlayerId: string): void {
    if (hostPlayerId !== this.hostPlayerId) {
      throw new Error('仅房主可操作');
    }
  }
}
