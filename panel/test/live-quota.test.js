'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { freshestQuota } = require('../lib/live-quota');

const probed = {
  updatedAt: 1000, status: 200, planType: 'plus',
  primary: { usedPercent: 40, windowMinutes: 300, resetAtMs: 5000 },
  secondary: { usedPercent: 20, windowMinutes: 10080, resetAtMs: 9000 },
};

test('live-quota：实时快照更新时覆盖探测快照，缺失的窗口长度沿用探测值', () => {
  const live = { updatedAt: 2000, status: 200, primary: { usedPercent: 47, resetAtMs: 5100 }, secondary: { usedPercent: 22 } };
  const q = freshestQuota(probed, live);
  assert.equal(q.source, 'live');
  assert.equal(q.updatedAt, 2000);
  assert.deepEqual(q.primary, { usedPercent: 47, windowMinutes: 300, resetAtMs: 5100 });
  assert.deepEqual(q.secondary, { usedPercent: 22, windowMinutes: 10080, resetAtMs: 9000 });
  assert.equal(q.planType, 'plus');
});

test('live-quota：实时快照不比探测新、或没有就用探测快照', () => {
  assert.deepEqual(freshestQuota(probed, { updatedAt: 999, primary: { usedPercent: 1 } }), { ...probed, source: 'probe' });
  assert.deepEqual(freshestQuota(probed, undefined), { ...probed, source: 'probe' });
  assert.deepEqual(freshestQuota({}, undefined), {});
});

test('live-quota：只带了一个窗口的实时快照不会抹掉另一个窗口', () => {
  const q = freshestQuota(probed, { updatedAt: 3000, primary: { usedPercent: 50 }, secondary: {} });
  assert.equal(q.primary.usedPercent, 50);
  assert.deepEqual(q.secondary, probed.secondary);
});

test('live-quota：没有探测快照时直接用实时快照', () => {
  const q = freshestQuota(null, { updatedAt: 3000, status: 200, primary: { usedPercent: 5, windowMinutes: 300 } });
  assert.equal(q.source, 'live');
  assert.deepEqual(q.primary, { usedPercent: 5, windowMinutes: 300 });
  assert.equal(q.secondary, null);
});
