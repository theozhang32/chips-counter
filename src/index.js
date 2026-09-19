#!/usr/bin/env node
// 组合根：装配一切并启动（唯一 new 的地方，§4.4）
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config/index.js';
import { createLogger } from './common/logger.js';
import { TokenService } from './common/token.js';
import { createSequelize } from './db/sequelize.js';
import { createDbInitializer } from './db/init.js';
import { defineEntities } from './entities/index.js';
import { PlayerRepository } from './repositories/playerRepository.js';
import { RoomRepository } from './repositories/roomRepository.js';
import { RoomPlayerRepository } from './repositories/roomPlayerRepository.js';
import { GameRepository } from './repositories/gameRepository.js';
import { RoundRepository } from './repositories/roundRepository.js';
import { ActionRepository } from './repositories/actionRepository.js';
import { FeedEventRepository } from './repositories/feedEventRepository.js';
import { RoomQueues } from './queue/roomQueues.js';
import { WsGateway } from './ws/gateway.js';
import { AuthService } from './services/authService.js';
import { FeedService } from './services/feedService.js';
import { QueryService } from './services/queryService.js';
import { RoomService } from './services/roomService.js';
import { GameService } from './services/gameService.js';
import { ActionService } from './services/actionService.js';
import { RetentionService } from './services/retentionService.js';
import { ConsistencyService } from './services/consistencyService.js';
import { AuthController } from './controllers/authController.js';
import { RoomController } from './controllers/roomController.js';
import { ActionController } from './controllers/actionController.js';
import { FeedController } from './controllers/feedController.js';
import { createRoutes } from './app/routes.js';
import { createApp } from './app/app.js';
import { authMiddleware } from './app/middlewares/auth.js';
import { createRetentionJob } from './jobs/retentionJob.js';

export async function createContainer(config, overrides = {}) {
  const logger = overrides.logger ?? createLogger({ level: config.devMode ? 'debug' : 'info' });
  const sequelize = overrides.sequelize ?? createSequelize(config, logger);
  const models = defineEntities(sequelize);
  const dbInitializer = createDbInitializer(sequelize, logger);

  const playerRepository = new PlayerRepository(sequelize, models);
  const roomRepository = new RoomRepository(sequelize, models);
  const roomPlayerRepository = new RoomPlayerRepository(sequelize, models);
  const gameRepository = new GameRepository(sequelize, models);
  const roundRepository = new RoundRepository(sequelize, models);
  const actionRepository = new ActionRepository(sequelize, models);
  const feedEventRepository = new FeedEventRepository(sequelize, models);

  const tokenService = new TokenService({ secret: config.authTokenSecret, ttlDays: config.tokenTtlDays });
  const feedService = new FeedService({ roomRepository, feedEventRepository });
  const queryService = new QueryService({ roomRepository, roomPlayerRepository, gameRepository, roundRepository });
  const wsGateway =
    overrides.wsGateway ??
    new WsGateway({
      tokenService,
      roomRepository,
      queryService,
      feedService,
      logger,
      ...(overrides.gatewayOptions ?? {}),
    });
  const roomQueues = new RoomQueues(sequelize, wsGateway, logger);

  const authService = new AuthService({ playerRepository, roomPlayerRepository, tokenService });
  const roomService = new RoomService({
    roomRepository,
    roomPlayerRepository,
    gameRepository,
    roundRepository,
    playerRepository,
    feedService,
    queryService,
    roomQueues,
    logger,
  });
  const gameService = new GameService({
    roomRepository,
    roomPlayerRepository,
    gameRepository,
    roundRepository,
    feedService,
    queryService,
    roomQueues,
    logger,
  });
  const actionService = new ActionService({
    roomRepository,
    roomPlayerRepository,
    gameRepository,
    roundRepository,
    actionRepository,
    feedEventRepository,
    feedService,
    queryService,
    roomQueues,
    logger,
  });
  const retentionService = new RetentionService({ sequelize, config, roomRepository, roomQueues, wsGateway, logger });
  const consistencyService = new ConsistencyService({
    sequelize,
    roomRepository,
    roomPlayerRepository,
    gameRepository,
    roundRepository,
    actionRepository,
    feedEventRepository,
    logger,
  });

  const controllers = {
    auth: new AuthController({ authService }),
    room: new RoomController({ roomService, gameService, queryService }),
    action: new ActionController({ actionService }),
    feed: new FeedController({ feedService }),
  };
  const routes = createRoutes({ controllers, auth: authMiddleware(config), sequelize });
  const { app, server } = createApp({ logger, routes });
  wsGateway.attach(server);

  const retentionJob = createRetentionJob({ retentionService, logger });

  const container = {
    config,
    logger,
    sequelize,
    models,
    dbInitializer,
    repositories: {
      playerRepository,
      roomRepository,
      roomPlayerRepository,
      gameRepository,
      roundRepository,
      actionRepository,
      feedEventRepository,
    },
    services: {
      authService,
      roomService,
      gameService,
      actionService,
      feedService,
      queryService,
      retentionService,
      consistencyService,
    },
    wsGateway,
    roomQueues,
    controllers,
    app,
    server,
    retentionJob,

    async init() {
      await sequelize.authenticate();
      await dbInitializer.run();
    },
    async start() {
      await new Promise((resolve) => server.listen(config.port, resolve));
      logger.info('server started', { port: config.port, devMode: config.devMode });
      retentionJob.start();
    },
    async stop() {
      retentionJob.stop();
      wsGateway.close();
      await new Promise((resolve) => server.close(resolve));
      await sequelize.close();
      logger.info('server stopped');
    },
  };
  return container;
}

async function main() {
  const config = loadConfig();
  const container = await createContainer(config);
  await container.init();
  await container.start();

  const shutdown = (_signal) => {
    container
      .stop()
      .then(() => process.exit(0))
      .catch((err) => {
        container.logger.error('shutdown failed', { error: err });
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || '.').href;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
