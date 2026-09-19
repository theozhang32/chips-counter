// M5：一致性重算（D12）与保留期清理（D8/§7.6）
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

// 附录 A 式完整对局后：verify 恒 0 差异（AC-06）
async function playFullGame(roomNo, users) {
  for (const p of ['c-jia', 'c-yi', 'c-bing']) {
    await users[p].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  }
  await users['c-jia'].post(`/api/rooms/${roomNo}/actions/collect`, {}).expect(200);
  await users['c-yi'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 300 }).expect(200);
  for (const p of ['c-jia', 'c-bing', 'c-ding']) {
    await users[p].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 800 }).expect(200);
  }
  await users['c-yi'].post(`/api/rooms/${roomNo}/actions/partial-collect`, { amount: 1200 }).expect(200);
  await users['c-bing'].post(`/api/rooms/${roomNo}/actions/collect`, {}).expect(200);
  // 一次重建（封存池为 0 分支）+ 中途加入 + 离开 + 回归
  await users['c-ding'].post(`/api/rooms/${roomNo}/leave`, {}).expect(204);
  await users['c-jia'].post(`/api/rooms/${roomNo}/rebuild`, {}).expect(200); // 池 0 无需确认
  await users['c-ding'].post(`/api/rooms/${roomNo}/join`, {}).expect(200); // 重发（新游戏）
  await users['c-ding'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 250 }).expect(200);
}

test('verify：正常对局后全绿（缓存列与推导值一致，AC-06）', async () => {
  const { roomNo, users } = await setupRoom(app, {
    host: 'c-jia',
    players: ['c-yi', 'c-bing', 'c-ding'],
  });
  await playFullGame(roomNo, users);

  const report = await app.container.services.consistencyService.verify(roomNo);
  assert.deepEqual(report.issues, []);
});

test('verify + fix：篡改成员筹码 → 检出并按推导值修复', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'd-jia', players: ['d-yi'] });
  await users['d-yi'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 300 }).expect(200);

  const { roomRepository, roomPlayerRepository } = app.container.repositories;
  const { sequelize } = app.container;
  const room = await roomRepository.findByRoomNo(roomNo);
  const member = await roomPlayerRepository.findByRoomAndPlayer(room.id, 'd-yi');
  const before = member.chips; // 700
  await sequelize.query('UPDATE room_player SET chips = chips + 111 WHERE id = ?', { replacements: [member.id] });

  const report = await app.container.services.consistencyService.verify(roomNo);
  const issue = report.issues.find((i) => i.object === 'room_player' && i.field === 'chips');
  assert.ok(issue, '应检出筹码差异');
  assert.equal(issue.stored, before + 111);
  assert.equal(issue.derived, before);

  const fixed = await app.container.services.consistencyService.fix(report);
  assert.equal(fixed, 1);
  const recheck = await app.container.services.consistencyService.verify(roomNo);
  assert.deepEqual(recheck.issues, []);
});

test('verify + fix：篡改池/发放额 → 检出并修复', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'e-jia', players: ['e-yi'] });
  await users['e-yi'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 400 }).expect(200);
  const { roomRepository, gameRepository, roundRepository } = app.container.repositories;
  const { sequelize } = app.container;
  const room = await roomRepository.findByRoomNo(roomNo);
  const game = await gameRepository.findInProgress(room.id);
  const round = await roundRepository.findInProgress(game.id);
  await sequelize.query('UPDATE round SET pool = pool + 55 WHERE id = ?', { replacements: [round.id] });
  await sequelize.query('UPDATE game SET issued_chips = issued_chips + 99 WHERE id = ?', { replacements: [game.id] });

  const report = await app.container.services.consistencyService.verify(roomNo);
  assert.ok(report.issues.some((i) => i.object === 'round' && i.field === 'pool' && i.derived === 400));
  assert.ok(report.issues.some((i) => i.object === 'game' && i.field === 'issued_chips' && i.derived === 2000));
  // 守恒断言也应报出（推导侧自洽，此处报的是库值不一致而非推导矛盾）
  const fixed = await app.container.services.consistencyService.fix(report);
  assert.equal(fixed, 2);
  assert.deepEqual((await app.container.services.consistencyService.verify(roomNo)).issues, []);
});

