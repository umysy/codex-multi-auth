'use strict';
/**
 * “刷新额度不再卡住界面”的回归测试：启动真正的 panel/server.js，用一个**会慢的假 CLI**
 * （limits --refresh 故意睡 2.5 秒）验证新的刷新语义：
 *
 *   1. POST /api/refresh 立刻返回（不等待上游），响应里 meta.refreshing=true；
 *   2. 刷新进行中 GET /api/state 不阻塞，先给旧数据；
 *   3. 后台构建完成后，下一次 GET /api/state 拿到新数字，refreshing=false；
 *   4. GET /api/state?force=1 只走“快查询”，不会触发 limits --refresh；
 *   5. 连点刷新会合并成一次深度查询（single-flight）。
 *
 * 假 CLI 放在临时 APPDATA 下，server 用 execFile(node, [CLI, ...]) 调它。
 * 它会把自己的调用记录写到 marker 文件，测试用它断言“调用了几次”。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'panel', 'server.js');
const REFRESH_SLEEP_MS = 2500;

let child = null;
let port = 0;
let token = '';
let codexHome = '';
let appData = '';
let fakeCli = '';
let marker = '';
const stderrChunks = [];

function request(method, pathname, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? '' : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: { Host: `127.0.0.1:${port}`, 'x-panel-token': token, 'Content-Length': Buffer.byteLength(payload), 'Content-Type': 'application/json' },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 非 JSON */ }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('request timeout')));
    req.end(payload);
  });
}

async function timed(fn) {
  const t0 = Date.now();
  const result = await fn();
  return { ms: Date.now() - t0, result };
}

function callsMade() {
  try {
    return fs.readFileSync(marker, 'utf8').split('\n').filter(Boolean);
  } catch { return []; }
}

