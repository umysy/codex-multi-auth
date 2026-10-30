'use strict';
/**
 * watchdogs 的纯逻辑单测。
 *
 * 看门狗最容易坏的地方是**判断条件**：什么时候算“卡住”、冷却窗口多长、
 * 登录窗口多老才该杀。真实运行要每 60 秒才 tick 一次，且会起停进程，
 * 所以这里直接测抽出来的纯函数（isTransportError / nextRouterWatch / shouldKillLogin）。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const wd = require('../lib/watchdogs');

const STALE = 150000; // 2.5 分钟，超过 120s 陈旧阈值
const FRESH = 30000; // 30 秒，未超过阈值
const NOW = 1700000000000;

function router(over) {
  return Object.assign({
    running: true,
    requests: 100,
    lastError: 'fetch failed',
    lastErrorAt: NOW - STALE,
    errorRecovered: false,
  }, over);
}

function watch(over) {
  // 默认“5 分钟前刚重启过”，处于 15 分钟冷却窗口内：
  // 这样只想测 still 计数/单次判断的用例不会被冷却条件顺带放行成“该重启”。
  return Object.assign({ lastRequests: 100, still: 0, lastRestartAt: NOW - 5 * 60 * 1000 }, over);
}

test('isTransportError：常见传输失败文本都认得', () => {
  for (const text of [
    'fetch failed',
    'upstream fetch timed out',
    'read ECONNRESET',
    'connect ECONNREFUSED 1.2.3.4:443',
    'socket hang up',
    'network timeout',
  ]) {
    assert.equal(wd.isTransportError(text), true, text);
  }
});

test('isTransportError：大小写不敏感，业务错误不算传输错误', () => {
  assert.equal(wd.isTransportError('FETCH FAILED'), true);
  assert.equal(wd.isTransportError('bad gateway'), false, '"bad gateway" 是上游业务错误，不该被自动重启');
  assert.equal(wd.isTransportError(''), false);
  assert.equal(wd.isTransportError(undefined), false);
  assert.equal(wd.isTransportError(null), false);
});

test('nextRouterWatch：路由不在时按 60 秒冷却拉起（不干等 5 分钟计划任务）', () => {
  const prev = watch({ lastRequests: 42, still: 1, lastRestartAt: NOW - 5 * 60 * 1000 });
  for (const rt of [null, { running: false }]) {
    const step = wd.nextRouterWatch(prev, rt, NOW);
    assert.equal(step.restart, true, '进程不在就该拉起来');
    assert.equal(step.reason, 'router not running');
    assert.equal(step.next.lastRestartAt, NOW, '记录本次拉起，避免 60 秒内反复 spawn');
  }
  const recent = watch({ lastRestartAt: NOW - 30000 });
  assert.equal(wd.nextRouterWatch(recent, { running: false }, NOW).restart, false, '60 秒冷却内不重复拉起');
});

test('nextRouterWatch：进程还在只是状态文件过期（如刚唤醒）→ 先等一个 tick，连续两次才重启', () => {
  const prev = watch({ lastRequests: 42, lastRestartAt: NOW - 5 * 60 * 1000 });
  const first = wd.nextRouterWatch(prev, { running: false, alive: true }, NOW);
  assert.equal(first.restart, false, '一次过期不杀活着的进程');
  assert.equal(first.reason, 'router status stale');
  const recovered = wd.nextRouterWatch(first.next, router({ requests: 42 }), NOW + 60000);
  assert.equal(recovered.next.down, 0, '恢复写状态后计数清零');
  const second = wd.nextRouterWatch(first.next, { running: false, alive: true }, NOW + 60000);
  assert.equal(second.restart, true, '连续两次过期才重启');
  assert.equal(second.next.down, 0);
});

test('nextRouterWatch：请求数在涨 → still 归零，不重启', () => {
  const step = wd.nextRouterWatch(watch({ lastRequests: 90, still: 5 }), router({ requests: 100 }), NOW);
  assert.equal(step.restart, false);
  assert.equal(step.next.still, 0);
  assert.equal(step.next.lastRequests, 100);
});

test('nextRouterWatch：请求数没涨 → still 累加', () => {
  const step = wd.nextRouterWatch(watch({ lastRequests: 100, still: 1 }), router({ requests: 100 }), NOW);
  assert.equal(step.restart, false);
  assert.equal(step.next.still, 2);
});

test('nextRouterWatch：传输错误 + 陈旧 + 连续 2 次无进展 + 冷却已过 → 重启', () => {
  const step = wd.nextRouterWatch(
    watch({ lastRequests: 100, still: 1, lastRestartAt: NOW - 16 * 60 * 1000 }),
    router(),
    NOW,
  );
  assert.equal(step.restart, true);
  assert.equal(step.reason, 'fetch failed');
  assert.equal(step.next.lastRestartAt, NOW, '重启时刻要记下来用于冷却');
  assert.equal(step.next.still, 0, '重启后重新观察');
});

test('nextRouterWatch：只是单次无进展（still<2）不重启', () => {
  const step = wd.nextRouterWatch(watch({ lastRequests: 100, still: 0 }), router(), NOW);
  assert.equal(step.restart, false);
  assert.equal(step.next.still, 1);
});

test('nextRouterWatch：错误已恢复 / 不是传输错误 / 还未陈旧 → 都不重启', () => {
  const base = watch({ lastRequests: 100, still: 5, lastRestartAt: 0 });
  const cases = [
    { name: '请求数在涨（errorRecovered）', rt: router({ errorRecovered: true }) },
    { name: '业务错误', rt: router({ lastError: 'invalid api key' }) },
    { name: '没有错误', rt: router({ lastError: '' , lastErrorAt: null }) },
    { name: '错误刚发生还不陈旧', rt: router({ lastErrorAt: NOW - FRESH }) },
  ];
  for (const c of cases) {
    const step = wd.nextRouterWatch(base, c.rt, NOW);
    assert.equal(step.restart, false, c.name);
  }
});

test('nextRouterWatch：冷却窗口内撞过一次就不再重启（避免重启风暴）', () => {
  const recent = NOW - 5 * 60 * 1000; // 5 分钟前刚重启过，< 15 分钟
  const step = wd.nextRouterWatch(watch({ lastRequests: 100, still: 5, lastRestartAt: recent }), router(), NOW);
  assert.equal(step.restart, false);
  assert.equal(step.next.lastRestartAt, recent, '冷却时间戳不应被改写');
});

test('nextRouterWatch：重启后 lastRequests 跟上最后一次观察值', () => {
  const step = wd.nextRouterWatch(
    watch({ lastRequests: 100, still: 1, lastRestartAt: 0 }),
    router({ requests: 100 }),
    NOW,
  );
  assert.equal(step.restart, true);
  assert.equal(step.next.lastRequests, 100);
});

test('shouldKillLogin：默认 15 分钟阈值', () => {
  assert.equal(wd.shouldKillLogin(15 * 60 * 1000), false, '正好 15 分钟不杀');
  assert.equal(wd.shouldKillLogin(15 * 60 * 1000 + 1), true);
  assert.equal(wd.shouldKillLogin(0), false);
});

test('shouldKillLogin：可覆盖阈值，且接受字符串形式的时长', () => {
  assert.equal(wd.shouldKillLogin(5000, 10000), false);
  assert.equal(wd.shouldKillLogin('5000', '10000'), false);
  assert.equal(wd.shouldKillLogin(10001, 10000), true);
});

test('模块导出面：看门狗启动函数与纯判断都在', () => {
  for (const name of ['startWatchdogs', 'startLoginGuard', 'startRouterWatchdog']) {
    assert.equal(typeof wd[name], 'function', name);
  }
  for (const name of ['isTransportError', 'nextRouterWatch', 'shouldKillLogin']) {
    assert.equal(typeof wd[name], 'function', name);
  }
});

// 503 事故 #4：唯一可用账号网络抖动 → 运行时给它记 cooling-down；另外两个号被策略暂停，
// 池子立刻为空，而策略计划任务每 5 分钟才跑一次 → 长达数分钟的 503 空窗。
// 看门狗必须在观测里看到“池耗尽/硬阻塞”时主动踢一次策略。
function obs(over) {
  return Object.assign({
    updatedAt: NOW - 20000,
    accountSkipReasons: {},
    lastPoolExhaustionReason: null,
  }, over);
}

test('shouldKickPolicy：只有配额类硬阻塞才踢；网络冷却/纯池耗尽标记不踢（策略治不了网络）', () => {
  const now = NOW;
  assert.equal(wd.shouldKickPolicy(obs({ accountSkipReasons: { 1: 'rate-limited' } }), 0, now), true);
  assert.equal(wd.shouldKickPolicy(obs({ accountSkipReasons: { 2: 'quota-exhausted' } }), 0, now), true);
  assert.equal(wd.shouldKickPolicy(obs({ accountSkipReasons: { 2: 'model-capacity' } }), 0, now), true);
  assert.equal(wd.shouldKickPolicy(obs({ accountSkipReasons: { 1: 'cooling-down:network-error' } }), 0, now), false, '网络抖动的冷却不该触发策略');
  assert.equal(wd.shouldKickPolicy(obs({ lastPoolExhaustionReason: 'no-account' }), 0, now), false, '只有池耗尽标记、没有任何配额原因 → 不踢');
});

test('shouldKickPolicy：观测过旧 / 未来时间 / 空观测 / 只有软原因 → 都不踢', () => {
  const now = NOW;
  assert.equal(wd.shouldKickPolicy(null, 0, now), false);
  assert.equal(wd.shouldKickPolicy(obs({ updatedAt: now - 90001, accountSkipReasons: { 0: 'rate-limited' } }), 0, now), false);
  assert.equal(wd.shouldKickPolicy(obs({ updatedAt: now + 5000, lastPoolExhaustionReason: 'no-account' }), 0, now), false);
  assert.equal(wd.shouldKickPolicy(obs({ accountSkipReasons: { 0: 'model-not-supported' } }), 0, now), false);
});

test('shouldKickPolicy：5 分钟内已踢过 → 不重复踢（与策略自身节奏对齐，避免每分钟空跑）', () => {
  const now = NOW;
  const fresh = obs({ accountSkipReasons: { 1: 'rate-limited' } });
  assert.equal(wd.shouldKickPolicy(fresh, now - 61000, now), false);
  assert.equal(wd.shouldKickPolicy(fresh, now - 301000, now), true);
});

test('策略心跳过期时自动恢复，且节流避免重复启动', () => {
  const now = NOW;
  assert.equal(wd.shouldKickStalePolicy({ lastRunAtMs: now - 12 * 60 * 1000 - 1 }, 0, now), true);
  assert.equal(wd.shouldKickStalePolicy({ lastRunAtMs: now - 12 * 60 * 1000 - 1 }, now - 60000, now), false);
  assert.equal(wd.shouldKickStalePolicy({ lastRunAtMs: now - 1000 }, 0, now), false);
});

test('kickSignature：跳过原因顺序/账号轮换/重试倒计时都不影响签名，只有原因集合变化才改签名', () => {
  const a = wd.kickSignature(obs({ accountSkipReasons: { 1: 'rate-limited', 0: 'model-not-supported' } }));
  const b = wd.kickSignature(obs({ accountSkipReasons: { 0: 'model-not-supported', 1: 'rate-limited' } }));
  assert.equal(a, b, '同一组原因、不同插入顺序必须得到同一签名');
  assert.equal(wd.kickSignature(null), '');
  const base = obs({ accountSkipReasons: { 0: 'model-not-supported' } });
  assert.notEqual(wd.kickSignature(base), wd.kickSignature(obs({ accountSkipReasons: { 0: 'model-not-supported' }, lastPoolExhaustionReason: 'no-account' })));
  // 倒计时每 tick 都在变，必须**不**影响签名，否则去重失效（14:17 实测每分钟一踢的根因）
  assert.equal(wd.kickSignature(base), wd.kickSignature(obs({ accountSkipReasons: { 0: 'model-not-supported' }, lastPoolExhaustionRetryAfterMs: 60000 })));
  // 路由每次重试/轮换都会改 lastAccountIndex；它若进签名，去重就等于没做（15:24 实测每分钟一踢）
  assert.equal(wd.kickSignature(base), wd.kickSignature(obs({ accountSkipReasons: { 0: 'model-not-supported' }, lastAccountIndex: 2 })));
  assert.notEqual(wd.kickSignature(base), wd.kickSignature(obs({ accountSkipReasons: { 1: 'rate-limited' } })));
});

test('shouldKickNow：阻塞画像没变 → 不重复踢（sticky lastPoolExhaustionReason 不再每分钟刷）', () => {
  const now = NOW;
  const sticky = obs({ lastPoolExhaustionReason: 'no-account', accountSkipReasons: { 1: 'rate-limited' } });
  const sig = wd.kickSignature(sticky);
  assert.equal(wd.shouldKickNow(sticky, 0, '', now), true, '第一次发现新阻塞要踢');
  assert.equal(wd.shouldKickNow(sticky, now - 301000, sig, now), false, '同一张画像再踢一次没有意义');
});

test('shouldKickNow：出现新的硬阻塞、或签名变了才踢；节流仍然生效', () => {
  const now = NOW;
  const oldSig = wd.kickSignature(obs({ accountSkipReasons: { 0: 'model-not-supported' } }));
  const changed = obs({ accountSkipReasons: { 0: 'model-not-supported', 1: 'rate-limited' } });
  assert.equal(wd.shouldKickNow(changed, now - 301000, oldSig, now), true, '新增限流账号 → 踢');
  assert.equal(wd.shouldKickNow(changed, now - 30000, oldSig, now), false, '5 分钟节流内不踢');
});

test('describeRouterExit 文案带退出码与时间', () => {
  const { describeRouterExit } = require('../lib/watchdogs');
  assert.equal(describeRouterExit(null), '');
  assert.equal(
    describeRouterExit({ raw: '[2026-10-26 15:53:45.12] ROUTER-EXIT exit=0', code: 0 }),
    '路由进程退出（exit=0，发生在 2026-10-26 15:53:45.12）',
  );
});

test('nextLaunchExitSeen 只上报新记录', () => {
  const { nextLaunchExitSeen } = require('../lib/watchdogs');
  const e1 = { raw: '[t1] ROUTER-EXIT exit=0', code: 0 };
  assert.deepEqual(nextLaunchExitSeen(null, e1), { raw: e1.raw, report: true });
  assert.deepEqual(nextLaunchExitSeen(e1.raw, e1), { raw: e1.raw, report: false });
  const e2 = { raw: '[t2] ROUTER-EXIT exit=1', code: 1 };
  assert.deepEqual(nextLaunchExitSeen(e1.raw, e2), { raw: e2.raw, report: true });
  assert.deepEqual(nextLaunchExitSeen(e1.raw, null), { raw: '', report: false });
});
