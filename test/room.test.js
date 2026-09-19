// M2：房间生命周期（AC-01/02/07/09/12 房间侧 + R1~R9 + 约束错误翻译）
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

test('AC-01 R1 建房即开局：房主/游戏1/轮次1/池0/本金 + 3 事件', async () => {
  const res = await app.asUser('host-a').post('/api/rooms', { baseChips: 1000 });
  assert.equal(res.status, 201);
  const body = res.body;
  assert.equal(body.me.isHost, true);
  assert.equal(body.gameSeq, 1);
  assert.equal(body.roundSeq, 1);
  assert.equal(body.pool, 0);
  assert.equal(body.issuedChips, 1000);
  assert.equal(body.members.length, 1);
  assert.equal(body.members[0].chips, 1000);
  assert.deepEqual(body.betOptions, [50, 100, 200, 250, 500, 1000]); // D19
  assert.ok(body.name.endsWith('的房间'));

  const feed = await app.asUser('host-a').get(`/api/rooms/${body.roomNo}/feed`).query({ order: 'asc' });
  const types = feed.body.events.map((e) => e.type);
  assert.deepEqual(types, ['room_created', 'game_started', 'round_opened']);
  const gameStarted = feed.body.events.find((e) => e.type === 'game_started');
  assert.deepEqual(gameStarted.payload.members, [{ memberId: body.members[0].memberId, chips: 1000 }]);
});

test('R1 建房参数：非法本金 → 400 BASE_CHIPS_INVALID；缺本金 → 400', async () => {
  const bad = await app.asUser('u-bad-base').post('/api/rooms', { baseChips: 300 });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'BASE_CHIPS_INVALID');

  const missing = await app.asUser('u-bad-base').post('/api/rooms', {});
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error.code, 'INVALID_PARAMS');
});

test('AC-02 R2 加入：获得本金、出现在总览、公屏记录、me 填充', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-b', players: ['p-b1', 'p-b2'] });
  const overview = await app.asUser('p-b1').get(`/api/rooms/${roomNo}`);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.members.length, 3);
  assert.equal(overview.body.issuedChips, 3000);
  const me = overview.body.members.find((m) => m.nickname === 'p-b1');
  assert.equal(me.chips, 1000);
  assert.equal(overview.body.me.memberId, me.memberId);
  assert.equal(overview.body.me.isHost, false);

  const feed = await app.asUser('host-b').get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  assert.ok(feed.body.events.some((e) => e.type === 'player_joined' && e.payload.nickname === 'p-b1'));
});

test('AC-02/INV-7：仍在房间内重复加入本房间 → 409；加入其他房间 → 409', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-c', players: ['p-c1'] });
  const dup = await app.asUser('p-c1').post(`/api/rooms/${roomNo}/join`, {});
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'ALREADY_IN_ROOM');

  // 第二个房间由不在任何房间的新身份创建（房内身份再建房会被 INV-7 拒绝，顺带验证）
  const other = await app.asUser('u-other-room').post('/api/rooms', { baseChips: 200 }).expect(201);
  const otherNo = other.body.roomNo;
  const cross = await app.asUser('p-c1').post(`/api/rooms/${otherNo}/join`, {});
  assert.equal(cross.status, 409);
  assert.equal(cross.body.error.code, 'ALREADY_IN_ROOM');

  // 在房间内也不能再建房（INV-7）
  const createWhileIn = await app.asUser('p-c1').post('/api/rooms', { baseChips: 100 });
  assert.equal(createWhileIn.status, 409);
  assert.equal(createWhileIn.body.error.code, 'ALREADY_IN_ROOM');
});

