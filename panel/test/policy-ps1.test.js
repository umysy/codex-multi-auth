'use strict';
// quota-policy.ps1 的端到端回归测试（Windows / PowerShell 5.1）。
//
// 为什么要这个测试：503 事故的根因是"策略切到储备号时没有解除 emergency-only，
// 运行时拒绝路由到唯一可用的储备号"。这条行为发生在 PowerShell 执行层，纯 JS 单测覆盖不到。
//
// 做法：把 quota-policy.ps1 和它依赖的 panel 模块复制到临时目录，
// 用假 CLI（fixtures/fake-cma.js）+ 固定场景跑一次真实脚本，断言 CLI 调用顺序与落盘状态。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const isWindows = process.platform === 'win32';
const repoRoot = path.resolve(__dirname, '..', '..');
const SKIP = isWindows ? false : '仅 Windows + PowerShell 5.1 可运行';
const COPY = [
  ['quota-policy.ps1', 'quota-policy.ps1'],
  ['panel/policy-cli.js', 'panel/policy-cli.js'],
  ['panel/policy-core.js', 'panel/policy-core.js'],
  ['panel/lib/policy-config.js', 'panel/lib/policy-config.js'],
  ['panel/lib/policy-decision.js', 'panel/lib/policy-decision.js'],
  ['panel/lib/rotation-policy.js', 'panel/lib/rotation-policy.js'],
  ['panel/lib/runtime-health.js', 'panel/lib/runtime-health.js'],
  ['panel/test/fixtures/fake-cma.js', 'fake-cma.js'],
];

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-ps1-'));
  for (const [from, to] of COPY) {
    const dst = path.join(root, to);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, from), dst);
  }
  const appData = path.join(root, 'appdata');
  const npmDir = path.join(appData, 'npm');
  fs.mkdirSync(npmDir, { recursive: true });
  // 和真实部署一致：APPDATA\npm\codex-multi-auth.cmd 指向假 CLI
  fs.writeFileSync(
    path.join(npmDir, 'codex-multi-auth.cmd'),
    '@echo off\r\n"' + process.execPath + '" "' + path.join(root, 'fake-cma.js') + '" %*\r\n',
    'ascii'
  );
  return { root, appData };
}

