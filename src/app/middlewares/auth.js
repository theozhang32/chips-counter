import { AppError, E } from '../../common/errors.js';

// D16/D18：REST 身份取云通道注入的 x-wx-openid 头；devMode 下接受 x-dev-openid 模拟
export function authMiddleware(config) {
  return async (ctx, next) => {
    let openid = ctx.get('x-wx-openid');
    if (!openid && config.devMode) openid = ctx.get('x-dev-openid');
    if (!openid) throw new AppError(E.AUTH_REQUIRED, '缺少身份头');
    ctx.state.openid = openid.trim();
    await next();
  };
}