test('R2：房间不存在 → 404 ROOM_NOT_FOUND；昵称被占用 → 409 NICKNAME_TAKEN（大小写不敏感）', async () => {
  const notFound = await app.asUser('u-nf').post('/api/rooms/999999/join', {});
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, 'ROOM_NOT_FOUND');

  const { roomNo } = await setupRoom(app, { host: 'host-d', players: [] });
  await app.asUser('p-d1').post(`/api/rooms/${roomNo}/join`, { nickname: 'Alpha' }).expect(200);
  const taken = await app.asUser('p-d2').post(`/api/rooms/${roomNo}/join`, { nickname: 'alpha' });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'NICKNAME_TAKEN');
});

test('AC-02 非房主执行管理操作 → 403（R6/R7/R8/R9）', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-e', players: ['p-e1'] });
  const member = app.asUser('p-e1');

  const set = await member.put(`/api/rooms/${roomNo}/settings/base-chips`, { baseChips: 500 });
  assert.equal(set.status, 403);
  assert.equal(set.body.error.code, 'NOT_HOST');

  const transfer = await member.post(`/api/rooms/${roomNo}/host/transfer`, { toMemberId: 'whatever' });
  assert.equal(transfer.status, 403);
  assert.equal(transfer.body.error.code, 'NOT_HOST');

  const rebuild = await member.post(`/api/rooms/${roomNo}/rebuild`, {});
  assert.equal(rebuild.status, 403);
  assert.equal(rebuild.body.error.code, 'NOT_HOST');

  const dissolve = await member.post(`/api/rooms/${roomNo}/dissolve`, {});
  assert.equal(dissolve.status, 403);
  assert.equal(dissolve.body.error.code, 'NOT_HOST');

  // 非成员（旁观者）→ 403 NOT_MEMBER
  const stranger = await app.asUser('stranger-e').post(`/api/rooms/${roomNo}/leave`, {});
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error.code, 'NOT_MEMBER');
});

test('R6 设置本金：房主成功，betOptions 跟随，公屏记录，仅影响后续游戏', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-f', players: ['p-f1'] });
  const res = await app.asUser('host-f').put(`/api/rooms/${roomNo}/settings/base-chips`, { baseChips: 500 });
  assert.equal(res.status, 200);
  assert.equal(res.body.baseChips, 500);
  assert.deepEqual(res.body.betOptions, [25, 50, 100, 125, 250, 500]);

  const overview = await app.asUser('host-f').get(`/api/rooms/${roomNo}`);
  assert.equal(overview.body.baseChips, 500);
  assert.equal(overview.body.issuedChips, 2000); // 当前游戏发放额不变（仅影响后续）
  assert.deepEqual(overview.body.betOptions, [25, 50, 100, 125, 250, 500]);

  const feed = await app.asUser('host-f').get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  const evt = feed.body.events.find((e) => e.type === 'setting_changed');
  assert.deepEqual(evt.payload, { item: 'base_chips', oldValue: 1000, newValue: 500 });
});

test('R7 移交房主：目标成为房主，原房主失去权限（AC-09 前半）', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-g', players: ['p-g1'] });
  const overview1 = await app.asUser('host-g').get(`/api/rooms/${roomNo}`);
  const targetId = overview1.body.me.memberId;
  const otherId = overview1.body.members.find((m) => !m.isHost).memberId;

  const self = await app.asUser('host-g').post(`/api/rooms/${roomNo}/host/transfer`, { toMemberId: targetId });
  assert.equal(self.status, 400);
  assert.equal(self.body.error.code, 'TRANSFER_SELF');

  const invalid = await app.asUser('host-g').post(`/api/rooms/${roomNo}/host/transfer`, { toMemberId: 'no-such-id' });
  assert.equal(invalid.status, 409);
  assert.equal(invalid.body.error.code, 'TRANSFER_TARGET_INVALID');

  const res = await app.asUser('host-g').post(`/api/rooms/${roomNo}/host/transfer`, { toMemberId: otherId });
  assert.equal(res.status, 200);
  assert.equal(res.body.me.isHost, false); // 原房主视角

  const asNewHost = await app.asUser('p-g1').get(`/api/rooms/${roomNo}`);
  assert.equal(asNewHost.body.me.isHost, true);

  // 原房主再解散 → 403 NOT_HOST；新房主可解散
  const denied = await app.asUser('host-g').post(`/api/rooms/${roomNo}/dissolve`, {});
  assert.equal(denied.status, 403);
  await app.asUser('p-g1').post(`/api/rooms/${roomNo}/dissolve`, {}).expect(204);
});

