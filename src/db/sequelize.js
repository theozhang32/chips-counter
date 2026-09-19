import { Sequelize } from 'sequelize';

// §3.1：mysql2 连接池、UTC 时区（DATETIME(3) 存 UTC 毫秒）
export function createSequelize(config, logger) {
  return new Sequelize({
    dialect: 'mysql',
    host: config.mysql.host,
    port: config.mysql.port,
    username: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    pool: { max: 10, min: 0, idle: 10000, acquire: 30000 },
    timezone: '+00:00',
    define: { charset: 'utf8mb4', collate: 'utf8mb4_general_ci' },
    dialectOptions: { supportBigNumbers: true, bigNumberStrings: false, timezone: '+00:00' },
    logging: (msg) => logger.debug(msg),
  });
}
