// M2：公屏查询 F1/F2（分页/筛选/游标）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, setupRoom } from './helpers/app.js';

let app;

before(async () => {
  app = await createTestApp();
});

after(async () => {
  await app.teardown();
});

let seedSeq = 0;
async function seedEvents() {
  // 1 房间创建 + 1 game_started + 1 round_opened + 2 player_joined + 3 bets = 8 事件
  const tag = `f${++seedSeq}`;
  const { roomNo, users } = await setupRoom(app, { host: `${tag}-host`, players: [`${tag}-p1`, `${tag}-p2`] });
  await users[`${tag}-host`].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  await users[`${tag}-p1`].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 200 }).expect(200);
  await users[`${tag}-p2`].post(`/api/rooms/${roomNo}/actions/partial-collect`, { amount: 50 }).expect(200);
  return { roomNo, users, tag };
}

test('F1 默认倒序分页：limit/hasMore/nextCursor；order=asc 正序', async () => {
  const { roomNo, users, tag } = await seedEvents();

  const desc = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`);
  assert.equal(desc.status, 200);
  assert.equal(desc.body.events.length, 8);
  const ids = desc.body.events.map((e) => e.id);
  assert.deepEqual(
    [...ids].sort((a, b) => b - a),
    ids
  ); // 默认 desc
  assert.equal(desc.body.hasMore, false);
  assert.equal(desc.body.nextCursor, ids[ids.length - 1]);

  const asc = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  const ascIds = asc.body.events.map((e) => e.id);
  assert.deepEqual(
    [...ascIds].sort((a, b) => a - b),
    ascIds
  );
  assert.deepEqual(asc.body.events[0].type, 'room_created');
});

test('F1 afterId 正序补拉（断线补拉语义）', async () => {
  const { roomNo, users, tag } = await seedEvents();
  const all = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  const cursor = all.body.events[3].id;
  const after = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`).query({ afterId: cursor, order: 'asc' });
  assert.deepEqual(
    after.body.events.map((e) => e.id),
    all.body.events.slice(4).map((e) => e.id)
  );
});

test('F1 beforeId 倒序翻页 + limit 控制 hasMore/nextCursor', async () => {
  const { roomNo, users, tag } = await seedEvents();
  const all = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  const ids = all.body.events.map((e) => e.id);

  const page1 = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`).query({ limit: 3 });
  assert.equal(page1.body.events.length, 3);
  assert.equal(page1.body.hasMore, true);
  assert.deepEqual(
    page1.body.events.map((e) => e.id),
    [ids[7], ids[6], ids[5]]
  );
  assert.equal(page1.body.nextCursor, ids[5]);

  const page2 = await users[`${tag}-host`]
    .get(`/api/rooms/${roomNo}/feed`)
    .query({ beforeId: page1.body.nextCursor, limit: 3 });
  assert.deepEqual(
    page2.body.events.map((e) => e.id),
    [ids[4], ids[3], ids[2]]
  );

  const page3 = await users[`${tag}-host`]
    .get(`/api/rooms/${roomNo}/feed`)
    .query({ beforeId: page2.body.nextCursor, limit: 3 });
  assert.equal(page3.body.hasMore, false);
  assert.deepEqual(
    page3.body.events.map((e) => e.id),
    [ids[1], ids[0]]
  );
});

test('F1 afterId 与 beforeId 互斥 → 400；limit 上限 200', async () => {
  const { roomNo, users, tag } = await seedEvents();
  const both = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`).query({ afterId: 1, beforeId: 10 });
  assert.equal(both.status, 400);
  assert.equal(both.body.error.code, 'INVALID_PARAMS');

  const bigLimit = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`).query({ limit: 99999 });
  assert.equal(bigLimit.status, 200); // 截断为 200，不报错
});

test('F1 actor 筛选与 type 多选', async () => {
  const { roomNo, users, tag } = await seedEvents();
  const byType = await users[`${tag}-host`]
    .get(`/api/rooms/${roomNo}/feed`)
    .query({ type: 'action_bet,player_joined', order: 'asc' });
  assert.equal(byType.body.events.length, 4); // 2 player_joined + 2 action_bet（partial_collect 是另一类型）
  assert.ok(byType.body.events.every((e) => ['action_bet', 'player_joined'].includes(e.type)));

  const badType = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`).query({ type: 'nonexistent' });
  assert.equal(badType.status, 400);

  const byActor = await users[`${tag}-host`]
    .get(`/api/rooms/${roomNo}/feed`)
    .query({ actor: `${tag}-p1`, order: 'asc' });
  assert.ok(byActor.body.events.length >= 1);
  assert.ok(byActor.body.events.every((e) => e.actorPlayerId === `${tag}-p1`));
  const joinEvt = byActor.body.events.find((e) => e.type === 'player_joined');
  assert.equal(joinEvt.actorNickname, `${tag}-p1`); // 房间内昵称优先
});

test('F1 事件 DTO：payload 为对象、createdAt 为 UTC ISO、id 为数字游标', async () => {
  const { roomNo, users, tag } = await seedEvents();
  const res = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc', limit: 1 });
  const evt = res.body.events[0];
  assert.equal(typeof evt.id, 'number');
  assert.equal(evt.type, 'room_created');
  assert.equal(typeof evt.payload, 'object');
  assert.ok(!/Invalid Date/.test(evt.createdAt) && evt.createdAt.endsWith('Z'));
});

test('F2 latest：游标端点返回最大事件 id', async () => {
  const { roomNo, users, tag } = await seedEvents();
  const latest = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed/latest`);
  assert.equal(latest.status, 200);
  const all = await users[`${tag}-host`].get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  assert.equal(latest.body.latestEventId, all.body.events[all.body.events.length - 1].id);

  // 新建房间自带 3 条事件（room_created / game_started / round_opened），latest 即其最后一条
  const freshRoom = await app.asUser('f-host9').post('/api/rooms', { baseChips: 100 }).expect(201);
  const freshLatest = await app.asUser('f-host9').get(`/api/rooms/${freshRoom.body.roomNo}/feed/latest`);
  const freshFeed = await app.asUser('f-host9').get(`/api/rooms/${freshRoom.body.roomNo}/feed`).query({ order: 'asc' });
  assert.equal(freshFeed.body.events.length, 3);
  assert.equal(freshLatest.body.latestEventId, freshFeed.body.events[2].id);
});

test('F1 已解散房间公屏仍可读（AC-09 只读保留）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'f-host-d', players: [] });
  await users['f-host-d'].post(`/api/rooms/${roomNo}/dissolve`, {}).expect(204);
  const res = await users['f-host-d'].get(`/api/rooms/${roomNo}/feed`);
  assert.equal(res.status, 200);
  assert.ok(res.body.events.length >= 4);
});

test('F1 不存在的房间 → 404', async () => {
  const res = await app.asUser('f-nobody').get('/api/rooms/654321/feed');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'ROOM_NOT_FOUND');
});