test('R7：移交目标为已离开成员 → 409 TRANSFER_TARGET_INVALID', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-h', players: ['p-h1'] });
  await app.asUser('p-h1').post(`/api/rooms/${roomNo}/leave`, {}).expect(204);
  const overview = await app.asUser('host-h').get(`/api/rooms/${roomNo}`);
  const leftId = overview.body.members.find((m) => m.status === 'left').memberId;
  const res = await app.asUser('host-h').post(`/api/rooms/${roomNo}/host/transfer`, { toMemberId: leftId });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'TRANSFER_TARGET_INVALID');
});

test('AC-12 R3/R2 离开与回归（未重建）：筹码定格、动作被拒、公屏留痕、恢复', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-i', players: ['p-i1', 'p-i2'] });
  // p-i1 下注 100 后离开 → 定格 900
  await app.asUser('p-i1').post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  await app.asUser('p-i1').post(`/api/rooms/${roomNo}/leave`, {}).expect(204);

  const overview = await app.asUser('host-i').get(`/api/rooms/${roomNo}`);
  const left = overview.body.members.find((m) => m.status === 'left');
  assert.equal(left.chips, 900);
  assert.equal(overview.body.pool, 100);

  const rejected = await app.asUser('p-i1').post(`/api/rooms/${roomNo}/actions/bet`, { amount: 50 });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.body.error.code, 'NOT_MEMBER');

  const feed = await app.asUser('host-i').get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  const leftEvt = feed.body.events.find((e) => e.type === 'player_left');
  assert.equal(leftEvt.payload.chipsLeft, 900);

  // 回归：恢复定格筹码（reissued=false）
  const rejoined = await app.asUser('p-i1').post(`/api/rooms/${roomNo}/join`, {});
  assert.equal(rejoined.status, 200);
  const after = await app.asUser('host-i').get(`/api/rooms/${roomNo}`);
  const returned = after.body.members.find((m) => m.status === 'active' && m.nickname === 'p-i1');
  assert.equal(returned.chips, 900);
  assert.equal(after.body.issuedChips, 3000); // 未重发，发放额不变
  const returnEvt = (
    await app.asUser('host-i').get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' })
  ).body.events.find((e) => e.type === 'player_returned');
  assert.deepEqual(returnEvt.payload, { memberId: returned.memberId, nickname: 'p-i1', reissued: false, chips: 900 });
});

test('AC-12 离开期间发生重建 → 回归按本金重发并计入新游戏发放额（D20）', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-j', players: ['p-j1'] });
  await app.asUser('p-j1').post(`/api/rooms/${roomNo}/leave`, {}).expect(204);
  await app.asUser('host-j').post(`/api/rooms/${roomNo}/rebuild`, { confirmPoolLoss: true }).expect(200);

  const res = await app.asUser('p-j1').post(`/api/rooms/${roomNo}/join`, {});
  assert.equal(res.status, 200);
  const overview = await app.asUser('host-j').get(`/api/rooms/${roomNo}`);
  const member = overview.body.members.find((m) => m.nickname === 'p-j1');
  assert.equal(member.chips, 1000);
  assert.equal(member.status, 'active');
  assert.equal(overview.body.issuedChips, 2000); // 房主1000 + 回归重发1000
  const returnEvt = (
    await app.asUser('host-j').get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' })
  ).body.events.find((e) => e.type === 'player_returned');
  assert.equal(returnEvt.payload.reissued, true);
  assert.equal(returnEvt.payload.chips, 1000);
});

