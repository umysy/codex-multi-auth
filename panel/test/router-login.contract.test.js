'use strict';
/**
 * 运维接口的真实后端契约测试：`POST /api/router` 与 `POST /api/login`、`POST /api/login/cancel`。
 *
 * 为什么单独一个文件：这两条链路会**起停进程**，必须把路径全部关进沙箱，
 * 否则测试会动到真实用户的启动项、真实登录窗口。沙箱做法：
 *   - `CODEX_HOME` → 临时目录（数据、登录 launcher、状态文件都跟着走）
 *   - `USERPROFILE` → 临时目录（`ROUTER_CMD` 在 %USERPROFILE%\...\Startup 下，必须一起重定向）
 *   - `APPDATA` → 临时目录（找不到 codex-multi-auth CLI，正好测“CLI 不可用”的分支）
 *   - `PANEL_LOGIN_SPAWN=skip` → 只写登录 launcher/state，不真的弹窗口（测试机不该被窗口刷屏）
 *
 * 假路由器：写一个只做两件事的 node 脚本——把自己的 pid 写进 status json，然后睡住。
 * 这样 start / stop / restart 走的是真实的 spawn 与 taskkill 路径，但不会碰到真路由器。
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const WIN = process.platform === 'win32';
const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'panel', 'server.js');

let child = null;
let port = 0;
let token = '';
let sandbox = '';
let codexHome = '';
let dataDir = '';
let statusPath = '';
let bindPath = '';
let fakeRouterPath = '';
let fakePid = null;
let cliSpyPath = '';
const stderrChunks = [];

function request(method, pathname, { headers = {}, body = null, withToken = true } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path: pathname,
        headers: Object.assign(
          { Host: `127.0.0.1:${port}` },
          withToken ? { 'x-panel-token': token } : {},
          payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
          headers,
        ),
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* 静态资源不是 JSON */ }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer(proc, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`server 提前退出 (code=${proc.exitCode})\n${stderrChunks.join('')}`);
    try {
      const res = await request('GET', '/', { withToken: false });
      if (res.status === 200) return res;
    } catch (err) { lastErr = err; }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`server 未在 ${timeoutMs}ms 内就绪：${lastErr && lastErr.message}\n${stderrChunks.join('')}`);
}

function readStatus() {
  try { return JSON.parse(fs.readFileSync(statusPath, 'utf8')); } catch { return null; }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function stateRouter() {
  const res = await request('GET', '/api/state');
  assert.equal(res.status, 200, 'GET /api/state 必须 200');
  assert.equal(res.json.ok, true);
  return res.json.state.router;
}

async function waitFor(predicate, timeoutMs = 20000, label = '条件') {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`等待超时：${label}`);
}

