import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toDbString } from '../common/clock.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

// 去掉 `--` 行注释后按 `;` 切分（本仓库 DDL 不含含分号的字符串字面量）
function splitStatements(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

const versionOf = (file) => Number(file.match(/^schema\.v(\d+)\.sql$/)?.[1]);

// §3.3：schema_migrations 版本化迁移执行器（幂等，启动时调用）；
// 注：MySQL 的 DDL 会隐式提交、无法随事务回滚，全部语句使用 IF NOT EXISTS 保证重放安全
export function createDbInitializer(sequelize, logger) {
  return {
    async run() {
      await sequelize.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        version INT UNSIGNED NOT NULL PRIMARY KEY,
        applied_at DATETIME(3) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      const [rows] = await sequelize.query('SELECT version FROM schema_migrations');
      const applied = new Set(rows.map((r) => Number(r.version)));

      const files = readdirSync(MIGRATIONS_DIR)
        .map((f) => ({ file: f, version: versionOf(f) }))
        .filter((e) => e.version !== undefined && Number.isInteger(e.version))
        .sort((a, b) => a.version - b.version);

      for (const { file, version } of files) {
        if (applied.has(version)) continue;
        logger.info('applying migration', { file });
        const statements = splitStatements(readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
        await sequelize.transaction(async (t) => {
          for (const stmt of statements) {
            await sequelize.query(stmt, { transaction: t });
          }
          await sequelize.query('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', {
            replacements: [version, toDbString(new Date())],
            transaction: t,
          });
        });
      }
    },
  };
}
