#!/usr/bin/env node
// NFR-01 简单基准：100 次下注的延迟分布（P50/P95/P99）
// 用法：node src/scripts/bench.js [--n 100] [--base 1000]
// 需要可达的 MySQL（本地 docker compose up -d mysql）；对临时库跑完即删
import { Sequelize } from 'sequelize';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../config/index.js';
import { createContainer } from '../index.js';

const args = process.argv.slice(2);
const readArg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? Number(args[i + 1]) : fallback;
};
const N = readArg('n', 100);
const BASE = readArg('base', 1000);

const config = loadConfig();

// 临时库，避免污染开发库
const admin = new Sequelize({
  dialect: 'mysql',
  host: config.mysql.host,
  port: config.mysql.port,
  username: process.env.MYSQL_ADMIN_USER ?? 'root',
  password: process.env.MYSQL_ADMIN_PASSWORD ?? 'chipsroot',
  logging: false,
});
const dbName = `chips_bench_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);

try {
  const adminUser = process.env.MYSQL_ADMIN_USER ?? 'root';
  const adminPassword = process.env.MYSQL_ADMIN_PASSWORD ?? 'chipsroot';
  const container = await createContainer({
    ...config,
    mysql: { ...config.mysql, database: dbName, user: adminUser, password: adminPassword },
    devMode: true,
    port: 0,
  });
  await container.init();
  await container.start();

  const { app } = container;
  const { default: supertest } = await import('supertest');
  const request = supertest(app.callback());
  const openid = `bench-${randomUUID().slice(0, 8)}`;

  const created = await request.post('/api/rooms').set('x-dev-openid', openid).send({ baseChips: BASE });
  if (created.status !== 201) throw new Error(`建房失败: ${JSON.stringify(created.body)}`);
  const roomNo = created.body.roomNo;

  const latencies = [];
  const amount = Math.max(1, Math.floor(BASE / 1000)); // 小额，确保 N 次不超筹码
  for (let i = 0; i < N; i++) {
    const start = process.hrtime.bigint();
    const res = await request.post(`/api/rooms/${roomNo}/actions/bet`).set('x-dev-openid', openid).send({ amount });
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    if (res.status !== 200) throw new Error(`第 ${i + 1} 笔下注失败: ${JSON.stringify(res.body)}`);
    latencies.push(ms);
  }
  latencies.sort((a, b) => a - b);
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))];
  console.log(` bets=${N} base=${BASE}`);
  console.log(
    ` min=${latencies[0].toFixed(1)}ms  P50=${pct(50).toFixed(1)}ms  P95=${pct(95).toFixed(1)}ms  P99=${pct(99).toFixed(1)}ms  max=${latencies[latencies.length - 1].toFixed(1)}ms`
  );
  console.log(
    pct(95) < 200 ? ' ✅ P95 < 200ms（NFR-01）' : ' ⚠️ P95 ≥ 200ms（注意：本机 MySQL 若经 Docker 模拟，含额外开销）'
  );

  await container.stop();
} finally {
  await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
  await admin.close();
}
