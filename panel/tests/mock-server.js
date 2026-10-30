'use strict';
/**
 * mock-server.js — Codex 额度面板的隔离 mock 后端（零依赖，只读真实 public/）
 *
 * 目的：给 E2E 回归提供一个「可以随便点、绝不会碰真实账号」的后端。
 *
 * 隔离边界
 *  - 只监听 127.0.0.1:8799（生产是 8766，两个可以同时跑）；
 *  - 静态文件从真实 panel/public/ 只读提供，index.html 里 __PANEL_TOKEN__ 换成
 *    本进程随机生成的 token（与生产 server.js 的注入方式一致）；
 *  - 所有状态都在内存里（fixtures.js 的深拷贝），进程退出即消失；
 *  - 不读也不写 ~/.codex 下的任何账号 / 路由文件。
 *
 * 与生产的差异（有意为之）
 *  - 「刷新额度」按钮在前端是 loadState(true) → GET /api/state?force=1，
 *    并不调用 POST /api/refresh。为了让 E2E 能观察到「刷新后额度变化」，
 *    mock 把 force 读取也算作一次刷新：totals.weekRemaining += 1。
 *    POST /api/refresh 同样 +1（真实调用方也支持）。
 *  - 前端没有 unpin 按钮，但保留 POST /api/account {action:'unpin'} 供 API 级验证。
 *
 * 用法
 *  node tests/mock-server.js [--port 8799] [--fixture path/to/state.json]
 *  启动后打印 "MOCK LISTENING 8799"。
 *  --fixture 读一个 JSON，浅合并进内置 fixture（数组整体替换）。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createFixture } = require('./fixtures');
const { validateRotation } = require('../lib/rotation-policy');

const TESTS_DIR = __dirname;
const PANEL_DIR = path.join(TESTS_DIR, '..');
const PUBLIC_DIR = path.join(PANEL_DIR, 'public');
const DEFAULT_PORT = 8799;

// 与生产 server.js 的 STATIC 表保持一致（只多不少，方便直接访问 /index.html）
const JS_TYPE = 'application/javascript; charset=utf-8';
const PUBLIC_MODULES = [
  'format', 'api', 'dom', 'render-overview', 'render-accounts', 'render-panels', 'rotation-editor', 'actions',
];
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', JS_TYPE],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
for (const name of PUBLIC_MODULES) {
  STATIC['/modules/' + name + '.mjs'] = ['modules/' + name + '.mjs', JS_TYPE];
}

const HOST_OK = /^(?:(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?)$/i;
const ORIGIN_OK = /^(https?:\/\/)(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

// ---------------------------------------------------------------- 小工具

function send(res, code, body, headers) {
  const payload = Buffer.isBuffer(body)
    ? body
    : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  res.writeHead(
    code,
    Object.assign(
      {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Length': payload.length,
      },
      headers || {},
    ),
  );
  res.end(payload);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 浅合并：对象递归一层以上、数组整体替换，null 表示显式清空。 */
function mergeState(base, patch) {
  if (!isPlainObject(patch)) return base;
  for (const key of Object.keys(patch)) {
    const next = patch[key];
    if (isPlainObject(next) && isPlainObject(base[key])) mergeState(base[key], next);
    else base[key] = next;
  }
  return base;
}

function readFixtureFile(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(raw);
}

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, fixture: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]) || DEFAULT_PORT;
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7)) || DEFAULT_PORT;
    else if (a === '--fixture' || a === '-f') out.fixture = argv[++i] || null;
    else if (a.startsWith('--fixture=')) out.fixture = a.slice(10) || null;
  }
  return out;
}

function isLocalHostHeader(host, port) {
  if (!host) return false;
  const s = String(host).toLowerCase();
  return s === '127.0.0.1:' + port || s === 'localhost:' + port || s === '[::1]:' + port || HOST_OK.test(s);
}

function originAllowed(origin) {
  const o = String(origin || '').trim();
  if (!o) return true;
  return ORIGIN_OK.test(o);
}

function authed(req, token) {
  const hdr = req.headers['x-panel-token'];
  if (hdr && hdr === token) return true;
  const cookie = req.headers.cookie || '';
  return String(cookie)
    .split(';')
    .some((c) => c.trim() === 'panel-token=' + token);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const max = limit || 1024 * 1024;
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        resolve(isPlainObject(parsed) ? parsed : {});
      } catch (err) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------- 应用

