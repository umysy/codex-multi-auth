'use strict';
/**
 * /api/state 的 app 字段 + /api/app-login 的真实后端契约测试。
 *
 * 用途：锁住“面板能看见应用登录账号、能在需要时同步”——
 *   - /api/state 里必须带 app 摘要，且**绝不能**泄漏 accessToken/refreshToken；
 *   - /api/app-login 需要 token 鉴权；
 *   - 同步后 ~/.codex/auth.json 换成代理当前账号，/api/state 里 matchesCurrent 变 true。
 *
 * 沙箱：临时 CODEX_HOME（内含 multi-auth/openai-codex-accounts.json 与 auth.json），
 * 不触碰真实 ~/.codex。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

let proc = null;
let base = '';
let token = '';
let sandbox = '';
let accountsFile = '';
let authPath = '';

function fakeToken(email, accountId) {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: 'plus' },
    'https://api.openai.com/profile': { email },
  };
  return 'h.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') + '.s';
}

async function waitForServer(p, port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (p.exitCode !== null) throw new Error('server exited early: ' + p.exitCode);
    try {
      const res = await fetch('http://127.0.0.1:' + port + '/');
      if (res.ok) return await res.text();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function api(pathname, opts = {}) {
  const res = await fetch(base + pathname, {
    method: opts.method || 'GET',
    headers: Object.assign({ 'x-panel-token': token }, opts.headers || {}),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, json, text };
}

before(async () => {
  // 前缀不能用 cma-app-login-：那是真实登录流程的临时 home，绑定守卫会当成泄漏去清理。
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-applogin-test-'));
  const data = path.join(sandbox, 'multi-auth');
  fs.mkdirSync(data, { recursive: true });
  accountsFile = path.join(data, 'openai-codex-accounts.json');
  authPath = path.join(sandbox, 'auth.json');
  const tokenA = fakeToken('a@example.com', 'acct-a');
  const tokenB = fakeToken('b@example.com', 'acct-b');
  fs.writeFileSync(accountsFile, JSON.stringify({
    activeIndex: 1,
    accounts: [
      { email: 'a@example.com', accountId: 'acct-a', accessToken: tokenA, refreshToken: 'r1' },
      { email: 'b@example.com', accountId: 'acct-b', accessToken: tokenB, refreshToken: 'r2' },
    ],
  }, null, 2), 'utf8');
  // 应用当前登录的是 a，而代理在用 b —— 正是“界面喊额度用完”的那类不一致。
  fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: tokenA, account_id: 'acct-a' } }, null, 2), 'utf8');

  const port = 20000 + Math.floor(Math.random() * 20000);
  const env = Object.assign({}, process.env, {
    CODEX_HOME: sandbox,
    // 2026-10-29 复现：只换 CODEX_HOME 时，面板调用的是真实 CLI（APPDATA），它在空 CODEX_HOME 里
    // 做首次绑定，起了一个临时路由并把真实 ~/.codex/config.toml 指向它——Codex 整晚连着死端口。
    USERPROFILE: path.join(sandbox, 'home'),
    APPDATA: path.join(sandbox, 'appdata'),
    PANEL_PORT: String(port),
    HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '', no_proxy: '',
    PANEL_LOGIN_SPAWN: 'skip',
  });
  proc = spawn(process.execPath, [path.join(ROOT, 'panel', 'server.js')], { env, stdio: 'ignore' });
  const html = await waitForServer(proc, port);
  const m = /<meta\s+name="panel-token"\s+content="([^"]+)"/.exec(html);
  assert.ok(m && m[1].length === 36, 'token meta 必须是 36 位 hex');
  token = m[1];
  base = 'http://127.0.0.1:' + port;
});

after(() => {
  try { proc.kill(); } catch { /* ignore */ }
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('/api/state 带 app 摘要，且不泄漏 token', async () => {
  const r = await api('/api/state');
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const st = r.json.state;
  assert.ok(st.app, 'state.app 必须存在');
  assert.equal(st.app.loggedInEmail, 'a@example.com');
  assert.equal(st.app.currentEmail, 'b@example.com');
  assert.equal(st.app.matchesCurrent, false);
  assert.match(st.app.hint, /不一致/);
  assert.doesNotMatch(r.text, /accessToken|refreshToken|access_token/);
});

test('/api/app-login 未带 token 时 401', async () => {
  const res = await fetch(base + '/api/app-login', { method: 'POST', body: '{}' });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.ok, false);
});

test('/api/app-login 指定 email 同步应用登录，state 变一致', async () => {
  const r = await api('/api/app-login', { method: 'POST', body: { email: 'b@example.com' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const saved = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  const payload = JSON.parse(Buffer.from(saved.tokens.access_token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(payload['https://api.openai.com/profile'].email, 'b@example.com');
  assert.equal(saved.tokens.account_id, 'acct-b');

  // /api/state 有 60 秒 TTL + stale-while-revalidate：同步后要等一次重建。
  let app = null;
  for (let i = 0; i < 40; i += 1) {
    const snap = await api('/api/state?force=1');
    app = snap.json && snap.json.state && snap.json.state.app;
    if (app && app.matchesCurrent) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(app.matchesCurrent, true);
  assert.equal(app.loggedInEmail, 'b@example.com');
});

test('/api/app-login 缺账号时 400 且信封可读', async () => {
  const r = await api('/api/app-login', { method: 'POST', body: { email: 'nobody@example.com' } });
  assert.equal(r.status, 400);
  assert.equal(r.json.ok, false);
  assert.ok(typeof r.json.error === 'string' && r.json.error.length > 0);
});