function runPolicy(sandbox, scenario, stateOverrides, extraArgs) {
  const scenarioPath = path.join(sandbox.root, 'scenario.json');
  const callsPath = path.join(sandbox.root, 'calls.txt');
  const activePath = path.join(sandbox.root, 'active.txt');
  const pinPath = path.join(sandbox.root, 'pin.txt');
  const statePath = path.join(sandbox.root, 'quota-policy.state.json');
  const cfgPath = path.join(sandbox.root, 'panel-config.json');
  const obsPath = path.join(sandbox.root, 'runtime-observability.json');

  fs.writeFileSync(scenarioPath, JSON.stringify(scenario), 'utf8');
  fs.writeFileSync(activePath, String(scenario.activeIndex), 'utf8');
  fs.writeFileSync(pinPath, scenario.pinnedAccountIndex == null ? '' : String(scenario.pinnedAccountIndex), 'utf8');
  fs.writeFileSync(
    cfgPath,
    JSON.stringify(
      Object.assign({ autoSwitch: true, minWaitMin: 60, reserveIndex: 1, allowFailover: true }, scenario.panelConfig || {})
    ),
    'utf8'
  );
  fs.writeFileSync(
    statePath,
    JSON.stringify(
      Object.assign(
        {
          lastSwitchAtMs: Date.now() - 700000,
          lastStatus: 'OK',
          lastStatusAtMs: 0,
          lastWaitLogAtMs: 0,
          from: 0,
          to: 0,
          policyPaused: [],
          lastWaitKey: '',
          lastRunAtMs: 0,
          tickCount: 0,
          nextLogAtMs: 0,
        },
        stateOverrides || {}
      )
    ),
    'utf8'
  );

  // 运行时信号（可选）：存在时策略会把它当作"额度缓存之后更新的真相"
  if (scenario.runtime) {
    fs.writeFileSync(obsPath, JSON.stringify(Object.assign({ version: 1, updatedAt: Date.now() }, scenario.runtime)), 'utf8');
  } else if (fs.existsSync(obsPath)) {
    fs.unlinkSync(obsPath);
  }

  const env = Object.assign({}, process.env, {
    // 每次沙箱用独立互斥体：真机计划任务每 5 分钟会占着同名锁，抢锁会让脚本直接 exit 0
    CMA_POLICY_MUTEX: 'Local\\cma-ps1-' + path.basename(sandbox.root),
    APPDATA: sandbox.appData,
    CODEX_HOME: sandbox.root,
    CMA_SCENARIO: scenarioPath,
    CMA_CALLS: callsPath,
    CMA_ACTIVE: activePath,
    CMA_PIN: pinPath,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    NODE_USE_ENV_PROXY: '',
  });

  // scenario.forceConsoleEncoding：模拟“计划任务/无控制台”场景——把 [Console]::OutputEncoding
  // 设成 936(GBK)，此时 & $cma 的 UTF-8 输出会被解成乱码（2026-10-26 live 事故）。
  const psArgs = scenario.forceConsoleEncoding
    ? [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '[Console]::OutputEncoding=[System.Text.Encoding]::GetEncoding(' +
          String(scenario.forceConsoleEncoding) +
          '); & ' +
          "'" + path.join(sandbox.root, 'quota-policy.ps1') + "'",
      ]
    : ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(sandbox.root, 'quota-policy.ps1')].concat(extraArgs || []);
  let exitCode = 0;
  try { execFileSync('powershell', psArgs, { cwd: sandbox.root, env, timeout: 120000, stdio: 'pipe' }); }
  catch (e) { if (e.status !== 1) throw e; exitCode = e.status; }

  const calls = fs.existsSync(callsPath)
    ? fs.readFileSync(callsPath, 'utf8').split('\n').filter((line) => line.trim())
    : [];
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const logPath = path.join(sandbox.root, 'quota-policy.log');
  const log = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const pin = fs.existsSync(pinPath) ? fs.readFileSync(pinPath, 'utf8').trim() : '';
  return { calls, state, log, pin, exitCode };
}

// 两个日常号都耗尽，只剩储备号可用 → 必须切储备号并解除 emergency-only
const ALL_DAILY_EXHAUSTED = {
  activeIndex: 1,
  accountCount: 3,
  pinnedAccountIndex: null,
  quota: [
    { primary: { usedPercent: 0, windowMinutes: 10080 } },
    {
      primary: { usedPercent: 96, windowMinutes: 300, resetInMin: 100 },
      secondary: { usedPercent: 15, windowMinutes: 10080, resetInMin: 4000 },
    },
    {
      primary: { usedPercent: 100, windowMinutes: 300, resetInMin: 120 },
      secondary: { usedPercent: 40, windowMinutes: 10080, resetInMin: 5000 },
    },
  ],
  policy: [{ paused: false, emergencyOnly: true }, { paused: false }, { paused: false }],
};

// CLI 的 stdout 混入警告行（22:12 真实事故）→ 仍必须能解析出 JSON
const NOISY_HEALTHY = {
  activeIndex: 1,
  accountCount: 2,
  pinnedAccountIndex: null,
  noise: true,
  quota: [
    { primary: { usedPercent: 0, windowMinutes: 10080 } },
    { primary: { usedPercent: 10, windowMinutes: 300, resetInMin: 200 }, secondary: { usedPercent: 5, windowMinutes: 10080, resetInMin: 4000 } },
  ],
  policy: [{ paused: true, emergencyOnly: true }, { paused: false }],
};

// 储备号在用，日常号已恢复 → 回切日常号并恢复 emergency-only
const RESERVE_IN_USE_DAILY_RECOVERED = {
  activeIndex: 0,
  accountCount: 2,
  pinnedAccountIndex: null,
  quota: [
    { primary: { usedPercent: 0, windowMinutes: 10080 } },
    {
      primary: { usedPercent: 5, windowMinutes: 300, resetInMin: 200 },
      secondary: { usedPercent: 10, windowMinutes: 10080, resetInMin: 3000 },
    },
  ],
  policy: [{ paused: false, emergencyOnly: false }, { paused: false }],
};

