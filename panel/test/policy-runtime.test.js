'use strict';
// 运行时感知的故障转移：运行时的 429 / quota-exhausted 比"额度快照"更新得更快。
//
// 背景（2026-10-26 事故）：账号 3 的 5h 额度已经打满并被 429，但 limits 缓存还写着
// "12% 已用"。策略据此判 OK，运行时却对每个请求 503 池耗尽，空窗直到缓存刷新。
// 这里的契约：runtimeBlocked 里的硬阻塞原因必须让账号立刻变成"不可用"。
const test = require('node:test');
const assert = require('node:assert');

const { decide } = require('../policy-core');

const NOW = 1792976700000; // 固定时间，避免测试依赖真实时钟
const MIN = 60000;

function quota(usedPrimary, usedWeekly, resetInMin) {
  return {
    planType: 'plus',
    primary: { usedPercent: usedPrimary, windowMinutes: 300, resetAtMs: NOW + (resetInMin || 120) * MIN },
    secondary: { usedPercent: usedWeekly, windowMinutes: 10080, resetAtMs: NOW + 5 * 24 * 60 * MIN },
  };
}

function baseInput(overrides) {
  return Object.assign(
    {
      nowMs: NOW,
      activeIndex: 1,
      accountCount: 3,
      reserveIndex: 1, // 0 基 0 是储备号，日常号是 1、2
      quotaByIndex: {
        0: { planType: 'plus', primary: { usedPercent: 0, windowMinutes: 10080, resetAtMs: NOW + 6 * 24 * 60 * MIN } },
        1: quota(12, 30, 120),
        2: quota(50, 20, 200),
      },
      pausedIdx: [],
      policyPaused: [],
      lastSwitchAtMs: NOW - 700000,
      lastStatus: 'OK',
    },
    overrides || {}
  );
}

test('额度缓存写 12%，运行时已判 rate-limited → 立即换号', () => {
  const d = decide(baseInput({ runtimeBlocked: { 1: 'rate-limited' } }));

  assert.strictEqual(d.action, 'SWITCH');
  assert.strictEqual(d.targetIndex, 2, '应切到账号 3');
  assert.match(d.reason, /运行时报告 rate-limited/);
  assert.strictEqual(d.details.cur.unavailable, true);
  assert.strictEqual(d.details.cur.runtimeBlocked, 'rate-limited');
});

test('quota-exhausted 与 rate-limited 同样按不可用处理', () => {
  const d = decide(baseInput({ runtimeBlocked: { 1: 'quota-exhausted' } }));

  assert.strictEqual(d.action, 'SWITCH');
  assert.match(d.reason, /运行时报告 quota-exhausted/);
});

test('model capacity 不应继续把请求派给当前账号', () => {
  const d = decide(baseInput({ runtimeBlocked: { 1: 'model-capacity' } }));
  assert.strictEqual(d.action, 'SWITCH');
  assert.strictEqual(d.targetIndex, 2);
  assert.strictEqual(d.details.cur.unavailable, true);
});

test('认证失效账号应立即退出候选池', () => {
  const d = decide(baseInput({ runtimeBlocked: { 1: 'token-expired' } }));
  assert.strictEqual(d.action, 'SWITCH');
  assert.strictEqual(d.targetIndex, 2);
});

test('运行时阻塞的候选账号不参与轮转', () => {
  const d = decide(
    baseInput({
      quotaByIndex: {
        0: quota(100, 100, 500), // 储备号也耗尽
        1: quota(100, 30, 60), // 当前号真实耗尽
        2: quota(0, 10, 200), // 缓存看起来可用
      },
      runtimeBlocked: { 2: 'rate-limited' },
    })
  );

  assert.strictEqual(d.action, 'DEAD', '唯一候选被运行时阻塞，只能等：' + d.reason);
  assert.strictEqual(d.targetIndex, null);
});

test('软原因（model-not-supported）不算额度不可用', () => {
  const d = decide(baseInput({ runtimeBlocked: { 1: 'model-not-supported' } }));

  assert.strictEqual(d.action, 'OK', '模型不支持不该把账号算成"额度耗尽"：' + d.reason);
  assert.ok(!d.details.cur.unavailable);
});

test('cooling-down:network-error 也算硬阻塞（网络抖动不能等 5 分钟缓存）', () => {
  const d = decide(baseInput({ runtimeBlocked: { 1: 'cooling-down:network-error' } }));

  assert.strictEqual(d.action, 'SWITCH', '网络冷却 → 当轮就切走：' + d.reason);
  assert.strictEqual(d.targetIndex, 2);
  assert.match(d.reason, /运行时报告 cooling-down:network-error/);
  assert.strictEqual(d.details.cur.unavailable, true);
});

