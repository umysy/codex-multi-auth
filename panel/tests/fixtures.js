'use strict';
/**
 * fixtures.js — Codex 额度面板 mock 后端的假数据（形状对齐真实 GET /api/state）
 *
 * 只被 mock-server.js 与 e2e-mock.js 使用，不接触真实 ~/.codex 账号数据。
 *
 * 约定：
 *  - 3 个账号，邮箱为 example.com 占位地址（daily.1 / daily.2 / reserve）；
 *  - account 1 是 current，且 h5/h7 都非 null（保证 4 个 KPI 都不显示「—」）；
 *  - policy.autoSwitch=false，E2E 里再勾成 true（断言 off→on 有意义的初始态）；
 *  - totals.weekRemaining 初值 203，E2E 点「刷新额度」后 mock 会 +1；
 *  - 所有时间戳都在 createFixture() 被调用时按 now 现算，避免过期数据。
 */

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const SOURCE = 'mock-fixtures';

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 真实的日志时间格式是 "YYYY-MM-DD HH:MM:SS"（本地时区），timeline 只取 slice(11)。 */
function stamp(base, offsetMs) {
  const d = new Date(base + offsetMs);
  return (
    d.getFullYear() +
    '-' + pad2(d.getMonth() + 1) +
    '-' + pad2(d.getDate()) +
    ' ' + pad2(d.getHours()) +
    ':' + pad2(d.getMinutes()) +
    ':' + pad2(d.getSeconds())
  );
}

function createFixture() {
  const now = Date.now();

  const accounts = [
    {
      n: 1,
      email: 'daily.1@example.com',
      label: 'Account 1 (Token account [id:3dce8d], mock)',
      plan: 'plus',
      planLabel: 'Plus',
      role: 'daily',
      paused: false,
      emergencyOnly: false,
      note: '',
      current: true,
      available: true,
      reason: 'primary quota 4% used',
      quotaStatus: 200,
      drainPerHour: 0.42,
      drainRaw: 0.42,
      h5: { remaining: 82, resetAt: now + 3 * HOUR },
      h7: { remaining: 71, resetAt: now + 4 * DAY },
      lastUsed: now - 6 * MIN,
    },
    {
      n: 2,
      email: 'daily.2@example.com',
      label: 'Account 2 (Token account [id:8b71fa], mock)',
      plan: 'plus',
      planLabel: 'Plus',
      role: 'daily',
      paused: false,
      emergencyOnly: false,
      note: '备用号：按月付费',
      current: false,
      available: true,
      reason: 'primary quota 9% used',
      quotaStatus: 200,
      drainPerHour: 0.38,
      drainRaw: 0.38,
      h5: { remaining: 55, resetAt: now + 2 * HOUR },
      h7: { remaining: 44, resetAt: now + 5 * DAY },
      lastUsed: now - 2 * HOUR,
    },
    {
      n: 3,
      email: 'reserve@example.com',
      label: 'Account 3 (Token account [id:c4d9e2], mock)',
      plan: 'plus',
      planLabel: 'Plus',
      role: 'daily',
      paused: false,
      emergencyOnly: false,
      note: '',
      current: false,
      available: true,
      reason: 'primary quota 1% used',
      quotaStatus: 200,
      drainPerHour: 0.46,
      drainRaw: 0.46,
      h5: { remaining: 93, resetAt: now + 5 * HOUR },
      h7: { remaining: 88, resetAt: now + 6 * DAY },
      lastUsed: now - 4 * HOUR,
    },
  ];

  for (const account of accounts) account.accountKey = 'sha256:' + String(account.n).repeat(64);
  const logs = [
    { at: stamp(now, -32 * MIN), msg: 'OK    账号1 有额度 (5h 82% / 7d 71%)', kind: 'OK', src: 'policy' },
    { at: stamp(now, -28 * MIN), msg: 'WAIT  距上次切换不足 60 分钟，本轮跳过', kind: 'WAIT', src: 'policy' },
    { at: stamp(now, -24 * MIN), msg: 'OK    账号2 有额度 (5h 55% / 7d 44%)', kind: 'OK', src: 'policy' },
    { at: stamp(now, -19 * MIN), msg: 'SWITCH 账号2 -> 账号1（账号2 5h 余量低于阈值）', kind: 'SWITCH', src: 'policy' },
    { at: stamp(now, -14 * MIN), msg: 'ROUTER 上游请求 12 次，轮转 1 次，重试 0 次', kind: 'ROUTER', src: 'router' },
    { at: stamp(now, -9 * MIN), msg: 'GUARD  5h 余量 82% > 25%，保持当前号', kind: 'GUARD', src: 'policy' },
    { at: stamp(now, -5 * MIN), msg: 'OK    账号3 有额度 (5h 93% / 7d 88%)', kind: 'OK', src: 'policy' },
    { at: stamp(now, -2 * MIN), msg: 'ERROR mock 演示用错误行（不影响页面渲染）', kind: 'ERROR', src: 'router' },
  ];

  return {
    now,
    router: {
      running: true,
      pid: 43210,
      port: 56014,
      requests: 27,
      upstream: 12,
      rotations: 1,
      retries: 0,
      ws: 1,
      lastError: 'mock 演示错误：上游 502（已自动恢复）',
      lastErrorAt: now - 2 * MIN,
      requestsSinceError: 12,
      errorRecovered: true,
      lastAccountIndex: 1,
      startedAt: now - 3 * HOUR,
      updatedAt: now - 2 * MIN,
    },
    accounts,
    selection: {
      active: 1,
      runtimeInUse: 1,
      pinned: 1,
      mode: 'hybrid',
      available: 3,
      total: 3,
    },
    totals: {
      weekRemaining: 203,
      drainPerHour: 1.26,
      hoursLeft: 29.4,
      darkAt: now + Math.round(29.4 * HOUR),
      budgetRate: 1.5,
      budgetHours: 139.3,
      budgetDarkAt: now + Math.round(139.3 * HOUR),
      withinBudget: false,
    },
    policy: {
      autoSwitch: false,
      minWaitMin: 60,
      reserveIndex: 1,
      minMinWait: 5,
      maxMinWait: 600,
    },
    schedule: {
      lastStatus: 'OK',
      lastStatusAtMs: now - 25 * MIN,
      lastSwitchAtMs: now - 19 * MIN,
      from: 2,
      to: 1,
      policyPaused: [],
    },
    logs,
    alerts: [],
    errors: [],
    current: accounts[0],
    _meta: { source: SOURCE, generatedAt: now, note: '内存假数据，仅 tests/mock-server.js 使用' },
  };
}

module.exports = { createFixture, SOURCE, MIN, HOUR, DAY };
