'use strict';
/**
 * /api/usage 契约测试：**启动真正的 panel/server.js**，喂它一个假的 CODEX_HOME，
 * 用可控的会话文件 + threads 数据库断言响应形状与统计口径。
 *
 * 为什么单独一个文件：用量统计是本项目最容易"改一处、数字静默错掉"的地方，
 * 而它又是只读服务，完全可以用临时目录把输入固定住。
 *
 * 覆盖：
 *   - 鉴权与响应信封 { ok, usage } / Cache-Control: no-store
 *   - totals / today / days / hours 的统计口径（跨天、跨文件累加）
 *   - 无 CLI 时账号归属回落到 unknown（不会把用量记到别人头上）
 *   - byRole / byModel / byProject 来自 state_5.sqlite 的 threads 表
 *   - scan.files / cacheHitRate / quota 形状
 *   - ?days 过滤与 1..14 钳位
 *   - 只读：扫描前后会话文件字节不变
 *
 * 刻意不断言真实机器的额度/账号：那需要 codex-multi-auth CLI，测试里把 APPDATA
 * 也指向临时目录，CLI 必然不存在，账号清单为空。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'panel', 'server.js');
const DAY_MS = 24 * 60 * 60 * 1000;

const TODAY_MODEL = 'gpt-5.6-sol';
const OLD_MODEL = 'codex-auto-review';

let child = null;
let port = 0;
let token = '';
let codexHome = '';
let sessionsRoot = '';
let stderrChunks = [];
let todayThread = '';
let oldThread = '';
const seededFiles = [];

function request(method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: Object.assign({ Host: `127.0.0.1:${port}` }, headers),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON 响应 */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('request timeout')));
    req.end();
  });
}

function getUsage(query) {
  return request('GET', `/api/usage${query}`, { 'x-panel-token': token });
}

async function waitForServer(proc, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`server 提前退出 (code=${child.exitCode})\n${stderrChunks.join('')}`);
    }
    try {
      const res = await request('GET', '/');
      if (res.status === 200) return res;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`server 未在 ${timeoutMs}ms 内就绪: ${lastErr && lastErr.message}\n${stderrChunks.join('')}`);
}

function tokenFromIndex(html) {
  const m = html.match(/<meta\s+name="panel-token"\s+content="([^"]+)"/);
  return m ? m[1] : '';
}