test('verify：动作流水与公屏事件缺失互相检出（双份互证）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'f-jia', players: ['f-yi'] });
  await users['f-yi'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 100 }).expect(200);
  const { roomRepository } = app.container.repositories;
  const { sequelize } = app.container;
  const room = await roomRepository.findByRoomNo(roomNo);
  await sequelize.query(
    'DELETE FROM action WHERE round_id IN (SELECT r.id FROM round r JOIN game g ON r.game_id = g.id WHERE g.room_id = ?)',
    { replacements: [room.id] }
  );
  const report = await app.container.services.consistencyService.verify(roomNo);
  assert.ok(report.issues.some((i) => i.object === 'feed_event' && i.message.includes('缺少对应动作流水')));
});

test('verify：全部房间（无参）与不存在房间（报错）', async () => {
  const { roomNo } = await setupRoom(app, { host: 'g-jia', players: [] });
  const all = await app.container.services.consistencyService.verify(null);
  assert.ok(all.rooms.includes(roomNo));
  await assert.rejects(() => app.container.services.consistencyService.verify(999999), /房间不存在/);
});

test('retention：超期已解散房间被级联删除，未超期保留；WS 连接被关闭', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'h-jia', players: [] });
  await users['h-jia'].post(`/api/rooms/${roomNo}/dissolve`, {}).expect(204);

  // WS 连接保持（频道保留），清理后应被 closeRoom 关闭
  // 注意：token 须在创建 WebSocket 之前取得——构造与 open 监听之间不能有 await，否则错过 open 事件
  const token = (await users['h-jia'].post('/api/auth/session', {})).body.token;
  const ws = new WebSocket(app.wsUrl);
  await new Promise((resolve) => ws.once('open', resolve));
  ws.send(JSON.stringify({ type: 'hello', token, roomNo }));
  await new Promise((resolve) => ws.once('message', () => resolve())); // welcome

  const { roomRepository, feedEventRepository, actionRepository } = app.container.repositories;
  const { sequelize, services } = app.container;
  const room = await roomRepository.findByRoomNo(roomNo);
  // 回溯 dissolved_at 至 91 天前（retentionDays=90）
  await sequelize.query('UPDATE room SET dissolved_at = DATE_SUB(NOW(3), INTERVAL 91 DAY) WHERE id = ?', {
    replacements: [room.id],
  });

  // close 事件可能在 runOnce await 期间触发，须提前挂监听
  const closedPromise = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 5000);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
  const report = await services.retentionService.runOnce();
  assert.equal(report.deleted, 1);
  assert.equal(await roomRepository.findByRoomNo(roomNo), null);
  assert.equal(await feedEventRepository.countByRoom(room.id), 0);
  assert.equal(await actionRepository.countByRoom(room.id), 0);

  const closed = await closedPromise;
  assert.equal(closed, 1000);

  // 未超期的解散房间不清理
  const keep = await setupRoom(app, { host: 'h-yi', players: [] });
  await app.asUser('h-yi').post(`/api/rooms/${keep.roomNo}/dissolve`, {}).expect(204);
  const report2 = await services.retentionService.runOnce();
  assert.equal(report2.deleted, 0);
  assert.ok(await roomRepository.findByRoomNo(keep.roomNo));
});

test('重建封存非零池后：verify 仍全绿（closed 轮次池≠0 有封存记录佐证）', async () => {
  const { roomNo, users } = await setupRoom(app, { host: 'i-jia', players: ['i-yi'] });
  await users['i-yi'].post(`/api/rooms/${roomNo}/actions/bet`, { amount: 600 }).expect(200);
  await users['i-jia'].post(`/api/rooms/${roomNo}/rebuild`, { confirmPoolLoss: true }).expect(200);
  const report = await app.container.services.consistencyService.verify(roomNo);
  assert.deepEqual(report.issues, []);
});