function findCall(calls, exact) {
  return calls.indexOf(exact);
}

const stableKey = n => 'sha256:' + String(n).repeat(64);
function customScenario(overrides = {}) {
  return { activeIndex: 1, accountCount: 3, pinnedAccountIndex: null,
    quota: [{ primary: { usedPercent: 0, windowMinutes: 10080 } },
      { primary: { usedPercent: 100, windowMinutes: 300, resetInMin: 120 } },
      { primary: { usedPercent: 0, windowMinutes: 300, resetInMin: 200 } }],
    policy: [1, 2, 3].map(n => ({ accountKey: stableKey(n), paused: false, emergencyOnly: false })),
    panelConfig: { rotation: { mode: 'daily-reserve', daily: [stableKey(2), stableKey(3)], reserve: [stableKey(1)], waitBeforeSwitchMin: 0 } }, ...overrides };
}
test('custom rotation uses stable keys, reconciles reserve and switches through real PS executor', { skip: SKIP }, t => {
  const sandbox = makeSandbox(); t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));
  const { calls, state } = runPolicy(sandbox, customScenario());
  assert.equal(state.lastStatus, 'SWITCH'); assert.equal(state.to, 3);
  assert.ok(calls.includes('account emergency-only 1 on'));
  assert.ok(calls.includes('account pause 2')); assert.ok(calls.includes('switch 3'));
  assert.equal(state.pauseOwnership[stableKey(2)], true);
});
test('custom rotation invalid binding never changes pin or account policies', { skip: SKIP }, t => {
  const sandbox = makeSandbox(); t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));
  const scenario = customScenario({ pinnedAccountIndex: 1 }); scenario.panelConfig.rotation.daily[0] = stableKey(9);
  const { calls, state, pin } = runPolicy(sandbox, scenario);
  assert.equal(state.lastStatus, 'ERROR'); assert.equal(pin, '1'); assert.deepEqual(calls, []);
});

test('custom soft quota limit waiting does not pause or switch the current account in the real executor', { skip: SKIP }, t => {
  const sandbox = makeSandbox(); t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));
  const scenario = customScenario();
  scenario.quota[1].primary.usedPercent = 85; scenario.quota[1].primary.resetInMin = 10;
  scenario.panelConfig.rotation.waitBeforeSwitchMin = 60;
  scenario.panelConfig.rotation.accountRules = { [stableKey(2)]: { shortUsedPercent: 80 } };
  const { calls, state } = runPolicy(sandbox, scenario);
  assert.equal(state.lastStatus, 'WAIT');
  assert.equal(calls.includes('account pause 2'), false);
  assert.equal(calls.some(c => c.startsWith('switch ')), false);
});
test('策略只读额度缓存，不做 limits --refresh；路由写的实时额度比缓存新时以实时为准', { skip: SKIP }, t => {
  const sandbox = makeSandbox(); t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));
  // 缓存里账号 2 还很空，实时额度（真实请求的响应头）显示它已经用满。
  const scenario = customScenario({ forbidRefresh: true });
  scenario.quota[1].primary.usedPercent = 10;
  fs.writeFileSync(path.join(sandbox.root, 'openai-codex-accounts.json'),
    JSON.stringify({ accounts: [{ accountId: 'id-1' }, { accountId: 'id-2' }, { accountId: 'id-3' }] }), 'utf8');
  fs.writeFileSync(path.join(sandbox.root, 'live-quota.json'), JSON.stringify({ version: 1, byAccountId: {
    'id-2': { status: 200, updatedAt: Date.now() + 60000, primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: Date.now() + 120 * 60000 } },
  } }), 'utf8');
  const { calls, state } = runPolicy(sandbox, scenario);
  assert.equal(state.lastStatus, 'SWITCH', '实时额度显示用满就切走');
  assert.ok(calls.includes('switch 3'));
});
test('策略没有实时额度时照常用缓存（不调用 limits --refresh）', { skip: SKIP }, t => {
  const sandbox = makeSandbox(); t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));
  const scenario = customScenario({ forbidRefresh: true });
  scenario.quota[1].primary.usedPercent = 10;
  const { calls, state } = runPolicy(sandbox, scenario);
  assert.notEqual(state.lastStatus, 'ERROR');
  assert.equal(calls.some(c => c.startsWith('switch ')), false);
});
test('custom role reconciliation failure reports ERROR before switch', { skip: SKIP }, t => {
  const sandbox = makeSandbox(); t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));
  const { calls, state } = runPolicy(sandbox, customScenario({ failCommand: 'account emergency-only 1 on' }));
  assert.equal(state.lastStatus, 'ERROR'); assert.equal(calls.some(c => c.startsWith('switch ')), false);
});