function createApp(options) {
  const opts = options || {};
  const port = Number(opts.port) || DEFAULT_PORT;
  const token = opts.token || crypto.randomBytes(18).toString('hex');
  const state = mergeState(createFixture(), opts.patch || {});
  const stats = { requests: 0, refreshes: 0, unauthorized: 0 };

  // 补齐缺省结构，并让派生字段（current / selection.available / darkAt…）随可变状态自洽。
  // 注意：不重算 totals.weekRemaining —— 刷新 +1 必须能被观察到。
  if (!state.router || typeof state.router !== 'object') state.router = {};
  const rt = state.router;
  if (!Number.isFinite(Number(rt.port))) rt.port = 56014;
  if (!Array.isArray(state.accounts)) state.accounts = [];
  if (!isPlainObject(state.policy)) state.policy = {};
  if (!isPlainObject(state.totals)) state.totals = {};
  if (!isPlainObject(state.selection)) state.selection = {};
  if (!Array.isArray(state.logs)) state.logs = [];
  if (!Array.isArray(state.alerts)) state.alerts = [];
  if (!Array.isArray(state.errors)) state.errors = [];

  function normalize() {
    const now = Date.now();
    state.now = now;

    for (const a of state.accounts) {
      if (a.emergencyOnly) a.role = 'reserve';
      else if (a.paused) a.role = 'paused';
      else a.role = 'daily';
      a.available = !a.paused;
    }

    const sel = state.selection;
    sel.total = state.accounts.length;
    sel.available = state.accounts.filter((a) => a.available).length;
    const cur = state.accounts.find((a) => a.current) || null;
    state.current = cur;
    if (cur) {
      sel.active = cur.n;
      sel.runtimeInUse = cur.n;
    }

    const t = state.totals;
    t.weekRemaining = Number(t.weekRemaining) || 0;
    if (!Number.isFinite(Number(t.budgetRate))) t.budgetRate = 1.5;
    if (Number(t.hoursLeft) > 0) t.darkAt = now + Number(t.hoursLeft) * 3600000;
    if (Number(t.budgetHours) > 0) t.budgetDarkAt = now + Number(t.budgetHours) * 3600000;

    const p = state.policy;
    if (!Number.isFinite(Number(p.minMinWait))) p.minMinWait = 5;
    if (!Number.isFinite(Number(p.maxMinWait))) p.maxMinWait = 600;

    return state;
  }

  function pushLog(kind, msg, src) {
    state.logs.unshift({
      at: new Date().toISOString().replace('T', ' ').slice(0, 19),
      msg,
      kind,
      src: src || 'mock',
    });
    if (state.logs.length > 200) state.logs.length = 200;
  }

  function bumpWeek() {
    state.totals.weekRemaining = (Number(state.totals.weekRemaining) || 0) + 1;
    stats.refreshes += 1;
    normalize();
    return state;
  }

  function accountByN(n) {
    return state.accounts.find((a) => a.n === n) || null;
  }

  /** 返回给前端的 message；未知 action 返回 null。 */
  function applyAccountAction(acc, action, value) {
    switch (action) {
      case 'pause':
        acc.paused = true;
        acc.reason = 'policy: 手动暂停（mock）';
        pushLog('GUARD', '账号' + acc.n + ' 已暂停，退出轮转候选', 'mock');
        return '已暂停账号 ' + acc.n + '（不再参与轮转）';
      case 'unpause':
        acc.paused = false;
        acc.reason = 'primary quota 4% used';
        pushLog('OK', '账号' + acc.n + ' 已恢复使用', 'mock');
        return '已恢复账号 ' + acc.n;
      case 'reserve':
        acc.emergencyOnly = true;
        acc.paused = true;
        acc.reason = 'policy: 储备号，仅紧急时启用（mock）';
        pushLog('GUARD', '账号' + acc.n + ' 设为储备号（只在紧急模式启用）', 'mock');
        return '账号 ' + acc.n + ' 已设为储备号';
      case 'unreserve':
        acc.emergencyOnly = false;
        acc.paused = false;
        acc.reason = 'primary quota 4% used';
        pushLog('OK', '账号' + acc.n + ' 恢复为日常号', 'mock');
        return '账号 ' + acc.n + ' 已恢复为日常号';
      case 'switch': {
        if (acc.paused) return '账号 ' + acc.n + ' 已暂停，无法切换';
        for (const a of state.accounts) a.current = a.n === acc.n;
        state.selection.pinned = acc.n;
        state.router.lastAccountIndex = acc.n;
        pushLog('SWITCH', '手动切换到账号' + acc.n + '（mock）', 'mock');
        return '已切换到账号 ' + acc.n + '（mock）';
      }
      case 'unpin':
        state.selection.pinned = null;
        pushLog('OK', '已取消固定账号（unpin，mock）', 'mock');
        return '已取消固定（unpin）';
      case 'note':
        acc.note = String(value == null ? '' : value).slice(0, 200);
        pushLog('OK', '账号' + acc.n + ' 备注已更新', 'mock');
        return '备注已保存';
      default:
        return null;
    }
  }

  async function handle(req, res) {
    stats.requests += 1;

    let url;
    try {
      url = new URL(req.url, 'http://127.0.0.1:' + port);
    } catch (err) {
      return send(res, 400, { ok: false, error: 'bad request' });
    }
    const pathname = url.pathname;
    const method = req.method || 'GET';

    if (!isLocalHostHeader(req.headers.host, port)) {
      return send(res, 403, { ok: false, error: 'forbidden host' });
    }
    if (!originAllowed(req.headers.origin)) {
      return send(res, 403, { ok: false, error: 'forbidden origin' });
    }
    if (method === 'GET' && pathname === '/favicon.ico') return send(res, 204, '');

    // 静态资源：真实 public/ 只读；index.html 注入本次进程的 token
    if (method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname];
      let body;
      try {
        body = fs.readFileSync(path.join(PUBLIC_DIR, file));
      } catch (err) {
        return send(res, 500, { ok: false, error: 'mock 读不到 public/' + file });
      }
      if (file === 'index.html') {
        const html = body.toString('utf8').replace('__PANEL_TOKEN__', token);
        return send(res, 200, html, { 'Content-Type': type });
      }
      return send(res, 200, body, { 'Content-Type': type });
    }

    if (!authed(req, token)) {
      stats.unauthorized += 1;
      return send(res, 401, { ok: false, error: 'unauthorized' });
    }

    if (method === 'GET' && pathname === '/api/state') {
      // 前端「刷新额度」= loadState(true) = ?force=1，因此 force 读取计入一次刷新
      if (url.searchParams.get('force') === '1') bumpWeek();
      return send(res, 200, { ok: true, state: normalize() });
    }

    if (method === 'GET' && pathname === '/api/logs') {
      return send(res, 200, { ok: true, logs: state.logs.slice(0, 120) });
    }

    if (method === 'POST' && pathname === '/api/refresh') {
      bumpWeek();
      pushLog('ROUTER', '手动刷新额度（mock +1%）', 'mock');
      return send(res, 200, { ok: true, state: normalize() });
    }

    if (method === 'POST' && pathname === '/api/account') {
      const body = await readBody(req);
      const n = Math.round(Number(body.n));
      if (!n || n < 1) return send(res, 400, { ok: false, error: '账号序号无效' });
      const acc = accountByN(n);
      if (!acc) return send(res, 404, { ok: false, error: '账号不存在: ' + n });
      const action = String(body.action || '');
      const message = applyAccountAction(acc, action, body.value);
      if (message === null) return send(res, 400, { ok: false, error: '未知操作: ' + action });
      normalize();
      return send(res, 200, { ok: true, message });
    }

    if (method === 'POST' && pathname === '/api/policy') {
      const body = await readBody(req);
      let rotation;
      if (Object.prototype.hasOwnProperty.call(body, 'rotation')) {
        try { rotation = body.rotation === null ? null : validateRotation(body.rotation); }
        catch { return send(res, 400, { ok: false, error: '轮换规则无效', code: 'ROTATION_CONFIG_INVALID' }); }
      }
      const p = state.policy;
      if (rotation !== undefined) p.rotation = rotation;
      if (Object.prototype.hasOwnProperty.call(body, 'autoSwitch')) p.autoSwitch = body.autoSwitch !== false;
      if (body.minWaitMin != null) {
        p.minWaitMin = Math.min(600, Math.max(5, Math.round(Number(body.minWaitMin) || 60)));
      }
      if (body.reserveIndex != null) p.reserveIndex = Math.max(1, Math.round(Number(body.reserveIndex) || 1));
      if (!Number.isFinite(Number(p.minMinWait))) p.minMinWait = 5;
      if (!Number.isFinite(Number(p.maxMinWait))) p.maxMinWait = 600;
      pushLog(
        'GUARD',
        '保存策略：autoSwitch=' + (p.autoSwitch ? '开' : '关') + ' minWaitMin=' + p.minWaitMin + ' reserveIndex=' + p.reserveIndex,
        'mock',
      );
      normalize();
      return send(res, 200, { ok: true, message: '已保存', policy: p });
    }

    if (method === 'POST' && pathname === '/api/router') {
      const body = await readBody(req);
      const action = String(body.action || '');
      const r = state.router;
      let message;
      if (action === 'start') {
        r.running = true;
        r.pid = 9999;
        message = '路由已启动 · PID ' + r.pid + ' · 端口 ' + r.port;
      } else if (action === 'stop') {
        r.running = false;
        message = '路由已停止';
      } else if (action === 'restart') {
        r.running = true;
        r.pid = 9999;
        r.requests = (Number(r.requests) || 0) + 1;
        r.rotations = (Number(r.rotations) || 0) + 1;
        message = '路由已重启 · PID ' + r.pid + ' · 端口 ' + r.port;
      } else if (action === 'rebind') {
        message = '已把 Codex 配置改回本机路由（mock）';
      } else {
        return send(res, 400, { ok: false, error: '未知路由操作: ' + action });
      }
      r.lastError = '';
      r.lastErrorAt = null;
      r.errorRecovered = true;
      r.requestsSinceError = 0;
      r.updatedAt = Date.now();
      pushLog('ROUTER', message, 'mock');
      normalize();
      return send(res, 200, { ok: true, message, state: normalize() });
    }

    if (method === 'POST' && pathname === '/api/login') {
      pushLog('OK', '打开登录窗口（mock，不会启动真实登录流程）', 'mock');
      return send(res, 200, { ok: true, message: '已打开登录窗口（mock）' });
    }

    return send(res, 404, { ok: false, error: 'not found' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      const msg = (err && err.message) || String(err);
      try {
        send(res, 400, { ok: false, error: msg });
      } catch (e) {
        try {
          res.destroy();
        } catch (e2) {
          /* ignore */
        }
      }
    });
  });

  return { server, port, token, state, stats, normalize };
}

