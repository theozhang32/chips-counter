import Router from '@koa/router';

// §6.2：全部路由 → controller 方法（统一前缀 /api）
export function createRoutes({ controllers, auth, sequelize }) {
  const router = new Router({ prefix: '/api' });

  // S1：健康检查（云托管探活，免鉴权）
  router.get('/health', async (ctx) => {
    try {
      await sequelize.authenticate();
      ctx.body = { status: 'ok' };
    } catch {
      ctx.status = 503;
      ctx.body = { status: 'error' };
    }
  });

  router.post('/auth/session', auth, controllers.auth.session);
  router.get('/auth/me', auth, controllers.auth.getMe);
  router.put('/auth/me', auth, controllers.auth.updateMe);

  router.post('/rooms', auth, controllers.room.create);
  router.get('/rooms/:roomNo', auth, controllers.room.getOverview);
  router.get('/rooms/:roomNo/leaderboard', auth, controllers.room.getLeaderboard);
  router.post('/rooms/:roomNo/join', auth, controllers.room.join);
  router.post('/rooms/:roomNo/leave', auth, controllers.room.leave);
  router.put('/rooms/:roomNo/settings/base-chips', auth, controllers.room.updateBaseChips);
  router.post('/rooms/:roomNo/host/transfer', auth, controllers.room.transferHost);
  router.post('/rooms/:roomNo/rebuild', auth, controllers.room.rebuild);
  router.post('/rooms/:roomNo/dissolve', auth, controllers.room.dissolve);

  router.post('/rooms/:roomNo/actions/bet', auth, controllers.action.bet);
  router.post('/rooms/:roomNo/actions/all-in', auth, controllers.action.allIn);
  router.post('/rooms/:roomNo/actions/collect', auth, controllers.action.collect);
  router.post('/rooms/:roomNo/actions/partial-collect', auth, controllers.action.partialCollect);

  router.get('/rooms/:roomNo/feed', auth, controllers.feed.list);
  router.get('/rooms/:roomNo/feed/latest', auth, controllers.feed.latest);

  return router;
}