test('CLI 输出混入警告行时仍能解析（22:12 真实事故）', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  const out = runPolicy(sandbox, NOISY_HEALTHY);
  assert.equal(out.state.lastStatus, 'OK');
  assert.ok(!/解析失败/.test(out.log), out.log);
});

test('切储备号：先解除 emergency-only，再切号，成功后不恢复', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { calls, state, log } = runPolicy(sandbox, ALL_DAILY_EXHAUSTED);

  assert.strictEqual(state.lastStatus, 'SWITCH');
  assert.strictEqual(state.from, 2, '从日常号 2 切出');
  assert.strictEqual(state.to, 1, '切入储备号 1');

  const releaseAt = findCall(calls, 'account emergency-only 1 off');
  const switchAt = findCall(calls, 'switch 1');
  assert.ok(releaseAt >= 0, '必须调用 account emergency-only 1 off，实际调用：' + calls.join(' | '));
  assert.ok(switchAt >= 0, '必须真正切号');
  assert.ok(releaseAt < switchAt, '解除 emergency-only 必须在 switch 之前');
  assert.ok(findCall(calls, 'account pause 2') >= 0, '切走后暂停原账号');
  assert.match(log, /EMERGENCY-ONLY 已解除储备号保留/);
});

test('储备号回切日常号：切成功后恢复 emergency-only', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { calls, state, log } = runPolicy(sandbox, RESERVE_IN_USE_DAILY_RECOVERED);

  assert.strictEqual(state.lastStatus, 'SWITCH');
  assert.strictEqual(state.from, 1, '从储备号 1 切出');
  assert.strictEqual(state.to, 2, '切入日常号 2');

  const switchAt = findCall(calls, 'switch 2');
  const restoreAt = findCall(calls, 'account emergency-only 1 on');
  assert.ok(switchAt >= 0, '必须真正切号');
  assert.ok(restoreAt >= 0, '必须恢复储备号保留，实际调用：' + calls.join(' | '));
  assert.ok(switchAt < restoreAt, '恢复 emergency-only 必须在切号成功之后');
  assert.match(log, /EMERGENCY-ONLY 已恢复储备号保留/);
});

test('切储备号失败：回滚并恢复 emergency-only', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const scenario = Object.assign({}, ALL_DAILY_EXHAUSTED, { ignoreSwitch: true });
  const { calls, state } = runPolicy(sandbox, scenario);

  assert.strictEqual(state.lastStatus, 'SWITCH-FAILED');

  const releaseAt = findCall(calls, 'account emergency-only 1 off');
  const restoreAt = findCall(calls, 'account emergency-only 1 on');
  assert.ok(releaseAt >= 0, '切号前已解除保留');
  assert.ok(restoreAt >= 0, '失败后必须恢复保留，实际调用：' + calls.join(' | '));
  assert.ok(releaseAt < restoreAt, '恢复必须在解除之后');
});

// 事故复盘：被钉住的账号一旦限流，运行时就是 503（"Pinned account N is currently unavailable"）。
// 自动模式（autoSwitch=true）下策略必须在每次运行开头清掉遗留 pin，让路由器能轮转。
const PINNED_HEALTHY = {
  activeIndex: 1, // 日常号 2（账号 1 是 reserveIndex=1 的储备号）
  accountCount: 2,
  pinnedAccountIndex: 1,
  panelConfig: { autoSwitch: true },
  quota: [
    { primary: { usedPercent: 0, windowMinutes: 10080 } },
    { primary: { usedPercent: 10, windowMinutes: 300, resetInMin: 200 } },
  ],
  policy: [{ paused: false, emergencyOnly: true }, { paused: false }],
};