// ---------------------------------------------------------------- 启动

function start(options) {
  const app = createApp(options);
  return new Promise((resolve, reject) => {
    const onError = (err) => reject(err);
    app.server.once('error', onError);
    app.server.listen(app.port, '127.0.0.1', () => {
      app.server.removeListener('error', onError);
      app.server.on('error', (err) => console.error('MOCK ERROR ' + ((err && err.message) || err)));
      resolve(app);
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let patch = {};
  if (args.fixture) {
    try {
      patch = readFixtureFile(path.resolve(args.fixture));
    } catch (err) {
      console.error('MOCK FIXTURE WARN 读不到 --fixture，回退内置数据: ' + ((err && err.message) || err));
      patch = {};
    }
  }
  const app = await start({ port: args.port, patch });
  console.log('MOCK LISTENING ' + app.port);
  console.log('MOCK URL http://127.0.0.1:' + app.port + '/');
  // 直接开 URL 就行（index.html 里内联了同一个 token）；手搓 curl 时用这一行。
  console.log('MOCK TOKEN ' + app.token);
  console.log('MOCK PUBLIC ' + PUBLIC_DIR);
  const stop = () => {
    try {
      app.server.close(() => process.exit(0));
    } catch (err) {
      process.exit(0);
    }
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('MOCK ERROR ' + ((err && err.message) || err));
    if (err && err.code === 'EADDRINUSE') console.error('MOCK ERROR 端口被占用，换一个 --port');
    process.exit(1);
  });
}

module.exports = { createApp, start, mergeState, readFixtureFile, parseArgs, STATIC, DEFAULT_PORT };
