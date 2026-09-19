import { E } from '../common/errors.js';
import { readString } from '../common/validator.js';

export class AuthController {
  constructor({ authService }) {
    this.auth = authService;
  }

  // A1：POST /auth/session（换 WS 令牌；首次自动注册）
  session = async (ctx) => {
    ctx.body = await this.auth.session(ctx.state.openid);
  };

  // A3：GET /auth/me
  getMe = async (ctx) => {
    ctx.body = await this.auth.getProfile(ctx.state.openid);
  };

  // A4：PUT /auth/me（设置默认昵称，1~16 字）
  updateMe = async (ctx) => {
    const nickname = readString(ctx.request.body, 'nickname', { min: 1, max: 16, code: E.NICKNAME_INVALID });
    ctx.body = await this.auth.updateNickname(ctx.state.openid, nickname);
  };
}
