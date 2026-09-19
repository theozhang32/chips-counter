// M3：WebSocket 网关与实时推送（AC-13：推送时延 + 断线补拉配合 F1）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createTestApp, setupRoom } from './helpers/app.js';

let app;

before(async () => {
  app = await createTestApp();
});

after(async () => {
  await app.teardown();
});

async function getToken(openid) {
  const res = await app.asUser(openid).post('/api/auth/session', {});
  return { token: res.body.token, player: res.body.player };
}

// 连接并完成 hello/welcome 握手
async function connect(openid, roomNo) {
  const { token } = await getToken(openid);
  const ws = new WebSocket(app.wsUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const welcome = await roundTrip(ws, { type: 'hello', token, roomNo });
  assert.equal(welcome.type, 'welcome');
  return { ws, welcome };
}

// 发送一帧并等待下一帧
function roundTrip(ws, frame) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('frame timeout')), 5000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    ws.send(JSON.stringify(frame));
  });
}

function nextFrame(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('frame timeout')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function waitClose(ws, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: null, reason: 'timeout' }), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

test('hello → welcome：快照 + latestEventId + serverTime；快照字段齐全', async () => {
  const { roomNo } = await setupRoom(app, { host: 'w-host', players: ['w-p1'] });
  const { ws, welcome } = await connect('w-host', roomNo);
  const snap = welcome.snapshot;
  assert.equal(snap.roomNo, roomNo);
  assert.equal(snap.gameSeq, 1);
  assert.equal(snap.roundSeq, 1);
  assert.equal(snap.pool, 0);
  assert.equal(snap.members.length, 2);
  assert.ok(welcome.latestEventId > 0);
  assert.ok(welcome.serverTime.endsWith('Z'));
  ws.close();
});

test('AC-13 动作后 <1s 收到 events 帧：事件 + 最新快照（NFR-11）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'w-host2', players: ['w-p1x'] });
  const { ws } = await connect('w-host2', roomNo);
  const started = Date.now();
  const pendingFrame = nextFrame(ws);

  await users['w-p1x'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 250 }).expect(200);
  const frame = await pendingFrame;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1000, `推送耗时 ${elapsed}ms`);

  assert.equal(frame.type, 'events');
  assert.equal(frame.events.length, 1);
  assert.equal(frame.events[0].type, 'action_bet');
  assert.equal(frame.events[0].payload.amount, 250);
  assert.equal(frame.snapshot.pool, 250);
  assert.equal(frame.snapshot.members.find((m) => m.nickname === 'w-p1x').chips, 750);
  ws.close();
});

test('多连接同收：同一身份多连接 + 不同身份均在频道内（D17：不要求成员身份）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'w-host3', players: ['w-p1y'] });
  const a = await connect('w-host3', roomNo);
  const b = await connect('w-host3', roomNo); // 同身份第二连接
  const c = await connect('w-spectator', roomNo); // 围观者

  const fa = nextFrame(a.ws);
  const fb = nextFrame(b.ws);
  const fc = nextFrame(c.ws);
  await users['w-p1y'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 50 }).expect(200);
  const [ra, rb, rc] = await Promise.all([fa, fb, fc]);
  for (const r of [ra, rb, rc]) {
    assert.equal(r.type, 'events');
    assert.equal(r.events[0].type, 'action_bet');
  }
  [a, b, c].forEach((x) => x.ws.close());
});

test('收池换轮一事务推 3 事件且 id 升序', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'w-host4', players: ['w-p1z'] });
  await users['w-p1z'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  const { ws } = await connect('w-host4', roomNo);
  const pending = nextFrame(ws);
  await users['w-host4'].post(`/api/rooms/${roomNo}/actions/collect`, {}).expect(200);
  const frame = await pending;
  assert.deepEqual(
    frame.events.map((e) => e.type),
    ['action_collect', 'round_closed', 'round_opened']
  );
  const ids = frame.events.map((e) => e.id);
  assert.ok(ids[0] < ids[1] && ids[1] < ids[2]);
  assert.equal(frame.snapshot.roundSeq, 2);
  ws.close();
});

