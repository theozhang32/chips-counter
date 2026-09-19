import { AppError, E } from '../../common/errors.js';

// D22：AppError → HTTP；未知异常 500 + 日志
export function errorMiddleware(logger) {
  return async (ctx, next) => {
    try {
      await next();
    } catch (err) {
      if (err instanceof AppError) {
        ctx.status = err.httpStatus;
        ctx.body = {
          error: {
            code: err.code,
            message: err.message,
            ...(err.details !== undefined ? { details: err.details } : {}),
          },
        };
        return;
      }
      // bodyparser 的 4xx（非法 JSON / 超限）归一为参数错误
      if (
        (err?.status === 400 || err?.statusCode === 400 || err?.status === 413) &&
        !(err instanceof Error && err.code === 'ERR_INTERNAL')
      ) {
        ctx.status = 400;
        ctx.body = { error: { code: E.INVALID_PARAMS, message: '请求体不合法（需为 JSON 且 ≤16kb）' } };
        return;
      }
      logger.error('unhandled error', { method: ctx.method, path: ctx.path, error: err });
      ctx.status = 500;
      ctx.body = { error: { code: E.INTERNAL_ERROR, message: '内部错误' } };
    }
  };
}