test('AC-07 R8 重建：池非 0 未确认 → 409 REBUILD_CONFIRM_REQUIRED(details.currentPool) 且无变更', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-k', players: ['p-k1'] });
  await app.asUser('p-k1').post(`/api/rooms/${roomNo}/actions/bet`, { amount: 700 }).expect(200);

  const res = await app.asUser('host-k').post(`/api/rooms/${roomNo}/rebuild`, {});
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'REBUILD_CONFIRM_REQUIRED');
  assert.equal(res.body.error.details.currentPool, 700);

  const overview = await app.asUser('host-k').get(`/api/rooms/${roomNo}`);
  assert.equal(overview.body.gameSeq, 1);
  assert.equal(overview.body.pool, 700);
});

test('AC-07 R8 重建（确认）：在场成员回本金、旧游戏 ended、事件齐全、离开成员不动', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-l', players: ['p-l1', 'p-l2', 'p-l3'] });
  await app.asUser('p-l1').post(`/api/rooms/${roomNo}/actions/bet`, { amount: 400 }).expect(200);
  await app.asUser('p-l2').post(`/api/rooms/${roomNo}/actions/bet`, { amount: 200 }).expect(200);
  await app.asUser('p-l3').post(`/api/rooms/${roomNo}/leave`, {}).expect(204); // 定格 1000 离开

  const res = await app.asUser('host-l').post(`/api/rooms/${roomNo}/rebuild`, { confirmPoolLoss: true });
  assert.equal(res.status, 200);
  assert.equal(res.body.gameSeq, 2);
  assert.equal(res.body.roundSeq, 1);
  assert.equal(res.body.pool, 0);
  assert.equal(res.body.issuedChips, 3000); // 在场 3 人（host-l, p-l1, p-l2）×1000；p-l3 已离开不重置不发

  const overview = await app.asUser('host-l').get(`/api/rooms/${roomNo}`);
  const byName = Object.fromEntries(overview.body.members.map((m) => [m.nickname, m]));
  assert.equal(byName['host-l'].chips, 1000);
  assert.equal(byName['p-l1'].chips, 1000);
  assert.equal(byName['p-l2'].chips, 1000);
  assert.equal(byName['p-l3'].chips, 1000); // 定格不动
  assert.equal(byName['p-l3'].status, 'left');

  const feed = await app.asUser('host-l').get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  const rebuilt = feed.body.events.find((e) => e.type === 'game_rebuilt');
  assert.equal(rebuilt.payload.oldGameSeq, 1);
  assert.equal(rebuilt.payload.newGameSeq, 2);
  assert.equal(rebuilt.payload.sealedPool, 600);
  assert.equal(rebuilt.payload.issuedChips, 3000);
  const roundClosed = feed.body.events.filter((e) => e.type === 'round_closed').pop();
  assert.equal(roundClosed.payload.finalPool, 600); // 封存值
  const lastRoundOpened = feed.body.events.filter((e) => e.type === 'round_opened').pop();
  assert.deepEqual(lastRoundOpened.payload, { gameSeq: 2, roundSeq: 1 });

  // 旧游戏 ended：重建后再重建 → gameSeq 3
  const again = await app.asUser('host-l').post(`/api/rooms/${roomNo}/rebuild`, {});
  assert.equal(again.status, 200); // 池为 0 无需确认
  assert.equal(again.body.gameSeq, 3);
});