test('自动模式：运行开头解除遗留 pin', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { calls, state, log, pin } = runPolicy(sandbox, PINNED_HEALTHY);

  assert.strictEqual(state.lastStatus, 'OK', '解除 pin 后仍按原账号运行：' + calls.join(' | '));
  assert.ok(findCall(calls, 'unpin') >= 0, '必须调用 unpin，实际调用：' + calls.join(' | '));
  assert.strictEqual(findCall(calls, 'switch'), -1, '账号 2 本身可用，不该切号');
  assert.strictEqual(pin, '', 'pin 文件应被清空');
  assert.match(log, /UNPIN 已解除账号固定（账号2；autoSwitch 模式下由策略负责轮转）/);
});

test('手动模式：不碰用户自己的 pin', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const scenario = Object.assign({}, PINNED_HEALTHY, { panelConfig: { autoSwitch: false } });
  const { calls, pin } = runPolicy(sandbox, scenario);

  assert.strictEqual(findCall(calls, 'unpin'), -1, 'autoSwitch=false 时不许自动 unpin：' + calls.join(' | '));
  assert.strictEqual(pin, '1', '用户 pin 保持不动');
});

test('手动模式：运行时已限流时解除坏账号 pin 允许故障转移', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));
  const scenario = Object.assign({}, PINNED_HEALTHY, {
    panelConfig: { autoSwitch: false },
    runtime: { accountSkipReasons: { '1': 'rate-limited' } },
  });
  const { calls, pin, log } = runPolicy(sandbox, scenario);
  assert.ok(findCall(calls, 'unpin') >= 0, '运行时限流的 pin 必须解除：' + calls.join(' | '));
  assert.equal(pin, '', '坏账号 pin 不应继续锁住路由');
  assert.match(log, /UNPIN 当前号已限流/);
});

test('切号成功后立即解除 switch 留下的 pin', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { calls, state, pin } = runPolicy(sandbox, ALL_DAILY_EXHAUSTED);

  assert.strictEqual(state.lastStatus, 'SWITCH');
  const switchAt = findCall(calls, 'switch 1');
  const unpinAt = calls.lastIndexOf('unpin');
  assert.ok(switchAt >= 0 && unpinAt >= 0, '调用：' + calls.join(' | '));
  assert.ok(switchAt < unpinAt, 'switch 会钉住目标账号，必须在切完之后解除；调用：' + calls.join(' | '));
  assert.strictEqual(pin, '', '切号后不应留下 pin');
});

// 503 事故 #3 复盘：额度缓存比真实限流慢（缓存写着 12%，运行时已经 429）。
// 策略必须在同一轮就换号，而不是等 5 分钟后缓存刷新。
const RUNTIME_RATE_LIMITED = {
  activeIndex: 1,
  accountCount: 3,
  pinnedAccountIndex: null,
  quota: [
    { primary: { usedPercent: 0, windowMinutes: 10080 } },
    { primary: { usedPercent: 12, windowMinutes: 300, resetInMin: 120 } },
    { primary: { usedPercent: 50, windowMinutes: 300, resetInMin: 200 } },
  ],
  policy: [{ paused: false, emergencyOnly: true }, { paused: false }, { paused: false }],
  runtime: {
    accountSkipReasons: { '1': 'rate-limited' },
    lastPoolExhaustionReason: 'no-account',
    lastPoolExhaustionSkipReasons: { '1': 'rate-limited' },
    policyBlockedIndexes: [1],
  },
};

test('运行时已判限流：即使额度缓存还有余量也立即换号', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { calls, state, log } = runPolicy(sandbox, RUNTIME_RATE_LIMITED);

  assert.strictEqual(state.lastStatus, 'SWITCH', '运行时限流 → 立刻切号：' + calls.join(' | '));
  assert.strictEqual(state.from, 2, '从被限流的账号 2 切出');
  assert.strictEqual(state.to, 3, '切入可用的账号 3');
  assert.match(log, /运行时报告 rate-limited/);
  assert.ok(findCall(calls, 'switch 3') >= 0, '必须真正切号：' + calls.join(' | '));
});

