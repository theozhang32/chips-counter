// M4：玩家动作（AC-03/04/05/06/08/11 + 幂等 + 并发）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createTestApp, setupRoom } from './helpers/app.js';

let app;

before(async () => {
  app = await createTestApp();
});

after(async () => {
  await app.teardown();
});

const overviewOf = async (client, roomNo) => (await client.get(`/api/rooms/${roomNo}`)).body;

const conservationOf = (overview) => {
  const sum = overview.members.filter((m) => m.status === 'active').reduce((s, m) => s + m.chips, 0);
  return sum + overview.pool;
};

test('C1 下注：ack 字段、chips/pool 更新、公屏事件（AC-03 手动输入）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'a-host', players: ['a-p1'] });
  const res = await users['a-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 200 });
  assert.equal(res.status, 200);
  assert.equal(res.body.type, 'bet');
  assert.equal(res.body.amount, 200);
  assert.equal(res.body.isAllIn, false);
  assert.equal(res.body.chipsAfter, 800);
  assert.equal(res.body.poolAfter, 200);
  assert.equal(res.body.gameSeq, 1);
  assert.equal(res.body.roundSeq, 1);
  assert.ok(res.body.actionId);

  const overview = await overviewOf(users['a-host'], roomNo);
  assert.equal(overview.pool, 200);
  const member = overview.members.find((m) => m.nickname === 'a-p1');
  assert.equal(member.chips, 800);
  assert.equal(conservationOf(overview), 2000); // AC-06

  const feed = await users['a-host'].get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  const evt = feed.body.events.find((e) => e.type === 'action_bet');
  assert.equal(evt.payload.amount, 200);
  assert.equal(evt.payload.chipsAfter, 800);
  assert.equal(evt.payload.poolAfter, 200);
  assert.equal(evt.payload.isAllIn, false);
});

test('C1 金额校验：0/负数/小数/字符串 → 400 AMOUNT_INVALID；超额 → 409 BET_EXCEEDS_CHIPS 且状态不变（AC-03/INV-1）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'b-host', players: ['b-p1'] });
  for (const bad of [0, -5, 1.5, 'abc']) {
    const res = await users['b-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: bad });
    assert.equal(res.status, 400, `amount=${bad}`);
    assert.equal(res.body.error.code, 'AMOUNT_INVALID');
  }
  const exceeded = await users['b-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 1001 });
  assert.equal(exceeded.status, 409);
  assert.equal(exceeded.body.error.code, 'BET_EXCEEDS_CHIPS');
  const overview = await overviewOf(users['b-host'], roomNo);
  assert.equal(overview.pool, 0);
  assert.equal(overview.members.find((m) => m.nickname === 'b-p1').chips, 1000);
});

test('C2 全下：金额=剩余筹码、isAllIn=true、chips 归 0（AC-03）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'c-host', players: ['c-p1'] });
  const res = await users['c-p1'].post(`/api/rooms/${roomNo}/actions/all-in`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.amount, 1000);
  assert.equal(res.body.isAllIn, true);
  assert.equal(res.body.chipsAfter, 0);
  assert.equal(res.body.poolAfter, 1000);

  // 筹码为 0 再全下 → BET_EXCEEDS_CHIPS
  const again = await users['c-p1'].post(`/api/rooms/${roomNo}/actions/all-in`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'BET_EXCEEDS_CHIPS');
});

test('C1 amount == chips 的手动下注也打全下标记（FR-402）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'd-host', players: ['d-p1'] });
  const res = await users['d-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 1000 });
  assert.equal(res.body.isAllIn, true);
});

test('AC-08 顺序自由：同一玩家连续下注两次成功；空池收池 409', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'e-host', players: ['e-p1'] });
  // 先验证空池收池被拒
  const empty = await users['e-host'].post(`/api/rooms/${roomNo}/actions/collect`, {});
  assert.equal(empty.status, 409);
  assert.equal(empty.body.error.code, 'POOL_EMPTY');

  await users['e-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  await users['e-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  // 收走后空池再收 → 409
  await users['e-p1'].post(`/api/rooms/${roomNo}/actions/collect`, {}).expect(200);
  const again = await users['e-p1'].post(`/api/rooms/${roomNo}/actions/collect`, {});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'POOL_EMPTY');
});

