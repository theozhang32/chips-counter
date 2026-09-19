import { toIso } from '../common/clock.js';

export const toPlayerDTO = (player) => ({
  playerId: player.id,
  nickname: player.nickname,
  createdAt: toIso(player.created_at),
});

export class AuthService {
  constructor({ playerRepository, roomPlayerRepository, tokenService }) {
    this.players = playerRepository;
    this.roomPlayers = roomPlayerRepository;
    this.tokens = tokenService;
  }

  async ensurePlayer(openid) {
    return this.players.findOrCreate(openid);
  }

  // A1：首次自动注册 player + 签发 WS 令牌（D16）
  async session(openid) {
    const player = await this.ensurePlayer(openid);
    return { token: this.tokens.issue(openid), player: toPlayerDTO(player) };
  }

  // A3：我的档案与所在房间（active 成员关系，供小程序冷启动恢复）
  async getProfile(openid) {
    const player = await this.ensurePlayer(openid);
    const membership = await this.roomPlayers.findActiveByPlayer(openid);
    return {
      player: toPlayerDTO(player),
      room: membership?.room ? { roomNo: membership.room.room_no, status: membership.room.status } : null,
    };
  }

  // A4：设置默认昵称，仅影响后续加入房间时的默认值
  async updateNickname(openid, nickname) {
    const player = await this.ensurePlayer(openid);
    await this.players.updateNickname(openid, nickname);
    return { player: toPlayerDTO({ ...player, nickname }) };
  }
}