test('model capacity：运行时容量不足也立即换号并触发策略', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));
  const scenario = JSON.parse(JSON.stringify(RUNTIME_RATE_LIMITED));
  scenario.runtime.accountSkipReasons['1'] = 'model capacity insufficient';
  scenario.runtime.lastPoolExhaustionSkipReasons['1'] = 'model capacity insufficient';
  const { calls, state, log } = runPolicy(sandbox, scenario);
  assert.strictEqual(state.lastStatus, 'SWITCH', 'model capacity → 立刻切号：' + calls.join(' | '));
  assert.strictEqual(state.to, 3);
  assert.match(log, /model capacity insufficient/);
});

test('旧限流标记 + 窗口已重置：先清标记再按真实额度决策', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  // 账号 1 是储备号；账号 2 的 5h 窗口已重置但运行时还带着 rate-limited
  const scenario = {
    activeIndex: 1,
    accountCount: 2,
    pinnedAccountIndex: null,
    quota: [
      { primary: { usedPercent: 0, windowMinutes: 10080 } },
      { primary: { usedPercent: 100, windowMinutes: 300, resetInMin: -10 } },
    ],
    policy: [{ paused: false, emergencyOnly: true }, { paused: false }],
    runtime: {
      accountSkipReasons: { '1': 'rate-limited' },
      lastPoolExhaustionReason: 'no-account',
    },
  };
  const { calls, log } = runPolicy(sandbox, scenario);

  const resetAt = findCall(calls, 'rotation reset-rate-limits --account 2');
  assert.ok(resetAt >= 0, '窗口已重置时必须清理旧限流标记：' + calls.join(' | '));
  assert.match(log, /RATELIMIT-RESET 已清除账号2 的旧限流标记/);
});

// 503 事故 #4 复盘：网络抖动让运行时把当前账号标成 cooling-down，但额度还健康。
// 这时策略要立刻切走，但**不能暂停**原账号 —— 暂停它等于把运行时唯一的即时故障转移目标锁死。
const RUNTIME_COOLING = {
  activeIndex: 1,
  accountCount: 3,
  pinnedAccountIndex: null,
  quota: [
    { primary: { usedPercent: 0, windowMinutes: 10080 } },
    { primary: { usedPercent: 30, windowMinutes: 300, resetInMin: 120 } },
    { primary: { usedPercent: 10, windowMinutes: 300, resetInMin: 200 } },
  ],
  policy: [{ paused: false, emergencyOnly: true }, { paused: false }, { paused: false }],
  runtime: {
    accountSkipReasons: { '1': 'cooling-down:network-error' },
    lastPoolExhaustionReason: 'no-account',
  },
};

test('运行时网络冷却：立即切走，且不暂停仍有额度的原账号', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { calls, state, log } = runPolicy(sandbox, RUNTIME_COOLING);

  assert.strictEqual(state.lastStatus, 'SWITCH', '网络冷却 → 立刻切号：' + calls.join(' | '));
  assert.strictEqual(state.from, 2);
  assert.strictEqual(state.to, 3);
  assert.match(log, /运行时报告 cooling-down:network-error/);
  assert.strictEqual(findCall(calls, 'account pause 2'), -1, '额度健康的账号不该被暂停（要留给运行时故障转移）：' + calls.join(' | '));
  assert.match(log, /KEEP 账号2 仍有额度/);
  assert.ok(state.runtimeSeen && state.runtimeSeen['1|cooling-down:network-error'] > 0, '首次看到时间要落盘：' + JSON.stringify(state.runtimeSeen));
});

// 2026-10-28 复盘：observability 文件一直被诊断探测刷新，旧的 cooling-down 看起来永远新鲜，
// 策略每 5 分钟据此再切一次号。首次看到超过 4 分钟的瞬时原因不再触发切号。
test('运行时网络冷却挂了 10 分钟：按旧信号处理，不再切号', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const seenAt = Date.now() - 10 * 60000;
  const { calls, state } = runPolicy(sandbox, RUNTIME_COOLING, { runtimeSeen: { '1|cooling-down:network-error': seenAt } });

  assert.strictEqual(state.lastStatus, 'OK', '旧冷却不该再切号：' + calls.join(' | '));
  assert.strictEqual(findCall(calls, 'switch 3'), -1);
  assert.strictEqual(Number(state.runtimeSeen['1|cooling-down:network-error']), seenAt, '首次看到时间保持不变');
});