test('坏令牌 → error 帧 + close 4001', async () => {
  const { roomNo } = await setupRoom(app, { host: 'w-host5', players: [] });
  const ws = new WebSocket(app.wsUrl);
  await new Promise((resolve) => ws.once('open', resolve));
  const errorFrame = nextFrame(ws);
  ws.send(JSON.stringify({ type: 'hello', token: 'garbage.token', roomNo }));
  const err = await errorFrame;
  assert.equal(err.type, 'error');
  assert.equal(err.code, 'AUTH_INVALID');
  const closed = await waitClose(ws);
  assert.equal(closed.code, 4001);
});

test('房间不存在 → close 4003；首帧非 hello → close 4002', async () => {
  const { token } = await getToken('w-user6');
  const ws = new WebSocket(app.wsUrl);
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'hello', token, roomNo: 999999 }));
  const closed = await waitClose(ws);
  assert.equal(closed.code, 4003);

  const ws2 = new WebSocket(app.wsUrl);
  await new Promise((resolve) => ws2.once('open', resolve));
  ws2.send(JSON.stringify({ type: 'ping', ts: 1 }));
  const closed2 = await waitClose(ws2);
  assert.equal(closed2.code, 4002);
});

test('非 /ws 路径 upgrade 被拒绝', async () => {
  const ws = new WebSocket(app.wsUrl.replace(/\/ws$/, '/other'));
  const closedOrError = await new Promise((resolve) => {
    ws.once('error', () => resolve('error'));
    ws.once('close', () => resolve('closed'));
  });
  assert.ok(['error', 'closed'].includes(closedOrError));
});

test('应用层 ping → pong（原样带回 ts）', async () => {
  const { roomNo } = await setupRoom(app, { host: 'w-host7', players: [] });
  const { ws } = await connect('w-host7', roomNo);
  const pong = await roundTrip(ws, { type: 'ping', ts: 1726650000000 });
  assert.equal(pong.type, 'pong');
  assert.equal(pong.ts, 1726650000000);
  ws.close();
});

test('AC-13 断线补拉：断线期间事件经 afterId 补拉不丢不重，重连后继续实时收', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'w-host8', players: ['w-p1q'] });
  const first = await connect('w-host8', roomNo);
  const cursor = first.welcome.latestEventId;
  first.ws.close();

  // 断线期间发生 3 笔动作
  await users['w-p1q'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 10 }).expect(200);
  await users['w-p1q'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 20 }).expect(200);
  await users['w-host8'].post(`/api/rooms/${roomNo}/actions/collect`, {}).expect(200);

  // 重连 → welcome.latestEventId > cursor → REST 补拉
  const second = await connect('w-host8', roomNo);
  assert.ok(second.welcome.latestEventId > cursor);
  const backfill = await users['w-host8'].get(`/api/rooms/${roomNo}/feed`).query({ afterId: cursor, order: 'asc' });
  const missedTypes = backfill.body.events.map((e) => e.type);
  assert.deepEqual(missedTypes, ['action_bet', 'action_bet', 'action_collect', 'round_closed', 'round_opened']);
  const ids = backfill.body.events.map((e) => e.id);
  assert.ok(ids.every((id) => id > cursor));

  // 补拉后继续实时接收
  const pending = nextFrame(second.ws);
  await users['w-p1q'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 5 }).expect(200);
  const frame = await pending;
  assert.equal(frame.events[0].type, 'action_bet');
  assert.equal(frame.events[0].id, second.welcome.latestEventId + 1);
  second.ws.close();
});

test('解散房间：频道保留（不再有推送），连接不被强制关闭', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'w-host9', players: [] });
  const { ws } = await connect('w-host9', roomNo);
  // 广播先于 HTTP 响应到达，须在发起命令前挂监听
  const pending = nextFrame(ws);
  await users['w-host9'].post(`/api/rooms/${roomNo}/dissolve`, {}).expect(204);
  const frame = await pending; // 解散事件本身仍推送（频道保留只读）
  assert.equal(frame.events[0].type, 'room_dissolved');
  assert.equal(frame.snapshot.status, 'dissolved');
  // 之后无新推送；连接保持打开（给 200ms 观察窗口）
  let unexpected = null;
  ws.once('message', (data) => (unexpected = data.toString()));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(unexpected, null);
  ws.close();
});