function refreshCalls() {
  return callsMade().filter((line) => line.includes('limits') && line.includes('--refresh'));
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForServer(proc, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server 提前退出\n${stderrChunks.join('')}`);
    try {
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port, path: '/', method: 'GET' }, (r) => {
          const chunks = [];
          r.on('data', (c) => chunks.push(c));
          r.on('end', () => resolve({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
        req.setTimeout(4000, () => req.destroy(new Error('boot timeout')));
        req.end();
      });
      if (res.status === 200) return res;
    } catch (err) { lastErr = err; }
    await sleep(120);
  }
  throw new Error(`server 未就绪: ${lastErr && lastErr.message}\n${stderrChunks.join('')}`);
}

/** 假 CLI：status / limits（缓存 5%）/ limits --refresh（睡 2.5s，10%）/ policy list。 */
const FAKE_CLI_SOURCE = `'use strict';
const fs = require('fs');
const args = process.argv.slice(2);
const marker = process.env.FAKE_CMA_MARKER;
const refreshedFile = marker + '.refreshed';
const sleep = Number(process.env.FAKE_CMA_REFRESH_SLEEP || 0);
if (marker) fs.appendFileSync(marker, args.join(' ') + '\\n');
const account = (used, windowMinutes, planType) => ({
  index: 0,
  label: 'fake@example.com',
  quota: {
    planType,
    status: 200,
    primary: { usedPercent: used, windowMinutes, resetAtMs: Date.now() + 6 * 86400000 },
  },
});
function out(obj) { process.stdout.write(JSON.stringify(obj)); }
if (args[0] === 'status') {
  out({ activeIndex: 0, accountCount: 1, accounts: [{ index: 0, label: 'fake@example.com', current: true }] });
} else if (args[0] === 'limits') {
  const refresh = args.includes('--refresh');
  if (!refresh && fs.existsSync(marker + '.slow-fast')) {
    const until = Date.now() + 700;
    while (Date.now() < until) {}
  }
  const refreshed = refresh || (marker && fs.existsSync(refreshedFile));
  if (refresh) {
    const t0 = Date.now();
    while (Date.now() - t0 < sleep) { /* 用忙等代替异步，保证假 CLI 真的慢 */ }
    fs.writeFileSync(refreshedFile, '1');
  }
  out({ accounts: [account(refreshed ? 10 : 5, 10080, 'Plus')] });
} else if (args[0] === 'account' && args[1] === 'policy') {
  out({ accounts: [{ index: 1, paused: false, emergencyOnly: false, note: '' }] });
} else if (args[0] === 'account' && args[1] === 'pause') {
  out({ ok: true });
} else if (args[0] === 'account' && args[1] === 'unpause') {
  out({ ok: true });
} else {
  out({ ok: true });
}
`;

function tokenFromIndex(html) {
  const m = html.match(/<meta\s+name="panel-token"\s+content="([^"]+)"/);
  return m ? m[1] : '';
}

before(async () => {
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-refresh-test-'));
  appData = path.join(codexHome, 'appdata');
  const dataDir = path.join(codexHome, 'multi-auth');
  fs.mkdirSync(dataDir, { recursive: true });
  const cliDir = path.join(appData, 'npm', 'node_modules', 'codex-multi-auth', 'scripts');
  fs.mkdirSync(cliDir, { recursive: true });
  fakeCli = path.join(cliDir, 'codex-multi-auth.js');
  fs.writeFileSync(fakeCli, FAKE_CLI_SOURCE, 'utf8');
  marker = path.join(codexHome, 'fake-cma-calls.log');

  for (let attempt = 0; attempt < 12 && !child; attempt++) {
    port = 20000 + Math.floor(Math.random() * 20000);
    stderrChunks.length = 0;
    const candidate = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        CODEX_HOME: codexHome,
        APPDATA: appData,
        PANEL_PORT: String(port),
        FAKE_CMA_MARKER: marker,
        FAKE_CMA_REFRESH_SLEEP: String(REFRESH_SLEEP_MS),
        HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    candidate.stderr.on('data', (c) => stderrChunks.push(c.toString('utf8')));
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
  if (child && child.exitCode === null) { try { child.kill(); } catch { /* ignore */ } }
  try { fs.rmSync(codexHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('首次 /api/state 走“快查询”，不触发 limits --refresh', async () => {
  const { ms, result } = await timed(() => request('GET', '/api/state?force=1'));
  assert.equal(result.status, 200);
  assert.ok(result.json.ok);
  assert.equal(refreshCalls().length, 0, 'force 不应该打上游');
  assert.ok(ms < 2000, `快查询应在 2s 内，实际 ${ms}ms`);
  const acc = result.json.state.accounts[0];
  assert.equal(acc.h7.remaining, 95, '缓存版 limits 是 5% used');
});

test('POST /api/refresh 立刻返回，标记 refreshing（不等 2.5s 的上游）', async () => {
  const { ms, result } = await timed(() => request('POST', '/api/refresh'));
  assert.equal(result.status, 200);
  assert.ok(result.json.ok);
  assert.equal(result.json.state.meta.refreshing, true);
  assert.ok(ms < 1200, `刷新接口应立即返回，实际 ${ms}ms`);
});

test('刷新进行中 GET /api/state 不阻塞，先给旧数据', async () => {
  const { ms, result } = await timed(() => request('GET', '/api/state?force=1'));
  assert.equal(result.status, 200);
  assert.ok(ms < 1200, `刷新中读状态也不该卡住，实际 ${ms}ms`);
  assert.equal(result.json.state.meta.refreshing, true);
  assert.equal(result.json.state.accounts[0].h7.remaining, 95);
});

test('后台完成后看到新数字，refreshing=false', async () => {
  const deadline = Date.now() + 8000;
  let state = null;
  while (Date.now() < deadline) {
    const res = await request('GET', '/api/state?force=1');
    state = res.json.state;
    if (!state.meta.refreshing) break;
    await sleep(300);
  }
  assert.equal(state.meta.refreshing, false);
  assert.equal(state.accounts[0].h7.remaining, 90, '深度刷新后是 10% used');
  assert.equal(refreshCalls().length, 1, '深度查询只跑了一次');
});

test('连点刷新合并成一次深度查询（single-flight）', async () => {
  const before = refreshCalls().length;
  const first = await request('POST', '/api/refresh');
  const second = await request('POST', '/api/refresh');
  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.ok(first.json.state.meta.refreshing || second.json.state.meta.refreshing);
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline && refreshCalls().length === before) await sleep(200);
  const afterCount = refreshCalls().length;
  assert.ok(afterCount <= before + 1, `连点两次只应触发一次，实际 ${afterCount - before} 次`);
});

test('后台查询中保存策略会补查状态，旧查询不能覆盖操作结果', async () => {
  // Start from a settled snapshot, then invalidate while an upstream query waits.
  while ((await request('GET', '/api/state?force=1')).json.state.meta.refreshing) await sleep(100);
  await request('POST', '/api/refresh');
  const before = callsMade().filter(line => line.includes('account policy list')).length;
  const saved = await request('POST', '/api/policy', {autoSwitch: false, minWaitMin: 43, reserveIndex: 1});
  assert.equal(saved.status, 200);
  const immediate = await request('GET', '/api/state');
  assert.equal(immediate.json.state.policy.minWaitMin, 43, '保存后的第一份快照必须立即带新策略，即使额度仍在刷新');
  let state;
  const deadline = Date.now() + 10000;
  do {
    state = (await request('GET', '/api/state')).json.state;
    if (!state.meta.refreshing && state.policy.minWaitMin === 43) break;
    await sleep(100);
  } while (Date.now() < deadline);
  assert.equal(state.policy.minWaitMin, 43);
  assert.ok(callsMade().filter(line => line.includes('account policy list')).length > before, '保存后必须补一次查询');
});

test('普通查询中点击刷新会排队一次上游查询，重复点击不会丢失或重复执行', async () => {
  fs.writeFileSync(marker + '.slow-fast', '1');
  try {
    const before = refreshCalls().length;
    const fastBefore = callsMade().filter(line => line === 'limits --json').length;
    const fast = request('GET', '/api/state?force=1');
    const deadline = Date.now() + 4000;
    while (callsMade().filter(line => line === 'limits --json').length === fastBefore) {
      assert.ok(Date.now() < deadline, '普通查询必须已经开始');
      await sleep(20);
    }
    const first = await request('POST', '/api/refresh');
    const second = await request('POST', '/api/refresh');
    assert.equal(first.json.state.meta.refreshing, true);
    assert.equal(second.json.state.meta.refreshing, true);
    await fast;
    const settled = await request('GET', '/api/state');
    assert.equal(settled.json.state.meta.refreshing, false);
    assert.equal(refreshCalls().length, before + 1);
  } finally {
    fs.unlinkSync(marker + '.slow-fast');
  }
});