// 储备号保留归还：策略切进储备号时解除了 emergency-only，之后被手动切走（不是策略回切），
// 标记以前不会恢复，储备号就被运行时当日常号持续消耗。
const RESERVE_LEFT_MANUALLY = {
  activeIndex: 1,
  accountCount: 3,
  pinnedAccountIndex: null,
  quota: [
    { primary: { usedPercent: 0, windowMinutes: 10080 } },
    { primary: { usedPercent: 30, windowMinutes: 300, resetInMin: 120 } },
    { primary: { usedPercent: 10, windowMinutes: 300, resetInMin: 200 } },
  ],
  policy: [{ paused: false, emergencyOnly: false }, { paused: false }, { paused: false }],
};

test('储备号保留：策略解除过、现在已不在用 → 恢复 emergency-only', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { calls, state, log } = runPolicy(sandbox, RESERVE_LEFT_MANUALLY, { reserveReleased: 1 });

  assert.ok(findCall(calls, 'account emergency-only 1 on') >= 0, '必须恢复保留：' + calls.join(' | '));
  assert.strictEqual(state.reserveReleased, 0);
  assert.match(log, /EMERGENCY-ONLY 储备号已不在用，恢复保留（账号1）/);
});

test('储备号保留：不是策略解除的（用户手动取消备用）→ 不改回去', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { calls } = runPolicy(sandbox, RESERVE_LEFT_MANUALLY);

  assert.strictEqual(findCall(calls, 'account emergency-only 1 on'), -1, calls.join(' | '));
});

// 事故复盘（2026-10-26 晚）：5h 已用满的日常号仍在跑，运行时按缓存额度把它当成可用，
// 请求派过去 → 上游 429 → Codex 界面"额度用完"。策略必须把耗尽的日常号暂停，
// 等金额窗口重置后再自动恢复（否则其它账号有额度也顶不上来）。
const DAILY_EXHAUSTED_WITH_HEALTHY_CUR = {
  activeIndex: 1, // 日常号 2（账号 1 是 reserveIndex=1 的储备号）
  accountCount: 3,
  pinnedAccountIndex: null,
  quota: [
    { primary: { usedPercent: 0, windowMinutes: 10080 } }, // 储备号 1
    { primary: { usedPercent: 40, windowMinutes: 300, resetInMin: 120 } }, // 日常号 2（当前，健康）
    { primary: { usedPercent: 100, windowMinutes: 300, resetInMin: 60 } }, // 日常号 3（5h 耗尽）
  ],
  policy: [{ paused: false, emergencyOnly: true }, { paused: false }, { paused: false }],
};

test('额度耗尽：自动暂停耗尽的日常号并记入 state', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { calls, state, log } = runPolicy(sandbox, DAILY_EXHAUSTED_WITH_HEALTHY_CUR);

  assert.strictEqual(state.lastStatus, 'OK', '当前号仍健康，不该切号：' + calls.join(' | '));
  assert.ok(findCall(calls, 'account pause 3') >= 0, '必须暂停耗尽的日常号 3：' + calls.join(' | '));
  assert.deepStrictEqual(state.exhaustedPaused, [3], 'state 要记住是谁被暂停的');
  assert.match(log, /PAUSE 日常号额度耗尽，自动暂停（账号3）/);
});

