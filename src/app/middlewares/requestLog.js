// 请求日志：method/path/status/耗时/openid（脱敏前 6 位）
// 在 res finish 时记录——错误中间件在响应写出前完成状态覆写，保证失败请求也记到真实状态码
const maskOpenid = (openid) => (openid ? `${openid.slice(0, 6)}***` : null);

export function requestLogMiddleware(logger) {
  return async (ctx, next) => {
    const start = Date.now();
    ctx.res.once('finish', () => {
      logger.info('http request', {
        method: ctx.method,
        path: ctx.path,
        status: ctx.status,
        ms: Date.now() - start,
        openid: maskOpenid(ctx.state?.openid),
      });
    });
    await next();
  };
}