test('AC-09 R9 解散：一切写操作 409、读操作 200、重复解散 409', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-m', players: ['p-m1'] });
  await app.asUser('host-m').post(`/api/rooms/${roomNo}/dissolve`, {}).expect(204);

  const cases = [
    ['post', `/api/rooms/${roomNo}/join`, {}],
    ['post', `/api/rooms/${roomNo}/leave`, {}],
    ['put', `/api/rooms/${roomNo}/settings/base-chips`, { baseChips: 500 }],
    ['post', `/api/rooms/${roomNo}/rebuild`, {}],
    ['post', `/api/rooms/${roomNo}/dissolve`, {}],
    ['post', `/api/rooms/${roomNo}/actions/bet`, { amount: 10 }],
    ['post', `/api/rooms/${roomNo}/actions/collect`, {}],
  ];
  for (const [method, url, body] of cases) {
    const res = await app.asUser('host-m')[method](url, body);
    assert.equal(res.status, 409, `${method} ${url} 应 409`);
    assert.equal(res.body.error.code, 'ROOM_DISSOLVED');
  }

  const overview = await app.asUser('host-m').get(`/api/rooms/${roomNo}`);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.status, 'dissolved');
  assert.equal(
    overview.body.members.every((m) => m.status === 'left'),
    true
  );

  const feed = await app.asUser('host-m').get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  assert.equal(feed.status, 200);
  assert.ok(feed.body.events.some((e) => e.type === 'room_dissolved'));
  assert.equal(feed.body.events.find((e) => e.type === 'room_dissolved').payload.memberCount, 2);

  // 解散后 me 的 room 恢复 null（全部成员已 left），可再加入新房
  const me = await app.asUser('host-m').get('/api/auth/me');
  assert.equal(me.body.room, null);
  await app.asUser('host-m').post('/api/rooms', { baseChips: 100 }).expect(201);
});

test('R5 筹码榜：chips 降序、并列按 joined_at 升序', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-n', players: ['p-n1', 'p-n2'] });
  await app.asUser('p-n1').post(`/api/rooms/${roomNo}/actions/bet`, { amount: 500 }).expect(200);
  await app.asUser('host-n').post(`/api/rooms/${roomNo}/actions/collect`, {}).expect(200); // 收 500

  const res = await app.asUser('p-n2').get(`/api/rooms/${roomNo}/leaderboard`);
  assert.equal(res.status, 200);
  const chips = res.body.ranking.map((m) => m.chips);
  assert.deepEqual(
    chips,
    [...chips].sort((a, b) => b - a)
  );
  assert.equal(res.body.ranking[0].nickname, 'host-n');
  assert.equal(res.body.ranking[0].chips, 1500);
  assert.equal(res.body.ranking[0].isHost, true);
  // p-n2 与 p-n1 并列 500？不：p-n1=500，p-n2=1000
  assert.equal(res.body.ranking[1].nickname, 'p-n2');
});

test('D17 只读围观：非成员登录身份可读总览/筹码榜/公屏（me=null）', async () => {
  const { roomNo } = await setupRoom(app, { host: 'host-o', players: [] });
  const spectator = app.asUser('spectator-o');
  const overview = await spectator.get(`/api/rooms/${roomNo}`);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.me, null);
  await spectator.get(`/api/rooms/${roomNo}/leaderboard`).expect(200);
  await spectator.get(`/api/rooms/${roomNo}/feed`).expect(200);
});

test('D20 边界：游戏 started_at == left_at（同毫秒离开后当前游戏未更替）→ 恢复不重发', async () => {
  // 直接操作库：把成员 left_at 设为其当前游戏 started_at 相同值，再走回归
  const { roomNo } = await setupRoom(app, { host: 'host-p', players: ['p-p1'] });
  await app.asUser('p-p1').post(`/api/rooms/${roomNo}/leave`, {}).expect(204);
  const { roomRepository, gameRepository } = app.container.repositories;
  const { sequelize } = app.container;
  const room = await roomRepository.findByRoomNo(roomNo);
  const game = await gameRepository.findInProgress(room.id);
  await sequelize.query('UPDATE room_player SET left_at = ? WHERE room_id = ?', {
    replacements: [game.started_at, room.id],
  });
  const res = await app.asUser('p-p1').post(`/api/rooms/${roomNo}/join`, {});
  assert.equal(res.status, 200);
  const overview = await app.asUser('host-p').get(`/api/rooms/${roomNo}`);
  const member = overview.body.members.find((m) => m.nickname === 'p-p1');
  assert.equal(member.chips, 1000); // 恢复（本就是 1000），issued 不变
  assert.equal(overview.body.issuedChips, 2000);
});