test('AC-04 C3 收池换轮：池0、roundSeq+1、3 事件原子生效（INV-6）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'f-host', players: ['f-p1'] });
  await users['f-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 300 }).expect(200);
  const res = await users['f-host'].post(`/api/rooms/${roomNo}/actions/collect`, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.type, 'collect');
  assert.equal(res.body.amount, 300);
  assert.equal(res.body.chipsAfter, 1300);
  assert.equal(res.body.poolAfter, 0);
  assert.equal(res.body.roundSeq, 1);
  assert.equal(res.body.newRoundSeq, 2);

  const overview = await overviewOf(users['f-host'], roomNo);
  assert.equal(overview.pool, 0);
  assert.equal(overview.roundSeq, 2);
  assert.equal(conservationOf(overview), 2000);

  const feed = await users['f-host'].get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  const types = feed.body.events.map((e) => e.type);
  const idx = types.indexOf('action_collect');
  assert.deepEqual(types.slice(idx, idx + 3), ['action_collect', 'round_closed', 'round_opened']);
  assert.equal(feed.body.events[idx + 1].payload.finalPool, 0);
  assert.deepEqual(feed.body.events[idx + 2].payload, { gameSeq: 1, roundSeq: 2 });
});

test('AC-05 附录 A 全流程数值回放（2700 → 部分收 1200 → 收池 1500 → 轮 3）', async () => {
  // HTTP 头不支持非 ASCII，以拼音 openid 模拟甲/乙/丙/丁（房间内昵称 = openid）
  const { roomNo, users } = await setupRoom(app, {
    host: 'jia',
    players: ['yi', 'bing', 'ding'],
    baseChips: 1000,
  });

  // 轮次 1：甲/乙/丙 各下注 100，甲收池 300
  for (const p of ['jia', 'yi', 'bing']) {
    await users[p].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  }
  await users['jia'].post(`/api/rooms/${roomNo}/actions/collect`, {}).expect(200);
  let ov = await overviewOf(users['jia'], roomNo);
  assert.equal(ov.roundSeq, 2);
  assert.equal(ov.pool, 0);
  const chipsAfterR1 = Object.fromEntries(ov.members.map((m) => [m.nickname, m.chips]));
  assert.deepEqual(chipsAfterR1, { jia: 1200, yi: 900, bing: 900, ding: 1000 });
  assert.equal(conservationOf(ov), 4000); // AC-06

  // 轮次 2：乙下注 300（短码场景），甲/丙/丁 各 800 → 池 2700
  await users['yi'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 300 }).expect(200);
  for (const p of ['jia', 'bing', 'ding']) {
    await users[p].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 800 }).expect(200);
  }
  ov = await overviewOf(users['jia'], roomNo);
  assert.equal(ov.pool, 2700);
  assert.equal(ov.roundSeq, 2);

  // 乙部分收注 1200 → 池余 1500，轮次不变
  const partial = await users['yi'].post(`/api/rooms/${roomNo}/actions/partial-collect`, { amount: 1200 });
  assert.equal(partial.status, 200);
  assert.equal(partial.body.type, 'partial_collect');
  assert.equal(partial.body.chipsAfter, 1800);
  assert.equal(partial.body.poolAfter, 1500);
  ov = await overviewOf(users['jia'], roomNo);
  assert.equal(ov.pool, 1500);
  assert.equal(ov.roundSeq, 2);
  assert.equal(conservationOf(ov), 4000);

  // 丙收池 1500 → 池 0，自动开轮 3
  const collect = await users['bing'].post(`/api/rooms/${roomNo}/actions/collect`, {});
  assert.equal(collect.status, 200);
  assert.equal(collect.body.amount, 1500);
  assert.equal(collect.body.newRoundSeq, 3);
  ov = await overviewOf(users['jia'], roomNo);
  assert.equal(ov.roundSeq, 3);
  assert.equal(ov.pool, 0);
  const finalChips = Object.fromEntries(ov.members.map((m) => [m.nickname, m.chips]));
  assert.deepEqual(finalChips, { jia: 400, yi: 1800, bing: 1600, ding: 200 }); // 附录 A 轮次 2 结束后
  assert.equal(conservationOf(ov), 4000);
});

test('C4 部分收注校验：amount ≥ pool → 409 PARTIAL_GE_POOL；0 → 400', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'g-host', players: ['g-p1'] });
  await users['g-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 200 }).expect(200);
  const gePool = await users['g-host'].post(`/api/rooms/${roomNo}/actions/partial-collect`, { amount: 200 });
  assert.equal(gePool.status, 409);
  assert.equal(gePool.body.error.code, 'PARTIAL_GE_POOL');
  const zero = await users['g-host'].post(`/api/rooms/${roomNo}/actions/partial-collect`, { amount: 0 });
  assert.equal(zero.status, 400);
  assert.equal(zero.body.error.code, 'AMOUNT_INVALID');
});

