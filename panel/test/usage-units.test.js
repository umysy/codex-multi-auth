'use strict';
/**
 * 用量模块单测：纯函数（账号解析 / 账本解析 / 聚合桶 / 周窗口小结）+ 一次无网络集成
 * （临时目录里造 sessions 文件和路由账本，跑完整 collect）。
 *
 * 运行：node --test panel/test/usage-units.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const accounts = require('../lib/usage/accounts');
const sessions = require('../lib/usage/sessions');
const ledger = require('../lib/usage/ledger');
const buckets = require('../lib/usage/buckets');
const { collect } = require('../lib/usage/collect');

const DAY = 86400000;

test('parseStatusJson：序号/邮箱/额度快照/首选与在用账号', () => {
  const raw = JSON.stringify({
    activeIndex: 1,
    runtimeInUseIndex: 2,
    accounts: [
      { index: 0, label: 'Account 1 hou@example.com [id:3dce8d]', quota: { primary: { windowMinutes: 10080, resetAtMs: 1793000000000, usedPercent: 5 } } },
      { index: 2, label: 'Account 3 [id:89bbe3]' },
    ],
  });
  const r = accounts.parseStatusJson(raw);
  assert.equal(r.activeIndex, 1);
  assert.equal(r.inUseIndex, 2);
  assert.deepEqual(r.list.map((a) => [a.key, a.index, a.email]), [['a0', 0, 'hou@example.com'], ['a2', 2, 'Account 3 [id:89bbe3]']]);
  assert.equal(accounts.weeklyWindow(r.list[0].quota).usedPercent, 5);
  assert.equal(accounts.weeklyWindow({ primary: { windowMinutes: 300 } }), null, '5 小时窗口不算周窗口');
});

test('roleOf：自动 review / 审查 / 主开发', () => {
  const { roleOf } = require('../lib/usage/threads');
  assert.equal(roleOf('codex-auto-review', ''), '自动 review');
  assert.equal(roleOf('', '代码评审记录'), '审查 reviewer');
  assert.equal(roleOf('gpt-5.6-sol', '实现登录'), '主开发');
});

test('roleOf：只看标题第一行，长提示词里的“复核”不算审查会话', () => {
  const { roleOf } = require('../lib/usage/threads');
  const long = '继续 Trading 项目的交易训练软件，你负责第3部分“UI与前端”。\n\n当前架构设计已完成三个独立角色的初审、交叉复核。';
  assert.equal(roleOf('gpt-6.1-sol', long), '主开发', '第二行的“交叉复核”不能把主开发算成审查');
  assert.equal(roleOf('gpt-6.1-sol', '审查 这次改动的风险'), '审查 reviewer');
  assert.equal(roleOf('codex-auto-review', 'Guardian review'), '自动 review');
  assert.equal(roleOf('gpt-6.1-sol', ''), '主开发');
});

test('series：连续 N 天补零，按本地日期对齐', () => {
  const dayStart = new Date(2026, 0, 15).getTime();
  const map = new Map();
  const d = buckets.zero();
  d.tokens = 42;
  map.set('2026-01-15', d);
  const out = buckets.series(map, dayStart, 3);
  assert.deepEqual(out.map((x) => x.date), ['2026-01-13', '2026-01-14', '2026-01-15']);
  assert.equal(out[2].tokens, 42);
  assert.equal(out[1].tokens, 0);
});

test('tally：总量/按天/按小时/角色/模型/项目/会话；账本事件没有角色和会话', () => {
  const rec = buckets.newRec('all', '全部账号');
  const dayStartMs = new Date(2026, 0, 15).getTime();
  const e = { ts: new Date(2026, 0, 15, 10, 30).getTime(), u: { input: 10, cached: 4, output: 5, reasoning: 1, tokens: 20, events: 1 } };
  buckets.tally(rec, e, { dayStartMs, role: '主开发', model: 'gpt-5.6-sol', project: 'demo', threadId: 't1' });
  buckets.tally(rec, e, { dayStartMs, model: 'gpt-5.6-sol', project: 'demo' });
  assert.equal(rec.total.tokens, 40);
  assert.equal(rec.total.cached, 8);
  assert.equal(rec.days.get('2026-01-15').tokens, 40);
  assert.equal(rec.hours[10], 40);
  assert.equal(rec.roles.get('主开发').tokens, 20, '没有角色的事件不计入角色');
  assert.equal(rec.models.get('gpt-5.6-sol').events, 2);
  assert.equal(rec.sessions.get('t1').tokens, 20);
  assert.equal(rec.sessions.size, 1);
});

test('usageOf：last_token_usage 优先，兼容只有 total 的旧格式', () => {
  const u = sessions.usageOf({ total_token_usage: { input_tokens: 3, cached_input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 1, total_tokens: 6 } });
  assert.deepEqual(u, { input: 3, cached: 1, output: 2, reasoning: 1, tokens: 6, events: 1 });
  assert.equal(sessions.usageOf({ last_token_usage: { total_tokens: 9 }, total_token_usage: { total_tokens: 99 } }).tokens, 9);
});

test('readSessionFile：跳过只有额度的事件和累计用量没变的重复事件', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-session-'));
  const file = path.join(dir, 'rollout-11111111-2222-4333-8444-555555555555.jsonl');
  const ev = (ts, last, total) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: last }, total_token_usage: { total_tokens: total } } } });
  fs.writeFileSync(file, [
    JSON.stringify({ timestamp: new Date(1000).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: null } }),
    ev(2000, 10, 10),
    ev(3000, 10, 10), // 只更新额度时 Codex 会原样再写一条
    ev(4000, 5, 15),
  ].join('\n') + '\n');
  try {
    const r = await sessions.readSessionFile(file, { cutoff: 0 });
    assert.equal(r.threadId, '11111111-2222-4333-8444-555555555555');
    assert.deepEqual(r.events.map((e) => e.u.tokens), [10, 5]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ledger：只取路由请求，带账号与 token；projectKey 去掉哈希；读轮转出去的旧文件', () => {
  const line = (o) => JSON.stringify(Object.assign({ source: 'runtime-proxy', createdAt: 5000, account: { index: 1 }, model: 'm', projectKey: 'trading-0123abcd4567', tokens: { inputTokens: 100, cachedInputTokens: 90, outputTokens: 3, reasoningTokens: 1, totalTokens: 103 } }, o));
  const e = ledger.parseLine(line({}), 0);
  assert.deepEqual(e, { ts: 5000, index: 1, model: 'm', project: 'trading', u: { input: 100, cached: 90, output: 3, reasoning: 1, tokens: 103, events: 1 } });
  assert.equal(ledger.parseLine(line({ source: 'quota-probe' }), 0), null);
  assert.equal(ledger.parseLine(line({ account: null }), 0), null, '没有账号的失败请求不计');
  assert.equal(ledger.parseLine(line({ createdAt: 10 }), 100), null, '早于起点');
  assert.equal(ledger.parseLine('not json', 0), null);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-ledger-'));
  try {
    fs.writeFileSync(path.join(dir, 'usage-ledger.jsonl'), line({}) + '\n');
    fs.writeFileSync(path.join(dir, 'usage-ledger.20261020T000000000Z.jsonl'), line({ createdAt: 6000 }) + '\n');
    fs.writeFileSync(path.join(dir, 'other.jsonl'), line({}) + '\n');
    assert.equal(ledger.loadLedger(dir, 0).length, 2);
    assert.deepEqual(ledger.loadLedger(path.join(dir, 'missing'), 0), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('matchSession：输入 / 缓存 token 相同、时间最近、未被占用；超出时间差不配', () => {
  const idx = new Map();
  const u = { input: 100, cached: 90, output: 1, reasoning: 0, tokens: 101, events: 1 };
  idx.set(ledger.tokenKey(u), [{ ts: 1000, used: false, id: 'far' }, { ts: 5000, used: false, id: 'near' }]);
  assert.equal(ledger.matchSession(idx, { ts: 5200, u }, 60000).id, 'near');
  assert.equal(ledger.matchSession(idx, { ts: 5200, u }, 60000).id, 'far', '已占用的不再配');
  assert.equal(ledger.matchSession(idx, { ts: 5200, u }, 60000), null, '都占用了');
  idx.set(ledger.tokenKey(u), [{ ts: 0, used: false }]);
  assert.equal(ledger.matchSession(idx, { ts: 10 * 60000, u }, 60000), null, '时间差太大');
  assert.equal(ledger.matchSession(idx, { ts: 0, u: { ...u, cached: 1 } }, 60000), null, 'token 数不同');
});

test('windowSummary：从窗口起点（重置 - 7 天）累计这个账号的 token', () => {
  const W = 7 * DAY;
  const reset = 100 * DAY;
  const ev = (ts, tokens) => ({ ts, u: { input: tokens, cached: tokens - 1, output: 1, reasoning: 0, tokens: tokens + 1, events: 1 } });
  const s = buckets.windowSummary({ key: 'a1', email: 'b@example.com' }, { resetAtMs: reset, usedPercent: 24 },
    [ev(reset - W - 1, 1000), ev(reset - W + 1, 10), ev(reset - 1, 20)], W);
  assert.deepEqual(s, { key: 'a1', label: 'b@example.com', startAt: reset - W, resetAt: reset, usedPercent: 24, tokens: 32, input: 30, cached: 28, output: 2, events: 2 });
  const none = buckets.windowSummary({ key: 'a0', email: 'x' }, null, [ev(1, 5)], W);
  assert.equal(none.startAt, null);
  assert.equal(none.tokens, 0);
});

test('collect：全部账号来自会话文件；按账号来自账本（一个会话跨两个账号时按请求拆开）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-collect-'));
  const sessionsRoot = path.join(root, 'sessions');
  const ledgerDir = path.join(root, 'usage');
  fs.mkdirSync(path.join(sessionsRoot, '2026', '01', '15'), { recursive: true });
  fs.mkdirSync(ledgerDir);
  const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
  const threadId = '11111111-2222-4333-8444-555555555555';
  const ev = (ts, last, total) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: last, cached_input_tokens: last - 2, output_tokens: 1, total_tokens: last + 1 }, total_token_usage: { total_tokens: total } } } });
  fs.writeFileSync(path.join(sessionsRoot, '2026', '01', '15', threadId + '.jsonl'), [ev(now - 3600e3, 10, 11), ev(now - 1800e3, 20, 32)].join('\n') + '\n');
  const led = (ts, index, total) => JSON.stringify({ source: 'runtime-proxy', createdAt: ts, account: { index }, model: 'gpt', projectKey: 'demo-0123abcd4567', tokens: { inputTokens: total - 1, cachedInputTokens: total - 3, outputTokens: 1, totalTokens: total } });
  fs.writeFileSync(path.join(ledgerDir, 'usage-ledger.jsonl'), [led(now - 3600e3, 0, 11), led(now - 1800e3, 1, 21), led(now - 2 * DAY, 1, 500)].join('\n') + '\n');
  const reset = now + 2 * DAY;
  const deps = {
    sessionsRoot,
    ledgerDir,
    stateDb: path.join(root, 'missing.sqlite'),
    execFileSync: () => { throw new Error('不应调用真实 CLI'); },
    loadAccounts: () => ({
      list: [
        { key: 'a0', index: 0, email: 'a@example.com', quota: { primary: { windowMinutes: 10080, resetAtMs: reset, usedPercent: 10 }, updatedAt: 1 } },
        { key: 'a1', index: 1, email: 'b@example.com', quota: { primary: { windowMinutes: 10080, resetAtMs: reset, usedPercent: 20 }, updatedAt: 1 } },
      ],
      activeIndex: 0,
      inUseIndex: 1,
    }),
    liveQuota: { byAccountId: { 'id-b': { updatedAt: now, primary: { usedPercent: 33, windowMinutes: 10080 } } } },
    accountIds: ['id-a', 'id-b'],
    now: () => now,
  };
  try {
    const data = await collect(1, deps);
    assert.equal(data.scan.files, 1);
    assert.equal(data.totals.tokens, 32, '全部账号 = 会话文件');
    assert.equal(data.byRole.length, 1);
    assert.equal(data.topSessions[0].id, threadId);
    const a0 = data.accounts.find((x) => x.key === 'a0');
    const a1 = data.accounts.find((x) => x.key === 'a1');
    assert.equal(a0.totals.tokens, 11, '同一会话里账号 1 的那次请求');
    assert.equal(a1.totals.tokens, 21, '只算统计范围内（今天）的请求');
    assert.equal(a1.byProject[0].project, 'demo');
    assert.equal(a1.byRole[0].role, '主开发', '账本请求按 token 数配对回会话，单个账号也能拆角色');
    assert.equal(a1.topSessions[0].id, threadId, '配对上的请求进入这个账号的会话排行');
    assert.equal(a1.matchedShare, 1);
    assert.equal(a1.window.tokens, 521, '周窗口从窗口起点算，包括统计范围之前的请求');
    assert.equal(a1.window.usedPercent, 33, '实时额度比快照新时用实时的');
    assert.equal(a0.window.usedPercent, 10);
    assert.equal(data.current.key, 'a1', '默认显示路由在用的账号，不是策略首选');
    assert.equal(data.windows.length, 2);
    assert.equal(data.sources.accounts, 'ledger');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('index.get：缓存按 rangeDays 分开，互不覆盖', async () => {
  const usageIndex = require('../lib/usage/index');
  usageIndex.clear();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-cache-'));
  const sessionsRoot = path.join(root, 'sessions');
  fs.mkdirSync(path.join(sessionsRoot, '2026', '01', '15'), { recursive: true });
  const now = new Date(2026, 0, 15, 12, 0, 0).getTime();
  const mk = (ts, tokens) => JSON.stringify({ timestamp: new Date(ts).toISOString(), type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { total_tokens: tokens } } } });
  const today = new Date(2026, 0, 15, 10, 0, 0).getTime();
  const yesterday = new Date(2026, 0, 14, 10, 0, 0).getTime();
  const tid = '11111111-2222-4333-8444-555555555555';
  fs.writeFileSync(path.join(sessionsRoot, '2026', '01', '15', tid + '.jsonl'), [mk(yesterday, 7), mk(today, 5)].join('\n') + '\n', 'utf8');
  const deps = {
    sessionsRoot,
    ledgerDir: path.join(root, 'missing'),
    stateDb: path.join(root, 'missing.sqlite'),
    loadAccounts: () => ({ list: [], activeIndex: -1, inUseIndex: -1 }),
    liveQuota: null,
    accountIds: [],
    now: () => now,
  };
  try {
    const d1 = await usageIndex.get(1, false, deps);
    assert.equal(d1.rangeDays, 1);
    assert.equal(d1.totals.tokens, 5, '只统计今天');
    const d7 = await usageIndex.get(7, false, deps);
    assert.equal(d7.rangeDays, 7, '7 天不能拿到 1 天的缓存');
    assert.equal(d7.totals.tokens, 12);
    const again = await usageIndex.get(1, false, deps);
    assert.equal(again, d1, '同一 rangeDays 应命中缓存');
  } finally {
    usageIndex.clear();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
