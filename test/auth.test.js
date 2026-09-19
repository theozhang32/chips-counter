// M1：身份认证（A1~A4、D16/D18）
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

test('A1 session：缺身份头 → 401 AUTH_REQUIRED', async () => {
  const res = await app.request.post('/api/auth/session').send({});
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'AUTH_REQUIRED');
});

test('A1 session：首次自动注册，默认昵称"玩家+4 位随机"，返回 WS 令牌', async () => {
  const res = await app.asUser('auth-user-1').post('/api/auth/session', {});
  assert.equal(res.status, 200);
  assert.ok(res.body.token);
  assert.match(res.body.player.nickname, /^玩家[A-Z0-9]{4}$/);
  assert.equal(res.body.player.playerId, 'auth-user-1');
  assert.ok(res.body.player.createdAt);
});

test('A1 session：重复调用幂等（同一身份同一昵称）', async () => {
  const first = await app.asUser('auth-user-1').post('/api/auth/session', {});
  const second = await app.asUser('auth-user-1').post('/api/auth/session', {});
  assert.equal(second.body.player.nickname, first.body.player.nickname);
});

test('A3 me：无房间时 room 为 null', async () => {
  const res = await app.asUser('auth-user-2').get('/api/auth/me');
  assert.equal(res.status, 200);
  assert.equal(res.body.room, null);
  assert.equal(res.body.player.playerId, 'auth-user-2');
});

test('A3 me：冷启动恢复所在房间（active 成员关系）', async () => {
  const { roomNo } = await setupRoom(app, { host: 'auth-host', players: ['auth-member'] });
  const res = await app.asUser('auth-member').get('/api/auth/me');
  assert.equal(res.body.room.roomNo, roomNo);
  assert.equal(res.body.room.status, 'active');
});

test('A4 PUT me：设置默认昵称', async () => {
  const res = await app.asUser('auth-user-3').put('/api/auth/me', { nickname: '德扑大师' });
  assert.equal(res.status, 200);
  assert.equal(res.body.player.nickname, '德扑大师');

  const again = await app.asUser('auth-user-3').post('/api/auth/session', {});
  assert.equal(again.body.player.nickname, '德扑大师');
});

test('A4 PUT me：昵称超长/为空 → 400 NICKNAME_INVALID', async () => {
  const tooLong = await app.asUser('auth-user-4').put('/api/auth/me', { nickname: 'x'.repeat(17) });
  assert.equal(tooLong.status, 400);
  assert.equal(tooLong.body.error.code, 'NICKNAME_INVALID');

  const empty = await app.asUser('auth-user-4').put('/api/auth/me', { nickname: '' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.code, 'INVALID_PARAMS');
});

test('A4 默认昵称影响后续加入房间的缺省值，已加入的房间内昵称不变', async () => {
  const { roomNo } = await setupRoom(app, { host: 'auth-host2', players: ['auth-member2'] });
  const before = await app.asUser('auth-member2').get(`/api/rooms/${roomNo}`);
  const roomNickname = before.body.members.find((m) => m.nickname === 'auth-member2').nickname;
  await app.asUser('auth-member2').put('/api/auth/me', { nickname: '新默认昵称' });
  const after = await app.asUser('auth-member2').get(`/api/rooms/${roomNo}`);
  assert.equal(after.body.members.find((m) => m.nickname === 'auth-member2').nickname, roomNickname);
  // 新身份用默认昵称加入另一房间时采用新默认昵称
  const newRoom = await app.asUser('auth-host3').post('/api/rooms', { baseChips: 100 }).expect(201);
  await app.asUser('auth-member2').post('/api/auth/me', { nickname: '新默认昵称' }); // 已在房，改默认不影响房内
  const joiner = await app.asUser('auth-newcomer').put('/api/auth/me', { nickname: '默认甲' });
  assert.equal(joiner.body.player.nickname, '默认甲');
  await app.asUser('auth-newcomer').post(`/api/rooms/${newRoom.body.roomNo}/join`, {}).expect(200);
  const ov = await app.asUser('auth-host3').get(`/api/rooms/${newRoom.body.roomNo}`);
  assert.equal(ov.body.members.find((m) => m.nickname === '默认甲').nickname, '默认甲');
});

test('S1 health：免鉴权 200', async () => {
  const res = await app.request.get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('非法 JSON 请求体 → 400 INVALID_PARAMS', async () => {
  const res = await app.request
    .post('/api/auth/session')
    .set('x-dev-openid', 'auth-user-5')
    .set('Content-Type', 'application/json')
    .send('{"broken"');
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_PARAMS');
});