test('运行时硬阻塞不会被短等待分支吞掉', () => {
  const d = decide(baseInput({
    runtimeBlocked: { 1: 'rate-limited' },
    quotaByIndex: Object.assign({}, baseInput().quotaByIndex, { 1: quota(12, 30, 20) }),
  }));
  assert.strictEqual(d.action, 'SWITCH');
  assert.strictEqual(d.targetIndex, 2);
});

test('运行时硬阻塞绕过 600 秒切换护栏', () => {
  const d = decide(baseInput({ runtimeBlocked: { 1: 'rate-limited' }, lastSwitchAtMs: NOW - 1000 }));
  assert.strictEqual(d.action, 'SWITCH');
  assert.strictEqual(d.targetIndex, 2);
});

test('isHardRuntimeReason：硬原因与冷却前缀命中，软原因不命中', () => {
  const { isHardRuntimeReason, COOLDOWN_RUNTIME_PREFIX } = require('../policy-core');

  assert.strictEqual(COOLDOWN_RUNTIME_PREFIX, 'cooling-down');
  for (const reason of ['rate-limited', 'quota-exhausted', 'cooling-down:network-error', 'Cooling-Down:server-error']) {
    assert.strictEqual(isHardRuntimeReason(reason), true, reason);
  }
  for (const reason of ['model-not-supported', 'policy-blocked', '', null, undefined]) {
    assert.strictEqual(isHardRuntimeReason(reason), false, String(reason));
  }
  for (const reason of ['model-capacity', 'model_capacity', 'capacity-exhausted', 'model capacity insufficient', 'token-expired', 'auth-invalid']) {
    assert.strictEqual(isHardRuntimeReason(reason), true, reason);
  }
});

// 2026-10-28 复盘：observability 的 updatedAt 被诊断探测不停刷新，但 accountSkipReasons 只在池耗尽时写、
// 账号成功一次才清。被避开的账号会一直挂着旧的 cooling-down，策略每 5 分钟据此再换一次号。
test('瞬时原因（冷却/容量）挂了超过 4 分钟 → 不再据此换号', () => {
  const { TRANSIENT_RUNTIME_TRUST_MS } = require('../policy-core');
  for (const reason of ['cooling-down:network-error', 'model-capacity']) {
    const seenAt = NOW - TRANSIENT_RUNTIME_TRUST_MS - MIN;
    const d = decide(baseInput({ runtimeBlocked: { 1: reason }, runtimeSeen: { ['1|' + reason]: seenAt } }));
    assert.strictEqual(d.action, 'OK', reason + '：' + d.reason);
    assert.strictEqual(d.details.runtimeSeen['1|' + reason], seenAt, '首次看到的时间要原样带回，持续判旧');
  }
});

test('瞬时原因刚出现仍会换号，并记下首次看到的时间', () => {
  const d = decide(baseInput({ runtimeBlocked: { 1: 'cooling-down:network-error' } }));
  assert.strictEqual(d.action, 'SWITCH');
  assert.deepStrictEqual(d.details.runtimeSeen, { '1|cooling-down:network-error': NOW });
  const later = decide(baseInput({
    nowMs: NOW + 2 * MIN,
    runtimeBlocked: { 1: 'cooling-down:network-error' },
    runtimeSeen: d.details.runtimeSeen,
  }));
  assert.strictEqual(later.action, 'SWITCH', '4 分钟内仍可信');
  assert.strictEqual(later.details.runtimeSeen['1|cooling-down:network-error'], NOW);
});

test('瞬时原因不绕过 600 秒护栏；持久原因（rate-limited）照旧绕过', () => {
  const cool = decide(baseInput({ runtimeBlocked: { 1: 'cooling-down:network-error' }, lastSwitchAtMs: NOW - 1000 }));
  assert.strictEqual(cool.action, 'GUARD', cool.reason);
  const cap = decide(baseInput({ runtimeBlocked: { 1: 'model-capacity' }, lastSwitchAtMs: NOW - 1000 }));
  assert.strictEqual(cap.action, 'GUARD', cap.reason);
  const rl = decide(baseInput({ runtimeBlocked: { 1: 'rate-limited' }, lastSwitchAtMs: NOW - 1000 }));
  assert.strictEqual(rl.action, 'SWITCH');
});

test('持久原因不会因为挂得久而失效', () => {
  const d = decide(baseInput({ runtimeBlocked: { 1: 'rate-limited' }, runtimeSeen: { '1|rate-limited': NOW - 60 * MIN } }));
  assert.strictEqual(d.action, 'SWITCH');
});
