import http from 'node:http';
import Koa from 'koa';
import bodyParser from '@koa/bodyparser';
import { errorMiddleware } from './middlewares/error.js';
import { requestLogMiddleware } from './middlewares/requestLog.js';

// createApp(ctx) → { app, server }（Koa 工厂；WS 由 gateway.attach(server) 挂载）
export function createApp({ logger, routes }) {
  const app = new Koa();
  app.use(errorMiddleware(logger));
  app.use(bodyParser({ enableTypes: ['json'], jsonLimit: '16kb' }));
  app.use(requestLogMiddleware(logger));
  app.use(routes.routes());
  app.use(routes.allowedMethods());
  const server = http.createServer(app.callback());
  return { app, server };
}
