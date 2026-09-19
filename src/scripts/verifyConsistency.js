#!/usr/bin/env node
// §7.7：一致性重算 CLI（D12）—— pnpm verify [--room <roomNo>] [--fix]
// 离线只读（--fix 才写）；退出码：无问题 0，有问题 1（--fix 后仍有问题 1）
import { loadConfig } from '../config/index.js';
import { createLogger } from '../common/logger.js';
import { createSequelize } from '../db/sequelize.js';
import { defineEntities } from '../entities/index.js';
import { RoomRepository } from '../repositories/roomRepository.js';
import { RoomPlayerRepository } from '../repositories/roomPlayerRepository.js';
import { GameRepository } from '../repositories/gameRepository.js';
import { RoundRepository } from '../repositories/roundRepository.js';
import { ActionRepository } from '../repositories/actionRepository.js';
import { FeedEventRepository } from '../repositories/feedEventRepository.js';
import { ConsistencyService } from '../services/consistencyService.js';

const args = process.argv.slice(2);
const roomNoArg = args.includes('--room') ? Number(args[args.indexOf('--room') + 1]) : null;
const fix = args.includes('--fix');

const logger = createLogger({ level: 'error' });
const config = loadConfig();
const sequelize = createSequelize(config, logger);
const models = defineEntities(sequelize);

const consistencyService = new ConsistencyService({
  sequelize,
  roomRepository: new RoomRepository(sequelize, models),
  roomPlayerRepository: new RoomPlayerRepository(sequelize, models),
  gameRepository: new GameRepository(sequelize, models),
  roundRepository: new RoundRepository(sequelize, models),
  actionRepository: new ActionRepository(sequelize, models),
  feedEventRepository: new FeedEventRepository(sequelize, models),
  logger,
});

try {
  await sequelize.authenticate();
  const report = await consistencyService.verify(roomNoArg);
  if (report.issues.length === 0) {
    console.log(`✅ 一致性校验通过（房间：${report.rooms.join(', ') || '无'}，0 差异）`);
  } else {
    console.log(`❌ 发现 ${report.issues.length} 处差异：`);
    for (const it of report.issues) {
      console.log(
        `  [${it.roomNo}] ${it.object} ${it.id} .${it.field}: 库值=${JSON.stringify(it.stored)} 推导值=${JSON.stringify(it.derived)} —— ${it.message}`
      );
    }
    if (fix) {
      const fixed = await consistencyService.fix(report);
      console.log(`🔧 已按推导值回写 ${fixed} 处缓存列（详见 error 日志）`);
      const recheck = await consistencyService.verify(roomNoArg);
      if (recheck.issues.length > 0) {
        console.log(`❌ 修复后仍存在 ${recheck.issues.length} 处不可自动修复的问题（结构/流水缺失类）`);
        process.exitCode = 1;
      } else {
        console.log('✅ 修复后复检通过');
      }
    } else {
      process.exitCode = 1;
    }
  }
} finally {
  await sequelize.close();
}
