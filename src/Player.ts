/*
 * @Author       : 张天昊
 * @Date         : 2026-07-08 16:01:27
 * @LastEditTime : 2026-07-08 16:02:32
 * @LastEditors  : 张天昊
 * @Description  : 玩家
 * @FilePath     : /chips-counter/src/Player.ts
 */

import type { PlayerSnapshot } from './types';

export class Player {
  readonly id: string;
  name: string;
  chips: number;

  constructor(id: string, name: string, chips = 0) {
    this.id = id;
    this.name = name;
    this.chips = chips;
  }

  /** 设置筹码（开局时由房主重置） */
  setChips(amount: number): void {
    if (amount < 0) throw new Error('筹码不能为负');
    this.chips = amount;
  }

  /** 下注扣款，返回实际扣除额（不足时视为 all-in） */
  deduct(amount: number): number {
    if (amount <= 0) throw new Error('下注金额必须大于 0');
    const actual = Math.min(amount, this.chips);
    this.chips -= actual;
    return actual;
  }

  /** 收池加款 */
  addChips(amount: number): void {
    if (amount <= 0) throw new Error('收池金额必须大于 0');
    this.chips += amount;
  }

  toSnapshot(): PlayerSnapshot {
    return {
      id: this.id,
      name: this.name,
      chips: this.chips,
    };
  }
}