test('AC-11 误操作修正（单独转账）：误记下注 + 下注/收池补正，守恒仍立，无撤销端点', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'h-host', players: ['h-p1'] });
  // h-p1 误多记 100（本不应下注）
  await users['h-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  // 线下空闲时补正：h-host 先收走误入池的 100（清池），
  // 再以"下注 100 + h-p1 收池"把 100 转回 h-p1 —— 双方回到应有数值
  await users['h-host'].post(`/api/rooms/${roomNo}/actions/collect`, {}).expect(200);
  await users['h-host'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  await users['h-p1'].post(`/api/rooms/${roomNo}/actions/collect`, {}).expect(200);
  const ov = await overviewOf(users['h-host'], roomNo);
  const chips = Object.fromEntries(ov.members.map((m) => [m.nickname, m.chips]));
  assert.deepEqual(chips, { 'h-host': 1000, 'h-p1': 1000 }); // 回到应有数值
  assert.equal(conservationOf(ov), 2000);
  // 多出的轮次仅为流水（轮 3）
  assert.equal(ov.roundSeq, 3);
  // 全部动作如实保留（2 bet + 2 collect），无任何撤销痕迹
  const feed = await users['h-host'].get(`/api/rooms/${roomNo}/feed`).query({ order: 'asc' });
  assert.equal(feed.body.events.filter((e) => e.type === 'action_bet').length, 2);
  assert.equal(feed.body.events.filter((e) => e.type === 'action_collect').length, 2);
});

test('幂等：同 key 同内容 → 复用上次 ack，仅一条 action，不重复入账（FR-408）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'i-host', players: ['i-p1'] });
  const key = randomUUID();
  const first = await users['i-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100, idempotencyKey: key });
  assert.equal(first.status, 200);
  const second = await users['i-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100, idempotencyKey: key });
  assert.equal(second.status, 200);
  assert.equal(second.body.actionId, first.body.actionId);
  assert.deepEqual(second.body, first.body);

  const ov = await overviewOf(users['i-host'], roomNo);
  assert.equal(ov.pool, 100); // 只入账一次
  assert.equal(ov.members.find((m) => m.nickname === 'i-p1').chips, 900);
});

test('幂等：同 key 不同金额 → 409 IDEMPOTENCY_CONFLICT', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'j-host', players: ['j-p1'] });
  const key = randomUUID();
  await users['j-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100, idempotencyKey: key }).expect(200);
  const conflict = await users['j-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 200, idempotencyKey: key });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'IDEMPOTENCY_CONFLICT');
  // 其他成员复用同 key → 冲突
  const otherMember = await users['j-host'].post(`/api/rooms/${roomNo}/actions/bet`, {
    amount: 100,
    idempotencyKey: key,
  });
  assert.equal(otherMember.status, 409);
});

test('幂等：全下/收池的 key 复用同样生效（服务端派生金额）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'k-host', players: ['k-p1'] });
  const keyAllIn = randomUUID();
  const a1 = await users['k-p1'].post(`/api/rooms/${roomNo}/actions/all-in`, { idempotencyKey: keyAllIn });
  const a2 = await users['k-p1'].post(`/api/rooms/${roomNo}/actions/all-in`, { idempotencyKey: keyAllIn });
  assert.equal(a2.status, 200);
  assert.equal(a2.body.actionId, a1.body.actionId);
  let ov = await overviewOf(users['k-host'], roomNo);
  assert.equal(ov.pool, 1000);

  const keyCollect = randomUUID();
  const c1 = await users['k-host'].post(`/api/rooms/${roomNo}/actions/collect`, { idempotencyKey: keyCollect });
  const c2 = await users['k-host'].post(`/api/rooms/${roomNo}/actions/collect`, { idempotencyKey: keyCollect });
  assert.equal(c2.status, 200);
  assert.equal(c2.body.actionId, c1.body.actionId);
  assert.equal(c2.body.newRoundSeq, c1.body.newRoundSeq);
  ov = await overviewOf(users['k-host'], roomNo);
  assert.equal(ov.pool, 0);
  assert.equal(ov.roundSeq, 2);
});

