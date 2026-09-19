// 测试装配：临时库 + devMode + supertest（§9 策略）
// 环境变量：MYSQL_HOST/MYSQL_PORT/MYSQL_ADMIN_USER/MYSQL_ADMIN_PASSWORD（默认 root/chipsroot@127.0.0.1，对应 docker-compose）
import { Sequelize } from 'sequelize';
import supertest from 'supertest';
import { randomUUID } from 'node:crypto';
import { createContainer } from '../../src/index.js';

const HOST = process.env.MYSQL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.MYSQL_PORT ?? 33061); // 对应 docker-compose 的宿主机映射
const ADMIN_USER = process.env.MYSQL_ADMIN_USER ?? 'root';
const ADMIN_PASSWORD = process.env.MYSQL_ADMIN_PASSWORD ?? 'chipsroot';

export async function createTestApp({ gatewayOptions } = {}) {
  const dbName = `chips_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const admin = new Sequelize({
    dialect: 'mysql',
    host: HOST,
    port: PORT,
    username: ADMIN_USER,
    password: ADMIN_PASSWORD,
    logging: false,
  });
  await admin.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);

  const container = await createContainer(
    {
      port: 0,
      retentionDays: 90,
      authTokenSecret: 'test-secret',
      tokenTtlDays: 30,
      mysql: { host: HOST, port: PORT, user: ADMIN_USER, password: ADMIN_PASSWORD, database: dbName },
      devMode: true,
    },
    { gatewayOptions }
  );
  await container.init();
  await container.start(); // 随机端口监听（port 0）

  const address = container.server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const wsUrl = `ws://127.0.0.1:${address.port}/ws`;
  const request = supertest(container.app.callback());

  // 以指定 openid 身份发起请求（devMode 身份头，D18）
  const asUser = (openid) => ({
    get: (url) => request.get(url).set('x-dev-openid', openid),
    post: (url, body) =>
      request
        .post(url)
        .set('x-dev-openid', openid)
        .send(body ?? {}),
    put: (url, body) =>
      request
        .put(url)
        .set('x-dev-openid', openid)
        .send(body ?? {}),
    del: (url) => request.delete(url).set('x-dev-openid', openid),
  });

  const teardown = async () => {
    await container.stop();
    await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
    await admin.close();
  };

  return { container, request, baseUrl, wsUrl, asUser, teardown, dbName };
}

// 常用流程：建房并让 players 加入（房间内昵称 = openid，便于测试断言），返回 { roomNo, baseChips, users }
export async function setupRoom(app, { host = 'host-1', players = [], baseChips = 1000, name } = {}) {
  const hostClient = app.asUser(host);
  const created = await hostClient.post('/api/rooms', { name, baseChips, nickname: host }).expect(201);
  const roomNo = created.body.roomNo;
  const users = { [host]: hostClient };
  for (const player of players) {
    users[player] = app.asUser(player);
    await users[player].post(`/api/rooms/${roomNo}/join`, { nickname: player }).expect(200);
  }
  return { roomNo, baseChips, users };
}
