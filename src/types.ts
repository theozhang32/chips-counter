/** 单局状态 */
export type RoundStatus = 'active' | 'ended';

/** 单局动作：下注 / 收池 */
export type RoundActionType = 'bet' | 'collect';

/** 下注记录 */
export interface RoundBet {
  playerId: string;
  amount: number;
  isAllIn: boolean;
  timestamp: number;
}

/** 收池记录 */
export interface RoundCollect {
  playerId: string;
  amount: number;
  timestamp: number;
}

/** 边池（多人 all-in 时按投入额分层） */
export interface SidePot {
  amount: number;
  eligiblePlayerIds: string[];
}

/** 游戏状态 */
export type GameStatus = 'active' | 'ended';

/** 房间状态 */
export type RoomStatus = 'waiting' | 'playing' | 'closed';

/** 单场游戏结算 */
export interface GameSettlement {
  playerId: string;
  name: string;
  startingChips: number;
  endingChips: number;
  profit: number;
}

/** 玩家状态快照 */
export interface PlayerSnapshot {
  id: string;
  name: string;
  chips: number;
}

/** 单局状态快照 */
export interface RoundSnapshot {
  id: string;
  roundNumber: number;
  status: RoundStatus;
  pot: number;
  investments: Record<string, number>;
  sidePots: SidePot[];
  bets: RoundBet[];
  collect: RoundCollect | null;
}

/** 游戏状态快照 */
export interface GameSnapshot {
  id: string;
  status: GameStatus;
  startingStacks: Record<string, number>;
  players: PlayerSnapshot[];
  currentRound: RoundSnapshot | null;
  roundCount: number;
}

/** 房间状态快照 */
export interface RoomSnapshot {
  roomId: string;
  roomName: string;
  roomCode: string;
  status: RoomStatus;
  hostPlayerId: string;
  game: GameSnapshot | null;
}
