/*
 * @Author       : 张天昊
 * @Date         : 2026-07-08 16:02:15
 * @LastEditTime : 2026-07-08 16:02:26
 * @LastEditors  : 张天昊
 * @Description  : 轮次
 * @FilePath     : /chips-counter/src/Round.ts
 */

import { Player } from './Player';
import type {
  RoundBet,
  RoundCollect,
  RoundSnapshot,
  RoundStatus,
  SidePot,
} from './types';

export class Round {
  readonly id: string;
  readonly roundNumber: number;
  status: RoundStatus = 'active';

  private pot = 0;
  private readonly investments = new Map<string, number>();
  private readonly bets: RoundBet[] = [];
  private collectRecord: RoundCollect | null = null;

  constructor(id: string, roundNumber: number) {
    this.id = id;
    this.roundNumber = roundNumber;
  }

  /** 下注（all-in 即下注全部剩余筹码） */
  bet(player: Player, amount?: number): RoundBet {
    this.requireActive();

    const toBet = amount ?? player.chips;
    if (toBet <= 0) throw new Error('下注金额必须大于 0');

    const paid = player.deduct(toBet);
    const isAllIn = player.chips === 0;

    this.pot += paid;
    this.investments.set(
      player.id,
      (this.investments.get(player.id) ?? 0) + paid,
    );

    const record: RoundBet = {
      playerId: player.id,
      amount: paid,
      isAllIn,
      timestamp: Date.now(),
    };
    this.bets.push(record);
    return record;
  }

  /**
   * 收池，本局结束。
   * 有 all-in 时按边池计算该玩家可收取上限，超出部分不允许收取。
   */
  collect(player: Player, amount?: number): RoundCollect {
    this.requireActive();

    if (this.pot <= 0) throw new Error('底池为空，无法收池');

    const maxCollectible = this.getMaxCollectible(player.id);
    if (maxCollectible <= 0) {
      throw new Error('该玩家没有可收取的边池');
    }

    const collectAmount = Math.min(amount ?? maxCollectible, maxCollectible);
    if (collectAmount <= 0) throw new Error('收池金额必须大于 0');

    player.addChips(collectAmount);
    this.pot -= collectAmount;

    this.collectRecord = {
      playerId: player.id,
      amount: collectAmount,
      timestamp: Date.now(),
    };
    this.status = 'ended';
    return this.collectRecord;
  }

  /** 计算各玩家可收取上限（有资格边池金额之和） */
  getMaxCollectible(playerId: string): number {
    return this.calculateSidePots()
      .filter((p) => p.eligiblePlayerIds.includes(playerId))
      .reduce((sum, p) => sum + p.amount, 0);
  }

  /** 按投入额分层计算边池 */
  calculateSidePots(): SidePot[] {
    const contributors = [...this.investments.entries()]
      .filter(([, amount]) => amount > 0)
      .sort((a, b) => a[1] - b[1]);

    if (contributors.length === 0) return [];

    const pots: SidePot[] = [];
    let prevLevel = 0;

    for (let i = 0; i < contributors.length; i++) {
      const [_, level] = contributors[i];
      const layer = level - prevLevel;
      if (layer <= 0) continue;

      const eligible = contributors.slice(i).map(([id]) => id);
      pots.push({
        amount: layer * eligible.length,
        eligiblePlayerIds: eligible,
      });
      prevLevel = level;
    }

    return pots;
  }

  getPot(): number {
    return this.pot;
  }

  getInvestments(): ReadonlyMap<string, number> {
    return this.investments;
  }

  getBets(): readonly RoundBet[] {
    return this.bets;
  }

  getCollect(): RoundCollect | null {
    return this.collectRecord;
  }

  toSnapshot(): RoundSnapshot {
    const investments: Record<string, number> = {};
    for (const [id, amount] of this.investments) {
      investments[id] = amount;
    }

    return {
      id: this.id,
      roundNumber: this.roundNumber,
      status: this.status,
      pot: this.pot,
      investments,
      sidePots: this.calculateSidePots(),
      bets: [...this.bets],
      collect: this.collectRecord,
    };
  }

  private requireActive(): void {
    if (this.status === 'ended') throw new Error('本局已结束');
  }
}