before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-ops-'));
  codexHome = path.join(sandbox, 'codex');
  dataDir = path.join(codexHome, 'multi-auth');
  const appBind = path.join(dataDir, 'app-bind');
  statusPath = path.join(appBind, 'runtime-rotation-app-bind-status.json');
  bindPath = path.join(appBind, 'runtime-rotation-app-bind.json');
  const home = path.join(sandbox, 'home');
  fs.mkdirSync(appBind, { recursive: true });
  fs.mkdirSync(path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'), { recursive: true });
  // 假 CLI：只记下被调用的参数然后以失败退出（等同“CLI 不可用”），用来证明重新绑定不再调用 bind-app。
  cliSpyPath = path.join(sandbox, 'cli-calls.log');
  const fakeCli = path.join(sandbox, 'appdata', 'npm', 'node_modules', 'codex-multi-auth', 'scripts', 'codex-multi-auth.js');
  fs.mkdirSync(path.dirname(fakeCli), { recursive: true });
  fs.writeFileSync(fakeCli, "require('fs').appendFileSync(" + JSON.stringify(cliSpyPath) + ", process.argv.slice(2).join(' ') + '\\n'); process.exit(1);\n");

  // 假路由器：把 pid 写进 --status 指向的文件，然后挂住
  fakeRouterPath = path.join(sandbox, 'fake-router.js');
  fs.writeFileSync(fakeRouterPath, [
    "'use strict';",
    "const fs = require('fs');",
    'const args = process.argv.slice(2);',
    "const i = args.indexOf('--status');",
    'const statusPath = i >= 0 ? args[i + 1] : null;',
    'const payload = {',
    '  state: "running",',
    '  pid: process.pid,',
    '  totalRequests: 1,',
    '  upstreamRequests: 1,',
    '  rotations: 0,',
    '  retries: 0,',
    '  websocketConnections: 0,',
    '  lastError: "",',
    '  lastAccountIndex: 0,',
    '  startedAt: Date.now(),',
    '  updatedAt: Date.now(),',
    '};',
    'if (statusPath) fs.writeFileSync(statusPath, JSON.stringify(payload));',
    // 监听 --port，让「重新绑定」的端口检查看到一个活着的路由；端口被占用时忽略。
    "const p = args.indexOf('--port');",
    "if (p >= 0) require('net').createServer((s) => s.destroy()).on('error', () => {}).listen(Number(args[p + 1]), '127.0.0.1');",
    'setInterval(() => {}, 1000);',
    '',
  ].join('\n'));

  // app-bind：只给 ensureRouterCmd 需要的字段
  fs.writeFileSync(bindPath, JSON.stringify({
    nodePath: process.execPath,
    routerScriptPath: fakeRouterPath,
    port: 56014,
    statusPath,
    identityToken: 'test-token',
    statePath: path.join(appBind, 'state.json'),
    logPath: path.join(appBind, 'router.log'),
  }, null, 2));

  port = 20000 + Math.floor(Math.random() * 20000);
  const env = Object.assign({}, process.env, {
    CODEX_HOME: codexHome,
    USERPROFILE: home,
    APPDATA: path.join(sandbox, 'appdata'),
    PANEL_PORT: String(port),
    // 测试绝不允许真的弹登录窗口：显式关掉 spawn，只留 launcher + state 文件。
    PANEL_LOGIN_SPAWN: 'skip',
    HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '', no_proxy: '',
  });
  child = spawn(process.execPath, [SERVER], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  child.stderr.on('data', (c) => stderrChunks.push(String(c)));
  const homeRes = await waitForServer(child);
  token = (homeRes.text.match(/<meta\s+name="panel-token"\s+content="([^"]+)"/) || [])[1] || '';
  assert.match(token, /^[0-9a-f]{36}$/, '首页必须带注入的 36 位 token');
});

after(async () => {
  try { await request('POST', '/api/router', { body: { action: 'stop' } }); } catch { /* ignore */ }
  try { await request('POST', '/api/login/cancel', { body: {} }); } catch { /* ignore */ }
  if (fakePid && alive(fakePid)) { try { process.kill(fakePid); } catch { /* ignore */ } }
  if (child && child.exitCode === null) child.kill();
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
});

test('运维接口：未鉴权一律 401（router / login / login cancel）', { skip: !WIN }, async () => {
  for (const [method, p] of [['POST', '/api/router'], ['POST', '/api/login'], ['POST', '/api/login/cancel']]) {
    const res = await request(method, p, { withToken: false, body: {} });
    assert.equal(res.status, 401, `${p} 应 401`);
    assert.equal(res.json.ok, false);
  }
});