/** 写一个 rollout 会话文件；events 是 [{ ts, usage, resetAt }]。 */
function writeSession(threadId, dir, events) {
  const file = path.join(sessionsRoot, dir, `rollout-${threadId}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [];
  for (const ev of events) {
    const payload = {
      type: 'token_count',
      info: { last_token_usage: ev.usage },
    };
    if (ev.resetAt) {
      payload.rate_limits = {
        primary: { window_minutes: 10080, resets_at: ev.resetAt },
        secondary: { window_minutes: 300, resets_at: ev.resetAt },
      };
    }
    lines.push(JSON.stringify({ timestamp: new Date(ev.ts).toISOString(), type: 'event_msg', payload }));
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  seededFiles.push(file);
  return file;
}

function seedThreadsDb(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, cwd TEXT, model TEXT, updated_at INTEGER, updated_at_ms INTEGER)');
  const insert = db.prepare('INSERT INTO threads (id, title, cwd, model, updated_at, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run(todayThread, '实现用量面板', 'F:\\Proj\\Alpha', TODAY_MODEL, Math.floor(Date.now() / 1000), Date.now());
  insert.run(oldThread, '审查 登录流程', 'F:\\Proj\\Beta', OLD_MODEL, Math.floor(Date.now() / 1000) - 3 * 86400, Date.now() - 3 * DAY_MS);
  db.close();
}

before(async () => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-usage-test-'));
  const dataDir = path.join(codexHome, 'multi-auth');
  sessionsRoot = path.join(codexHome, 'sessions');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(sessionsRoot, { recursive: true });

  todayThread = crypto.randomUUID();
  oldThread = crypto.randomUUID();

  // 本地日界：今天的事件放在中午，三天前的事件放在中午（跨天累加可验证）
  const now = new Date();
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const todayNoon = dayStart + 12 * 3600 * 1000;
  const oldNoon = todayNoon - 3 * DAY_MS;
  const resetAt = Math.floor((now.getTime() + 5 * DAY_MS) / 1000);

  writeSession(todayThread, path.join('2026', '10', '25'), [
    { ts: todayNoon, usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 1200 }, resetAt },
    { ts: todayNoon + 3600 * 1000, usage: { input_tokens: 300, cached_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 350 } },
  ]);
  writeSession(oldThread, path.join('2026', '10', '22'), [
    { ts: oldNoon, usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 50, reasoning_output_tokens: 10, total_tokens: 550 }, resetAt },
  ]);

  seedThreadsDb(path.join(codexHome, 'state_5.sqlite'));

  for (let attempt = 0; attempt < 12 && !child; attempt++) {
    port = 20000 + Math.floor(Math.random() * 20000);
    stderrChunks = [];
    const candidate = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        CODEX_HOME: codexHome,
        // 让 codex-multi-auth CLI 必然找不到：账号清单为空，归属回落到 unknown
        APPDATA: path.join(codexHome, 'empty-appdata'),
        PANEL_PORT: String(port),
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        http_proxy: '',
        https_proxy: '',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    candidate.stderr.on('data', (c) => stderrChunks.push(c.toString('utf8')));
    candidate.on('exit', () => { /* 由断言路径处理 */ });

    const boot = (async () => {
      const res = await waitForServer(candidate);
      const t = tokenFromIndex(res.text);
      if (!t) throw new Error('页面里没有注入 panel token');
      return t;
    })();

    try {
      token = await boot;
      child = candidate;
    } catch (err) {
      try { candidate.kill(); } catch { /* ignore */ }
      if (attempt === 11) throw err;
    }
  }
});

after(() => {
  if (child && child.exitCode === null) {
    try { child.kill(); } catch { /* ignore */ }
  }
  try { fs.rmSync(codexHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('鉴权：不带 token 返回 401', async () => {
  const res = await request('GET', '/api/usage?days=7');
  assert.equal(res.status, 401);
  assert.equal(res.json.ok, false);
  assert.equal(typeof res.json.error, 'string');
});

test('响应信封与头部：{ ok, usage } + no-store', async () => {
  const res = await getUsage('?days=7&force=1');
  assert.equal(res.status, 200);
  assert.match(String(res.headers['content-type']), /application\/json/);
  assert.equal(String(res.headers['cache-control']), 'no-store');
  assert.equal(res.json.ok, true);
  assert.equal(typeof res.json.usage, 'object');
  assert.ok(res.json.usage);
});

test('7 天 totals 精确累加（3 个事件 / 2 个文件）', async () => {
  const res = await getUsage('?days=7&force=1');
  const u = res.json.usage;
  assert.equal(u.rangeDays, 7);
  assert.deepEqual(u.totals, {
    input: 1800,
    cached: 600,
    output: 300,
    reasoning: 70,
    tokens: 2100,
    events: 3,
  });
  assert.equal(u.scan.files, 2);
});

test('today 与 days 分布：今天 1550，三天前 550', async () => {
  const res = await getUsage('?days=7&force=1');
  const u = res.json.usage;
  assert.equal(u.today.tokens, 1550, 'today 只算今天的事件');
  assert.equal(u.days.length, 7);
  assert.equal(u.days[6].tokens, 1550, '最后一天是今天');
  assert.equal(u.days[3].tokens, 550, '三天前的那一天');
});

test('hours 恒为 24 小时且今日合计一致', async () => {
  const res = await getUsage('?days=7&force=1');
  const u = res.json.usage;
  assert.equal(u.hours.length, 24);
  const sum = u.hours.reduce((acc, h) => acc + h, 0);
  assert.equal(sum, 1550);
});

test('账号拆分：读不到账号清单时不编造账号，总量仍来自会话文件', async () => {
  const res = await getUsage('?days=7&force=1');
  const u = res.json.usage;
  assert.deepEqual(u.accounts, [], '按账号只来自路由账本 + 账号清单，没有就不拆');
  assert.equal(u.totals.tokens, 2100);
  assert.equal(u.current, null);
});

test('byRole / byModel / byProject 来自 threads 表', async () => {
  const res = await getUsage('?days=7&force=1');
  const u = res.json.usage;
  const modelMap = Object.fromEntries(u.byModel.map((x) => [x.model, x.tokens]));
  assert.equal(modelMap[TODAY_MODEL], 1550);
  assert.equal(modelMap[OLD_MODEL], 550);
  const roleMap = Object.fromEntries(u.byRole.map((x) => [x.role, x.tokens]));
  assert.equal(roleMap['主开发'], 1550);
  assert.equal(roleMap['自动 review'], 550);
  const projMap = Object.fromEntries(u.byProject.map((x) => [x.project, x.tokens]));
  assert.equal(projMap.Alpha, 1550);
  assert.equal(projMap.Beta, 550);
});

test('cacheHitRate / quota / topSessions 形状稳定', async () => {
  const res = await getUsage('?days=7&force=1');
  const u = res.json.usage;
  assert.equal(u.cacheHitRate, 600 / 1800);
  assert.ok(Array.isArray(u.windows), '每个账号的周窗口小结');
  assert.equal(u.quota, undefined, '“每 1% 周额度约多少 token”已删除（离散太大，没有参考价值）');
  assert.ok(Array.isArray(u.topSessions));
});

test('?days=1 只统计今天', async () => {
  const res = await getUsage('?days=1&force=1');
  const u = res.json.usage;
  assert.equal(u.rangeDays, 1);
  assert.equal(u.days.length, 1);
  assert.equal(u.totals.tokens, 1550);
  assert.equal(u.totals.events, 2);
});

test('?days 钳位到 1..14', async () => {
  const low = await getUsage('?days=0&force=1');
  assert.equal(low.json.usage.rangeDays, 1);
  const high = await getUsage('?days=99&force=1');
  assert.equal(high.json.usage.rangeDays, 14);
  assert.equal(high.json.usage.days.length, 14);
  assert.equal(high.json.usage.totals.tokens, 2100);
});

test('只读：扫描前后会话文件字节不变', async () => {
  const beforeHashes = seededFiles.map((f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  const res = await getUsage('?days=7&force=1');
  assert.equal(res.status, 200);
  const afterHashes = seededFiles.map((f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  assert.deepEqual(afterHashes, beforeHashes);
});