test('额度重置：自动恢复之前暂停的账号并清空跟踪', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const scenario = {
    activeIndex: 1,
    accountCount: 3,
    pinnedAccountIndex: null,
    quota: [
      { primary: { usedPercent: 0, windowMinutes: 10080 } },
      { primary: { usedPercent: 40, windowMinutes: 300, resetInMin: 120 } },
      // 账号 3 的 5h 窗口已重置（0%）
      { primary: { usedPercent: 0, windowMinutes: 300, resetInMin: 300 } },
    ],
    policy: [{ paused: false, emergencyOnly: true }, { paused: false }, { paused: true }],
  };
  const { calls, state, log } = runPolicy(sandbox, scenario, { exhaustedPaused: [3] });

  assert.ok(findCall(calls, 'account unpause 3') >= 0, '窗口重置后必须恢复账号 3：' + calls.join(' | '));
  assert.deepStrictEqual(state.exhaustedPaused, [], '恢复后应清空跟踪列表');
  assert.match(log, /RESUME 额度窗口已重置，自动恢复可用（账号3）/);
});

test('DryRun：只报告不真的暂停账号', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { calls, state, log } = runPolicy(sandbox, DAILY_EXHAUSTED_WITH_HEALTHY_CUR, { lastStatus: 'SKIP' }, ['-DryRun']);

  assert.strictEqual(findCall(calls, 'account pause 3'), -1, 'DryRun 不许改账号状态：' + calls.join(' | '));
  assert.deepStrictEqual(state.exhaustedPaused, [], 'DryRun 不落盘跟踪列表');
  assert.match(log, /DRYRUN 将暂停额度耗尽的日常号（账号3）/);
});

// 2026-10-26 live 事故：计划任务里没有控制台，PowerShell 5.1 用 [Console]::OutputEncoding(936)
// 解码 CLI 的 UTF-8 输出，policy list 的中文 note 变成乱码、尾字节吃掉引号 → 每轮 ERROR。
// 现在所有读输出的 CLI 调用都走 Capture-Cli（cmd + 显式 UTF-8 解码）。
// 注意：这条只验证“936 下不崩、不报解析失败”，真正锁住解码方式的是下面那条静态守卫
// （旧代码在这里也可能通过：是否解坏取决于中文 UTF-8 字节与 GBK 双字节边界是否撞上引号）。
test('控制台编码 936 时策略仍能完成一轮（冒烟）', { skip: SKIP }, (t) => {
  const sandbox = makeSandbox();
  t.after(() => fs.rmSync(sandbox.root, { recursive: true, force: true }));

  const { state, log } = runPolicy(
    sandbox,
    {
      activeIndex: 1,
      accountCount: 2,
      pinnedAccountIndex: null,
      forceConsoleEncoding: 936,
      quota: [
        { primary: { usedPercent: 0, windowMinutes: 10080 } },
        { primary: { usedPercent: 10, windowMinutes: 300, resetInMin: 200 } },
      ],
      policy: [
        { paused: false, emergencyOnly: true, note: '储备号：无 5h 限速，平时暂停；周额度重置后再开 /goal 一波用完' },
        { paused: false, note: '日常号' },
      ],
    },
    { lastStatus: 'SKIP' }
  );

  assert.notStrictEqual(state.lastStatus, 'ERROR', '不应解析失败：' + log);
  assert.doesNotMatch(log, /JSON 解析失败/, '不应出现 JSON 解析失败：' + log);
});

// 静态守卫：解析型 CLI 调用必须走 Capture-Cli。`& $cma ... | Out-String` 会用
// [Console]::OutputEncoding 解码 UTF-8 输出，在计划任务里就是 936 —— 2026-10-26 的事故根源。
test('quota-policy.ps1 不再用 Out-String 解析原生 CLI 输出', () => {
  const text = fs.readFileSync(path.join(repoRoot, 'quota-policy.ps1'), 'utf8');
  const offenders = text
    .split('\n')
    .map((line, i) => ({ line: line.trim(), no: i + 1 }))
    .filter((row) => !row.line.startsWith('#'))
    .filter((row) => /&\s*\$cma[^\n]*Out-String/.test(row.line));
  assert.deepStrictEqual(offenders, [], '这些行仍把 CLI 输出交给 Out-String：' + JSON.stringify(offenders));
  assert.match(text, /StandardOutputEncoding = \[System\.Text\.Encoding\]::UTF8/, '缺少 UTF-8 stdout 解码');
  assert.match(text, /function Capture-Cli/, '缺少 Capture-Cli');
});
