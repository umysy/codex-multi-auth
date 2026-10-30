'use strict';
// 读模型的纯函数单测：不联网、不碰磁盘、不 spawn 进程。
const test = require('node:test');
const assert = require('node:assert/strict');
const { pickWindows, paceFor } = require('../lib/dashboard');

test('pickWindows：weekly(10080) 归到 7d，短窗口归到 5h', () => {
  const now = Date.now();
  const quota = {
    primary: { usedPercent: 20, windowMinutes: 10080, resetAtMs: now + 86400000 },
    secondary: { usedPercent: 40, windowMinutes: 300, resetAtMs: now + 3600000 },
  };
  const win = pickWindows(quota);
  assert.equal(win.h7.remaining, 80);
  assert.equal(win.h5.remaining, 60);
  assert.equal(win.h7.resetAt, now + 86400000);
  assert.equal(win.h5.resetAt, now + 3600000);
});

test('pickWindows：缺额度数据时两块都是 null，remaining 夹在 0..100', () => {
  assert.deepEqual(pickWindows(null), { h5: null, h7: null });
  assert.deepEqual(pickWindows({}), { h5: null, h7: null });
  const win = pickWindows({ primary: { usedPercent: 120, windowMinutes: 10080 }, secondary: { usedPercent: -10, windowMinutes: 300 } });
  assert.equal(win.h7.remaining, 0);
  assert.equal(win.h5.remaining, 100);
});

test('pickWindows：窗口重置时刻已过时标记 expired，界面据此显示“已重置”而不是旧百分比', () => {
  const now = Date.UTC(2026, 9, 27, 11, 0, 0);
  const expired = pickWindows({ primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: now - 3600000 } }, now);
  assert.equal(expired.h5.expired, true);
  assert.equal(expired.h5.remaining, 0);
  assert.equal(expired.h5.resetAt, now - 3600000);

  const fresh = pickWindows({ primary: { usedPercent: 20, windowMinutes: 300, resetAtMs: now + 3600000 } }, now);
  assert.equal(fresh.h5.expired, false);
  assert.equal(fresh.h5.remaining, 80);
});

test('paceFor：没有重置时间 / 未开始回落 / 已用 0% 时都返回 0', () => {
  assert.equal(paceFor(null), 0);
  assert.equal(paceFor({ remaining: 50, resetAt: null }), 0);
  assert.equal(paceFor({ remaining: 100, resetAt: Date.now() }), 0);
  assert.equal(paceFor({ remaining: 100, resetAt: Date.now() + 86400000 }), 0);
});

test('paceFor：按“已用百分比 / 已过小时数”折算出每小时消耗速度', () => {
  // 7 天窗口的起点 = resetAt - 7 天；取 resetAt = now + 1 天 → 已过 6 天 = 144 小时
  const resetAt = Date.now() + 86400000;
  const pace = paceFor({ remaining: 50, resetAt });
  assert.ok(pace > 0.3 && pace < 0.4, 'expected ~0.347, got ' + pace);
});

test('paceFor：数字入参容错（字符串百分比也不炸）', () => {
  const resetAt = Date.now() + 86400000;
  assert.equal(typeof paceFor({ remaining: '50', resetAt }), 'number');
});
