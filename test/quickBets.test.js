import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESET_BASE_CHIPS, quickBets } from '../src/common/quickBets.js';
import { TokenService } from '../src/common/token.js';
import { AppError } from '../src/common/errors.js';

test('quickBets：D6 六档生成规则（概设 §2.3 全表）', () => {
  const expected = {
    100: [5, 10, 20, 25, 50, 100],
    200: [10, 20, 40, 50, 100, 200],
    400: [20, 40, 80, 100, 200, 400],
    500: [25, 50, 100, 125, 250, 500],
    800: [40, 80, 160, 200, 400, 800],
    1000: [50, 100, 200, 250, 500, 1000],
  };
  for (const base of PRESET_BASE_CHIPS) {
    assert.deepEqual(quickBets(base), expected[base], `本金 ${base} 档位不符`);
  }
});

test('quickBets：全部档位为正整数且去重保序（NFR-06）', () => {
  for (const base of PRESET_BASE_CHIPS) {
    const bets = quickBets(base);
    assert.equal(bets.length, new Set(bets).size, '档位重复');
    for (const v of bets) {
      assert.ok(Number.isInteger(v) && v > 0, `档位 ${v} 非正整数`);
    }
    assert.deepEqual(
      [...bets].sort((a, b) => a - b),
      bets,
      '档位未按比例升序'
    );
  }
});

test('quickBets：非预设本金向下取整且过滤 0', () => {
  assert.deepEqual(quickBets(10), [1, 2, 5, 10]); // 5%=0.5→0 过滤，10%=1，20%=2，25%=2.5→2，50%=5，100%=10
});

test('token：签发 / 校验往返', () => {
  const ts = new TokenService({ secret: 's3cret', ttlDays: 30 });
  const token = ts.issue('openid-abc');
  const payload = ts.verify(token);
  assert.equal(payload.openid, 'openid-abc');
  assert.ok(payload.exp > payload.iat);
});

test('token：篡改签名 → AUTH_INVALID', () => {
  const ts = new TokenService({ secret: 's3cret', ttlDays: 30 });
  const token = ts.issue('openid-abc');
  const [payload, sig] = token.split('.');
  const forged = `${payload}.${sig.slice(0, -2)}xy`;
  assert.throws(
    () => ts.verify(forged),
    (err) => err instanceof AppError && err.code === 'AUTH_INVALID'
  );
});

test('token：密钥不符 → AUTH_INVALID', () => {
  const a = new TokenService({ secret: 's3cret', ttlDays: 30 });
  const b = new TokenService({ secret: 'other', ttlDays: 30 });
  assert.throws(
    () => b.verify(a.issue('openid-abc')),
    (err) => err.code === 'AUTH_INVALID'
  );
});

test('token：过期 → AUTH_INVALID', () => {
  const ts = new TokenService({ secret: 's3cret', ttlDays: 0 }); // exp == iat，立即过期
  assert.throws(
    () => ts.verify(ts.issue('openid-abc')),
    (err) => err.code === 'AUTH_INVALID'
  );
});

test('token：格式非法 → AUTH_INVALID', () => {
  const ts = new TokenService({ secret: 's3cret', ttlDays: 30 });
  for (const bad of ['', 'abc', 'a.b.c', '====.====']) {
    assert.throws(
      () => ts.verify(bad),
      (err) => err.code === 'AUTH_INVALID'
    );
  }
});