test('幂等：跨房间复用同 key → 冲突', async () => {
  const room1 = await setupRoom(app, { host: 'l-host', players: ['l-p1'] });
  const room2 = await setupRoom(app, { host: 'l-host2', players: [] });
  const key = randomUUID();
  await room1.users['l-p1']
    .post(`/api/rooms/${room1.roomNo}/actions/bet`, { amount: 100, idempotencyKey: key })
    .expect(200);
  const res = await room2.users['l-host2'].post(`/api/rooms/${room2.roomNo}/actions/bet`, {
    amount: 100,
    idempotencyKey: key,
  });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'IDEMPOTENCY_CONFLICT');
});

test('无 key 请求不查重：连续两次相同下注产生两条记录（正常多次下注）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'm-host', players: ['m-p1'] });
  await users['m-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  await users['m-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  const ov = await overviewOf(users['m-host'], roomNo);
  assert.equal(ov.pool, 200);
});

test('并发：同房间并发 20 笔下注，队列串行、chips/pool 精确无丢失（NFR-05）', async () => {
  const players = Array.from({ length: 4 }, (_, i) => `n-p${i}`);
  const { roomNo, users } = await setupRoom(app, { host: 'n-host', players });
  const bets = [];
  for (const p of players) {
    for (let i = 0; i < 5; i++) bets.push(users[p].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 10 }));
  }
  const results = await Promise.all(bets);
  assert.ok(results.every((r) => r.status === 200));
  const ov = await overviewOf(users['n-host'], roomNo);
  assert.equal(ov.pool, 200);
  const chipsByNick = Object.fromEntries(ov.members.map((m) => [m.nickname, m.chips]));
  assert.equal(chipsByNick['n-host'], 1000); // 房主未下注
  for (const p of players) assert.equal(chipsByNick[p], 950, `${p} 应为 950`);
  assert.equal(conservationOf(ov), 5000);

  const { actionRepository } = app.container.repositories;
  const room = await app.container.repositories.roomRepository.findByRoomNo(roomNo);
  const actions = await actionRepository.listByRoomAsc(room.id);
  const seqs = actions.map((a) => a.seq);
  assert.deepEqual(
    [...seqs].sort((a, b) => a - b),
    seqs
  ); // seq 严格递增（按提交顺序）
});

test('并发：同 idempotencyKey 并发双击 → 仅一条 action 入账', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'o-host', players: ['o-p1'] });
  const key = randomUUID();
  const [r1, r2, r3] = await Promise.all([
    users['o-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100, idempotencyKey: key }),
    users['o-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100, idempotencyKey: key }),
    users['o-p1'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100, idempotencyKey: key }),
  ]);
  const oks = [r1, r2, r3].filter((r) => r.status === 200);
  assert.equal(oks.length, 3, '串行队列下全部命中预检复用');
  const ids = new Set(oks.map((r) => r.body.actionId));
  assert.equal(ids.size, 1);
  const ov = await overviewOf(users['o-host'], roomNo);
  assert.equal(ov.pool, 100);
});

test('并发：跨房间并发 join 一人一房间恰成立（INV-7 竞态收口）', async () => {
  const roomA = await app.asUser('p-race-a').post('/api/rooms', { baseChips: 100 }).expect(201);
  const roomB = await app.asUser('p-race-b').post('/api/rooms', { baseChips: 100 }).expect(201);
  const racer = app.asUser('p-racer');
  const [joinA, joinB] = await Promise.all([
    racer.post(`/api/rooms/${roomA.body.roomNo}/join`, {}),
    racer.post(`/api/rooms/${roomB.body.roomNo}/join`, {}),
  ]);
  const statuses = [joinA.status, joinB.status].sort();
  assert.deepEqual(statuses, [200, 409]);
  const me = await racer.get('/api/auth/me');
  const joinedNo = me.body.room.roomNo;
  assert.ok([roomA.body.roomNo, roomB.body.roomNo].includes(joinedNo));
});

test('非成员/离开成员发起动作 → 403 NOT_MEMBER（D17：写操作才要求在场）', async () => {
  const { roomNo } = await setupRoom(app, { host: 'q-host', players: [] });
  const stranger = await app.asUser('q-stranger').post(`/api/rooms/${roomNo}/actions/bet`, { amount: 10 });
  assert.equal(stranger.status, 403);
  assert.equal(stranger.body.error.code, 'NOT_MEMBER');
});