test('POST /api/router：未知动作 400，不触发任何进程操作', { skip: !WIN }, async () => {
  const res = await request('POST', '/api/router', { body: { action: 'nope' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
  assert.match(res.json.error, /未知路由操作/);
});

test('POST /api/router start：拉起假路由器并返回真实 PID', { skip: !WIN }, async () => {
  const res = await request('POST', '/api/router', { body: { action: 'start' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.message, /^路由已启动 · PID \d+ · 端口 56014$/);
  assert.ok(res.json.state, '响应里应带最新 state（前端直接拿它渲染）');

  const pid = Number((res.json.message.match(/PID (\d+)/) || [])[1]);
  fakePid = pid;
  assert.ok(pid > 0);
  await waitFor(() => alive(pid), 5000, '假路由器进程存活');
  assert.equal(readStatus().pid, pid, 'status 文件里的 pid 必须与返回的一致');
  const router = await stateRouter();
  assert.equal(router.running, true);
  assert.equal(router.pid, pid);
  assert.equal(router.port, 56014);
});

test('POST /api/router start（已在运行）：幂等，重复调用不换进程', { skip: !WIN }, async () => {
  const before = readStatus().pid;
  const res = await request('POST', '/api/router', { body: { action: 'start' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.message, /^路由已启动 · PID (\d+) · 端口 56014$/);
  const after = Number(res.json.message.match(/PID (\d+)/)[1]);
  assert.equal(after, before, '已经在跑时不应再起一个');
  assert.equal(readStatus().pid, before);
});

test('路由按钮可跳过附带全量状态，操作成功后单独读取最新状态', { skip: !WIN }, async () => {
  const res = await request('POST', '/api/router', { body: { action: 'start', includeState: false } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(Object.hasOwn(res.json, 'state'), false);
  assert.equal((await stateRouter()).running, true);
});

test('POST /api/router stop：杀掉进程并把 running 置 false', { skip: !WIN }, async () => {
  const pid = fakePid;
  const res = await request('POST', '/api/router', { body: { action: 'stop' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.message, /^路由已停止$/);
  await waitFor(() => !alive(pid), 8000, '假路由器进程退出');
  const router = await stateRouter();
  assert.equal(router.running, false);
});

test('POST /api/router restart：先停后起，返回新 PID', { skip: !WIN }, async () => {
  await request('POST', '/api/router', { body: { action: 'start' } });
  const oldPid = readStatus().pid;
  const res = await request('POST', '/api/router', { body: { action: 'restart' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.message, /^路由已重启 · PID (\d+) · 端口 56014$/);
  const newPid = Number(res.json.message.match(/PID (\d+)/)[1]);
  fakePid = newPid;
  await waitFor(() => alive(newPid), 5000, '重启后的假路由器存活');
  assert.notEqual(newPid, oldPid, '重启应换一个新进程');
  assert.equal(readStatus().pid, newPid);
});

test('POST /api/router rebind：只改 config.toml 的路由行，不调用 CLI，不动 app-bind 与启动项', { skip: !WIN }, async () => {
  const sha = (f) => require('crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const key = 'c3'.repeat(32);
  const bind = JSON.parse(fs.readFileSync(bindPath, 'utf8'));
  fs.writeFileSync(bindPath, JSON.stringify(Object.assign(bind, { clientApiKey: key }), null, 2));
  const cfg = path.join(codexHome, 'config.toml');
  const original = [
    'model_provider = "codex-multi-auth-runtime-proxy"',
    'openai_base_url = "http://127.0.0.1:1111"',
    'model = "gpt-6.1-sol"',
    '',
    '[desktop]',
    'theme = "dark"',
    '',
    '[model_providers.codex-multi-auth-runtime-proxy]',
    'name = "codex-multi-auth"',
    'base_url = "http://127.0.0.1:1111"',
    'experimental_bearer_token = "' + 'd4'.repeat(32) + '"',
    'wire_api = "responses"',
    '',
  ].join('\r\n');
  fs.writeFileSync(cfg, original);
  const startup = path.join(sandbox, 'home', 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Codex Multi Auth Runtime Router.cmd');
  const keep = [bindPath].concat(fs.existsSync(startup) ? [startup] : []).map((f) => [f, sha(f)]);
  try { fs.unlinkSync(cliSpyPath); } catch { /* 还没被调用过 */ }
  await waitFor(() => require('../lib/binding-guard').isListening(56014), 8000, '假路由器监听 56014');

  const res = await request('POST', '/api/router', { body: { action: 'rebind' } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true, res.json.message);
  assert.match(res.json.message, /端口 56014/);
  assert.ok(!res.json.message.includes(key), '消息里不能出现密钥');
  const next = fs.readFileSync(cfg, 'utf8');
  const a = original.split('\r\n'), b = next.split('\r\n');
  assert.equal(b.length, a.length);
  assert.deepEqual(b.filter((l, i) => l !== a[i]), [
    'openai_base_url = "http://127.0.0.1:56014"',
    'base_url = "http://127.0.0.1:56014"',
    'experimental_bearer_token = "' + key + '"',
  ]);
  for (const [f, h] of keep) assert.equal(sha(f), h, path.basename(f) + ' 不应被改动');
  const calls = fs.existsSync(cliSpyPath) ? fs.readFileSync(cliSpyPath, 'utf8') : '';
  assert.ok(!/bind-app/.test(calls), '重新绑定不能再调用 CLI 的 bind-app：' + calls);
});

test('POST /api/router rebind：provider 段被删掉时拒绝并给出中文说明，不写盘', { skip: !WIN }, async () => {
  const cfg = path.join(codexHome, 'config.toml');
  const broken = 'model_provider = "openai"\r\nmodel = "gpt-6.1-sol"\r\n';
  fs.writeFileSync(cfg, broken);
  const res = await request('POST', '/api/router', { body: { action: 'rebind', includeState: false } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.code, 'REBIND_NO_PROVIDER');
  assert.match(res.json.message, /手动恢复/);
  assert.equal(fs.readFileSync(cfg, 'utf8'), broken);
});

test('重新绑定在账号或配置守卫持锁时返回 409，不启动 CLI', { skip: !WIN }, async () => {
  const lock = path.join(dataDir, 'account-operations.lock');
  fs.writeFileSync(lock, JSON.stringify({pid: process.pid, at: Date.now()}), {flag: 'wx'});
  try {
    const response = await request('POST', '/api/router', {body: {action: 'rebind', includeState: false}});
    assert.equal(response.status, 409);
    assert.equal(response.json.ok, false);
    assert.equal(response.json.code, 'ACCOUNT_OPERATION_BUSY');
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  } finally { fs.unlinkSync(lock); }
});

test('POST /api/login/cancel：没有登录窗口时是幂等的', { skip: !WIN }, async () => {
  const res = await request('POST', '/api/login/cancel', { body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.match(res.json.message, /^已清理登录窗口（0 个）。$/);
});

test('POST /api/login（DRY RUN，禁弹窗）：写 launcher + state，重复点 409，cancel 清干净', { skip: !WIN }, async () => {
  const loginCmd = path.join(dataDir, 'panel-open-login.cmd');
  const loginState = path.join(dataDir, 'panel-login.state');

  const res = await request('POST', '/api/login', { body: { dry: true } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.dry, true);
  assert.match(res.json.message, /试运行/);
  assert.ok(fs.existsSync(loginCmd), '应写出登录 launcher（.cmd）');
  assert.match(fs.readFileSync(loginCmd, 'utf8'), /DRY RUN/, 'dry 版 launcher 必须带 DRY RUN 标记');
  assert.ok(fs.existsSync(loginState), 'launcher 启动标记（panel-login.state）必须存在，单飞靠它判断');

  // 窗口刚启动：再点一次必须被拦，而不是再开一个窗口
  const again = await request('POST', '/api/login', { body: { dry: true } });
  assert.equal(again.status, 409);
  assert.equal(again.json.ok, false);
  assert.match(again.json.error, /请稍等|正在授权中/);

  const cancel = await request('POST', '/api/login/cancel', { body: {} });
  assert.equal(cancel.status, 200);
  assert.equal(cancel.json.ok, true);
  assert.equal(fs.existsSync(loginCmd), false, 'cancel 必须清掉 launcher');
  assert.equal(fs.existsSync(loginState), false, 'cancel 必须清掉登录状态文件');
});
