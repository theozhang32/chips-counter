import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const intEnv = (raw, fallback) => {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) ? n : fallback;
};

const boolEnv = (raw, fallback) => {
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
};

const deepFreeze = (obj) => {
  for (const key of Object.keys(obj)) {
    if (obj[key] && typeof obj[key] === 'object' && !Object.isFrozen(obj[key])) deepFreeze(obj[key]);
  }
  return Object.freeze(obj);
};

// §2.5：config.json + 环境变量覆盖，启动时一次性读取、深冻结导出
export function loadConfig() {
  let file = {};
  const file_path = path.join(PROJECT_ROOT, 'config.json');
  if (existsSync(file_path)) file = JSON.parse(readFileSync(file_path, 'utf8'));

  const env = process.env;
  const config = {
    port: intEnv(env.PORT, file.port ?? 3000),
    retentionDays: intEnv(env.RETENTION_DAYS, file.retentionDays ?? 90),
    authTokenSecret: env.AUTH_TOKEN_SECRET ?? file.authTokenSecret,
    tokenTtlDays: intEnv(env.TOKEN_TTL_DAYS, file.tokenTtlDays ?? 30),
    mysql: {
      host: env.MYSQL_HOST ?? file.mysql?.host ?? '127.0.0.1',
      port: intEnv(env.MYSQL_PORT, file.mysql?.port ?? 3306),
      user: env.MYSQL_USER ?? file.mysql?.user ?? 'chips',
      password: env.MYSQL_PASSWORD ?? file.mysql?.password ?? '',
      database: env.MYSQL_DATABASE ?? file.mysql?.database ?? 'chips_counter',
    },
    devMode: boolEnv(env.DEV_MODE, file.devMode ?? false),
  };

  if (!Number.isInteger(config.port) || config.port < 1024 || config.port > 65535) {
    throw new Error(`配置错误：port 需在 1024~65535 之间（当前 ${config.port}）`);
  }
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1) {
    throw new Error(`配置错误：retentionDays 需 ≥ 1（当前 ${config.retentionDays}）`);
  }
  if (!Number.isInteger(config.tokenTtlDays) || config.tokenTtlDays < 1) {
    throw new Error(`配置错误：tokenTtlDays 需 ≥ 1（当前 ${config.tokenTtlDays}）`);
  }
  if (!config.mysql.host || !config.mysql.database) {
    throw new Error('配置错误：mysql.host / mysql.database 必填');
  }
  if (!config.authTokenSecret || config.authTokenSecret === 'CHANGE_ME') {
    // §2.5：非空且 ≠ CHANGE_ME，否则启动告警（devMode 下允许随机生成临时密钥并 warn）
    config.authTokenSecret = randomBytes(32).toString('hex');
    const msg = `[config] authTokenSecret 未设置或仍为 CHANGE_ME，已随机生成临时密钥（WS 令牌重启后失效）devMode=${config.devMode}`;
    if (config.devMode) console.warn(msg);
    else console.warn(`[config:WARN] ${msg}`);
  }

  return deepFreeze(config);
}
