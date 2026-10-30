'use strict';
/**
 * e2e-mock.js — Codex 额度面板的无人值守 E2E 回归（mock 后端 + Edge headless + 真实鼠标事件）
 *
 * 与 panel/__e2e.js（真实环境 E2E）的区别
 *  - 后端是自己 spawn 的 tests/mock-server.js（127.0.0.1:8799，内存状态），
 *    不读不写 ~/.codex 里的真实账号，不碰生产 8766 / 调试口 9223；
 *  - 用 CDP Input.dispatchMouseEvent / Input.insertText 触发真实事件，
 *    坐标一律由 getBoundingClientRect 现算，再校验 elementFromPoint 命中，
 *    不复用会改真实账号的破坏性流程。
 *
 * 用法
 *  node tests/e2e-mock.js            # 全跑
 *  node tests/e2e-mock.js --verbose  # 额外打印每个断言的细节
 *
 * 退出码：0 = 全部通过；1 = 有断言失败（截图 tests/e2e-fail.png）；2 = 环境问题（端口被占用等）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const TESTS_DIR = __dirname;
const MOCK_SERVER = path.join(TESTS_DIR, 'mock-server.js');
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const MOCK_PORT = 8799;
const CDP_PORT = 9224;
const BASE = 'http://127.0.0.1:' + MOCK_PORT;
const CDP_BASE = 'http://127.0.0.1:' + CDP_PORT;
const PROFILE = path.join(os.tmpdir(), 'panel-e2e-mock-' + Date.now());
const FAIL_SHOT = path.join(TESTS_DIR, 'e2e-fail.png');
const VERBOSE = process.argv.includes('--verbose');
const EXPECTED = 14;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const R = { mock: null, mockLog: '', edge: null, cdp: null, token: '', done: false };

// ---------------------------------------------------------------- 进程清理

function psKillEdge(needle) {
  const script =
    'Get-CimInstance Win32_Process -Filter "Name=\'msedge.exe\'" | ' +
    "Where-Object { $_.CommandLine -like '*" + needle + "*' } | " +
    'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 30000,
    });
  } catch (err) {
    /* 清理尽力而为 */
  }
}

function taskkill(pid, tree) {
  if (!pid) return;
  try {
    const args = ['/PID', String(pid), '/F'].concat(tree ? ['/T'] : []);
    execFileSync('taskkill', args, { stdio: 'ignore', timeout: 20000 });
  } catch (err) {
    /* 已经退出 */
  }
}

function stopEdge() {
  const child = R.edge;
  R.edge = null;
  if (child && child.pid) taskkill(child.pid, true);
  psKillEdge('remote-debugging-port=' + CDP_PORT);
}

function stopMock() {
  const child = R.mock;
  R.mock = null;
  if (!child || !child.pid) return;
  try {
    child.kill();
  } catch (err) {
    /* ignore */
  }
  taskkill(child.pid, true);
}

function cleanup() {
  try {
    if (R.cdp) R.cdp.close();
  } catch (err) {
    /* ignore */
  }
  R.cdp = null;
  stopEdge();
  stopMock();
  try {
    if (fs.existsSync(PROFILE)) fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3 });
  } catch (err) {
    /* profile 目录偶尔被杀毒锁住，忽略 */
  }
}

process.on('exit', () => {
  if (R.done) return;
  R.done = true;
  cleanup();
});
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => {
    console.error('\n收到 ' + sig + '，正在清理…');
    cleanup();
    process.exit(130);
  });
}

// ---------------------------------------------------------------- CDP

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.badResponses = [];
    this.consoleErrors = [];
    ws.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
      } catch (err) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params && msg.params.exceptionDetails;
        const text = (d && (d.exception && (d.exception.description || d.exception.value)) || (d && d.text)) || 'unknown';
        this.exceptions.push(String(text));
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
        this.consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      } else if (msg.method === 'Log.entryAdded') {
        const en = msg.params && msg.params.entry;
        if (en && en.level === 'error') this.consoleErrors.push(en.text || '');
      } else if (msg.method === 'Network.responseReceived') {
        const r = msg.params && msg.params.response;
        if (r && r.status >= 400) this.badResponses.push(r.status + ' ' + String(r.url || '').slice(0, 120));
      }
    });
  }

  static connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch (err) {
          /* ignore */
        }
        reject(new Error('CDP WebSocket 连接超时'));
      }, 15000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new Cdp(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP WebSocket 连接失败'));
      });
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP 超时: ' + method));
        }
      }, 30000).unref();
    });
  }

  close() {
    try {
      this.ws.close();
    } catch (err) {
      /* ignore */
    }
  }
}

// ---------------------------------------------------------------- 页面操作

async function ev(cdp, expr) {
  const res = await cdp.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
  });
  if (res && res.exceptionDetails) {
    const d = res.exceptionDetails;
    throw new Error('页面脚本异常: ' + ((d.exception && d.exception.description) || d.text || 'unknown'));
  }
  return res && res.result ? res.result.value : undefined;
}

async function waitExpr(cdp, expr, label, timeout) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < (timeout || 20000)) {
    try {
      if (await ev(cdp, expr)) return true;
    } catch (err) {
      last = err;
    }
    await sleep(150);
  }
  throw new Error('等待超时: ' + label + (last ? ' :: ' + last.message.slice(0, 160) : ''));
}

const q = (sel) => JSON.stringify(sel);
const CARD = (i) => `([...document.querySelectorAll('#accounts .account')][${i}] || { innerText: '' }).innerText`;

/** 返回元素中心点与命中信息；元素不可见时回退到最近的 label/父节点（复选框是 display:none）。 */
async function pointOf(cdp, sel) {
  const expr = `(() => {
    const el = document.querySelector(${q(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    let node = el, r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) {
      const lab = el.closest('label') || el.parentElement;
      if (lab) { const r2 = lab.getBoundingClientRect(); if (r2.width >= 6 && r2.height >= 6) { node = lab; r = r2; } }
    }
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: Math.round(r.width), h: Math.round(r.height),
      hit: hit ? (hit.tagName + (hit.id ? '#' + hit.id : '')) : null,
      inside: !!hit && (node === hit || node.contains(hit)) };
  })()`;
  return ev(cdp, expr);
}

async function click(cdp, sel, label, tries) {
  const max = tries || 6;
  for (let i = 0; i < max; i++) {
    const p = await pointOf(cdp, sel);
    if (p && p.inside) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: p.x, y: p.y, button: 'left', buttons: 1, clickCount: 1,
      });
      await cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: p.x, y: p.y, button: 'left', buttons: 0, clickCount: 1,
      });
      if (VERBOSE) console.log('    click ' + (label || sel) + ' @ ' + p.x + ',' + p.y + ' hit=' + p.hit);
      return p;
    }
    await sleep(350); // 可能是 toast 挡住了，等它消失
  }
  const p = await pointOf(cdp, sel);
  throw new Error('点击被遮挡: ' + (label || sel) + ' :: ' + JSON.stringify(p));
}

/** 按比例点元素内部某个 x（range 滑块用）。 */
async function clickFraction(cdp, sel, frac, label) {
  const geo = await ev(cdp, `(() => {
    const el = document.querySelector(${q(sel)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, w: r.width, h: r.height };
  })()`);
  if (!geo) throw new Error('找不到元素 ' + sel);
  const x = Math.round(geo.left + geo.w * Math.min(0.97, Math.max(0.03, frac)));
  const y = Math.round(geo.top + geo.h / 2);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await cdp.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
  if (VERBOSE) console.log('    clickFraction ' + (label || sel) + ' @ ' + x + ',' + y + ' frac=' + frac.toFixed(3));
}

const KEY = {
  ArrowRight: 39,
  ArrowLeft: 37,
};

async function pressKey(cdp, key) {
  const vk = KEY[key] || 0;
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key, code: key, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
  });
}

async function typeInto(cdp, sel, text) {
  await click(cdp, sel, '输入框 ' + sel);
  await ev(cdp, `(() => { const t = document.querySelector(${q(sel)}); if (!t) throw new Error('no ' + ${q(sel)}); t.value = ''; t.focus(); return true; })()`);
  await cdp.send('Input.insertText', { text });
  const got = await ev(cdp, `(document.querySelector(${q(sel)}) || {}).value`);
  if (got !== text) throw new Error('输入未生效: 期望 "' + text + '" 实际 "' + got + '"');
}

async function waitIdle(cdp, label, timeout) {
  await sleep(120);
  await waitExpr(
    cdp,
    `(() => {
      const b = document.querySelector('#btn-refresh');
      const m = document.querySelector('#modal');
      return !!b && !b.disabled && !b.classList.contains('loading') && !!m && m.hidden;
    })()`,
    label,
    timeout || 20000,
  );
}

async function waitToast(cdp, re, label, timeout) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeout || 15000)) {
    const arr = (await ev(cdp, '(window.__toasts || [])')) || [];
    const hit = arr.find((t) => re.test(String(t)));
    if (hit) return String(hit);
    await sleep(120);
  }
  const arr = (await ev(cdp, '(window.__toasts || [])')) || [];
  throw new Error('未出现 toast ' + (label || re) + ' :: 已有 ' + JSON.stringify(arr).slice(0, 240));
}

/** 真实点击「确定」，返回模态里出现过的文案。 */
async function confirmModal(cdp, label) {
  await waitExpr(cdp, "!document.querySelector('#modal').hidden", (label || '') + ' 模态出现', 15000);
  const text = (await ev(cdp, "(document.querySelector('#modal-content') || {}).innerText || ''")) || '';
  await click(cdp, '#m-ok', (label || '') + ' 确定');
  await sleep(200);
  await waitExpr(cdp, "document.querySelector('#modal').hidden", (label || '') + ' 模态关闭', 15000).catch(() => {});
  return text;
}

// ---------------------------------------------------------------- mock HTTP

async function api(pathname, body) {
  const headers = { 'x-panel-token': R.token };
  const init = { headers, cache: 'no-store' };
  if (body !== undefined) {
    init.method = 'POST';
    init.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(BASE + pathname, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('mock API ' + pathname + ' HTTP ' + res.status + ' ' + JSON.stringify(data).slice(0, 200));
  return data;
}

const mockState = () => api('/api/state').then((j) => j.state);

async function waitMockState(pred, label, timeout) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < (timeout || 20000)) {
    last = await mockState();
    if (pred(last)) return last;
    await sleep(150);
  }
  const brief = last
    ? {
        accounts: (last.accounts || []).map((a) => [a.n, a.paused, a.current, a.note, a.role]),
        policy: last.policy,
        pinned: last.selection && last.selection.pinned,
        routerPid: last.router && last.router.pid,
        week: last.totals && last.totals.weekRemaining,
      }
    : null;
  throw new Error('等待 mock 状态超时: ' + label + ' :: ' + JSON.stringify(brief).slice(0, 320));
}

// ---------------------------------------------------------------- 断言框架

const results = [];
const failed = [];

async function check(name, fn) {
  let ok = false;
  let detail = '';
  try {
    const r = await fn();
    ok = !!(r && r.ok);
    detail = (r && r.detail) || '';
  } catch (err) {
    ok = false;
    detail = 'ERR ' + String((err && err.message) || err);
  }
  results.push({ name, ok, detail });
  if (!ok) failed.push(name);
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name + (detail ? '   [' + detail + ']' : ''));
  return ok;
}

// ---------------------------------------------------------------- 环境准备

function spawnMock() {
  const child = spawn(process.execPath, [MOCK_SERVER, '--port', String(MOCK_PORT)], {
    cwd: TESTS_DIR,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  R.mock = child;
  R.mockLog = '';
  const onData = (d) => {
    R.mockLog += String(d);
    if (R.mockLog.length > 8000) R.mockLog = R.mockLog.slice(-4000);
  };
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', onData);
  }
  if (child.stderr) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', onData);
  }
  child.on('exit', (code) => {
    if (code) console.error('mock 子进程退出 code=' + code + ' :: ' + R.mockLog.trim().slice(-600));
  });
  return child;
}

async function waitPort(url, timeout) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < (timeout || 20000)) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status === 204 || r.status === 401) return true;
      last = 'HTTP ' + r.status;
    } catch (err) {
      last = err.message;
    }
    await sleep(200);
  }
  throw new Error('端口未就绪 ' + url + ' :: ' + last);
}

async function readToken() {
  const res = await fetch(BASE + '/');
  if (!res.ok) throw new Error('mock 首页 HTTP ' + res.status);
  const html = await res.text();
  const m = html.match(/name="panel-token"\s+content="([^"]+)"/);
  if (!m) throw new Error('mock 首页没有 panel-token（注入失败）');
  if (m[1] === '__PANEL_TOKEN__') throw new Error('mock 首页 token 仍是占位符');
  return m[1];
}

async function launchEdge() {
  psKillEdge('remote-debugging-port=' + CDP_PORT);
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch (err) {
    /* ignore */
  }
  R.edge = spawn(
    EDGE,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--no-proxy-server',
      '--window-size=1500,1100',
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE,
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  R.edge.on('error', (err) => console.error('Edge 启动失败: ' + err.message));

  let target = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 30000 && !target) {
    try {
      const list = await (await fetch(CDP_BASE + '/json/list')).json();
      target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (err) {
      /* 还没起来 */
    }
    if (!target) await sleep(300);
  }
  if (!target) throw new Error('Edge CDP 未就绪: ' + CDP_BASE + '/json/list');
  return target.webSocketDebuggerUrl;
}

// ---------------------------------------------------------------- 主流程

async function main() {
  if (!fs.existsSync(EDGE)) throw Object.assign(new Error('找不到 Edge: ' + EDGE), { env: true });

  // 8799 上有别人的服务就不要掺和
  let occupied = false;
  try {
    const r = await fetch(BASE + '/', { signal: AbortSignal.timeout(900) });
    occupied = !!r;
  } catch (err) {
    occupied = false;
  }
  if (occupied) throw Object.assign(new Error('端口 ' + MOCK_PORT + ' 已被占用，先停掉占用进程再跑'), { env: true });

  console.log('== 启动 mock 后端 ==');
  spawnMock();
  await waitPort(BASE + '/');
  if (!/MOCK LISTENING/.test(R.mockLog)) {
    // 只是提示：端口已通即可，日志可能还没 flush
    if (VERBOSE) console.log('  (mock 还未打印 MOCK LISTENING)');
  }
  R.token = await readToken();
  console.log('mock 就绪 ' + BASE + '  token=' + R.token.slice(0, 6) + '…');

  // ---- mock 契约自检（不计入 14 条）
  console.log('\n-- mock 契约自检（不计入断言）--');
  const self = async (name, fn) => {
    try {
      const r = await fn();
      console.log((r.ok ? 'ok    ' : 'FAIL  ') + name + (r.detail ? '   [' + r.detail + ']' : ''));
      if (!r.ok) failed.push('[mock] ' + name);
    } catch (err) {
      console.log('FAIL  ' + name + '   [' + String((err && err.message) || err) + ']');
      failed.push('[mock] ' + name);
    }
  };
  await self('无 token 访问 /api/state 返回 401', async () => {
    const r = await fetch(BASE + '/api/state');
    return { ok: r.status === 401, detail: 'HTTP ' + r.status };
  });
  await self('错误 token 返回 401', async () => {
    const r = await fetch(BASE + '/api/state', { headers: { 'x-panel-token': 'deadbeef' } });
    return { ok: r.status === 401, detail: 'HTTP ' + r.status };
  });
  await self('POST /api/refresh 让 weekRemaining +1', async () => {
    const before = (await mockState()).totals.weekRemaining;
    await api('/api/refresh', {});
    const after = (await mockState()).totals.weekRemaining;
    return { ok: after === before + 1, detail: before + ' -> ' + after };
  });
  await self('POST /api/login 返回 mock 文案', async () => {
    const j = await api('/api/login', {});
    return { ok: /登录窗口（mock）/.test(j.message || ''), detail: j.message || '' };
  });

  // ---- 起浏览器
  console.log('\n== 启动 Edge headless（CDP ' + CDP_PORT + '）==');
  const wsUrl = await launchEdge();
  const cdp = await Cdp.connect(wsUrl);
  R.cdp = cdp;
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Network.enable');
  await cdp.send('Page.enable');
  await cdp.send('Page.navigate', { url: BASE + '/' });
  await waitExpr(
    cdp,
    "document.readyState === 'complete' && !!document.querySelector('#accounts') && !!document.querySelector('#btn-refresh')",
    '首屏加载',
    30000,
  );
  // 采集 toast 文案（与 __e2e.js 的 window.__toasts 约定一致）
  await ev(
    cdp,
    `(() => {
      window.__toasts = [];
      const box = document.getElementById('toasts');
      if (!box) return false;
      new MutationObserver((ms) => {
        for (const m of ms) for (const n of m.addedNodes) {
          if (n.nodeType === 1 && n.classList && n.classList.contains('toast')) window.__toasts.push(n.innerText);
        }
      }).observe(box, { childList: true });
      return true;
    })()`,
  );

  // 关掉「自动刷新」轮询（非断言项）：15s 一次 loadState(false) 会重渲染策略/路由面板，
  // 可能在「点滑块 → 点保存」之间把输入状态冲掉，让断言时序不确定。刷新按钮本身仍用真实点击验证（断言 4）。
  if (await ev(cdp, "!!document.querySelector('#auto-refresh') && document.querySelector('#auto-refresh').checked")) {
    await click(cdp, '#auto-refresh', '关闭自动刷新');
    await waitExpr(cdp, "document.querySelector('#auto-refresh').checked === false", '自动刷新已关闭', 8000);
  }

  console.log('\n== 14 条断言 ==');

  // 1 标题
  await check('1. 页面标题含 "Codex Quota"', async () => {
    const title = (await ev(cdp, 'document.title')) || '';
    return { ok: title.includes('Codex Quota'), detail: title };
  });

  // 2 三张卡 + 邮箱
  await check('2. 恰好 3 张账号卡，邮箱都是 example.com 占位地址', async () => {
    const emails = (await ev(cdp, "[...document.querySelectorAll('#accounts .account .acc-email')].map(e => e.textContent.trim())")) || [];
    const joined = emails.join(' | ').toLowerCase();
    return {
      ok: emails.length === 3 && joined.includes('example.com') && new Set(emails).size === 3,
      detail: emails.join(' / '),
    };
  });

  // 3 四个 KPI
  await check('3. 4 个 KPI 文本都非 "—"', async () => {
    const vals = (await ev(cdp, "[...document.querySelectorAll('#kpis .kpi-value')].map(e => e.textContent.trim())")) || [];
    return { ok: vals.length === 4 && vals.every((v) => v && v !== '—'), detail: vals.join(' , ') };
  });

  // 4 刷新额度（前端刷新 = GET /api/state?force=1，mock 视为 +1）
  await check('4. 点「刷新额度」后 weekRemaining 变化（mock +1）', async () => {
    const kpiVal = async () => Number.parseInt(await ev(cdp, "document.querySelector('#kpis .kpi-value').textContent"), 10);
    const beforeKpi = await kpiVal();
    const beforeMock = (await mockState()).totals.weekRemaining;
    await click(cdp, '#btn-refresh', '刷新额度');
    await waitMockState((s) => s.totals.weekRemaining === beforeMock + 1, '刷新后 mock weekRemaining +1');
    await waitIdle(cdp, '刷新完成');
    const afterKpi = await kpiVal();
    const afterMock = (await mockState()).totals.weekRemaining;
    return {
      ok: afterMock === beforeMock + 1 && afterKpi === beforeKpi + 1,
      detail: 'mock ' + beforeMock + '->' + afterMock + ' kpi ' + beforeKpi + '%->' + afterKpi + '%',
    };
  });

  // 5 暂停第 3 张卡
  await check('5. 第 3 张卡「暂停」→ 确认 → 卡片显示「已暂停」+ mock paused=true', async () => {
    const idx = 2;
    if (!(await ev(cdp, CARD(idx) + ".includes('暂停')"))) throw new Error('第 3 张卡没有「暂停」按钮文案');
    await click(cdp, `#accounts .account:nth-of-type(${idx + 1}) [data-act="pause"]`, '第 3 张卡 暂停');
    const modal = await confirmModal(cdp, '暂停确认');
    if (!/暂停/.test(modal)) throw new Error('确认模态文案不含「暂停」: ' + modal.slice(0, 120));
    await waitMockState((s) => s.accounts.find((a) => a.n === 3).paused === true, 'mock 账号3 paused=true');
    await waitIdle(cdp, '暂停完成');
    await waitExpr(cdp, CARD(idx) + ".includes('已暂停')", '卡片出现「已暂停」', 15000);
    return { ok: true, detail: modal.replace(/\s+/g, ' ').slice(0, 44) };
  });

  // 6 恢复
  await check('6. 点「恢复」→ 恢复使用（mock paused=false）', async () => {
    const idx = 2;
    await click(cdp, `#accounts .account:nth-of-type(${idx + 1}) [data-act="unpause"]`, '第 3 张卡 恢复使用');
    const modal = await confirmModal(cdp, '恢复确认');
    await waitMockState((s) => s.accounts.find((a) => a.n === 3).paused === false, 'mock 账号3 paused=false');
    await waitIdle(cdp, '恢复完成');
    await waitExpr(cdp, "!" + CARD(idx) + ".includes('已暂停')", '「已暂停」消失', 15000);
    const acts = await ev(cdp, `[...document.querySelectorAll('#accounts .account:nth-of-type(${idx + 1}) [data-act]')].map(b => b.dataset.act)`);
    return { ok: (acts || []).includes('pause'), detail: '恢复后按钮=' + JSON.stringify(acts) + ' 模态=' + modal.replace(/\s+/g, ' ').slice(0, 24) };
  });

  // 7 备注（中文输入）
  await check('7. 点「备注」→ 输入中文 → 保存 → 卡片显示备注 + mock note', async () => {
    const idx = 2;
    const NOTE = '测试备注';
    await click(cdp, `#accounts .account:nth-of-type(${idx + 1}) [data-act="note"]`, '第 3 张卡 备注');
    await waitExpr(cdp, "!document.querySelector('#modal').hidden && !!document.querySelector('#m-text')", '备注模态出现', 15000);
    await typeInto(cdp, '#m-text', NOTE);
    await click(cdp, '#m-ok', '备注 保存');
    await waitMockState((s) => s.accounts.find((a) => a.n === 3).note === NOTE, 'mock 账号3 note=' + NOTE);
    await waitIdle(cdp, '备注保存完成');
    await waitExpr(cdp, CARD(idx) + ".includes(" + q(NOTE) + ")", '卡片显示备注', 15000);
    const shown = await ev(cdp, `(document.querySelector('#accounts .account:nth-of-type(${idx + 1}) .drain') || {}).textContent || ''`);
    return { ok: String(shown).includes(NOTE), detail: '卡片备注="' + String(shown).trim().slice(0, 40) + '"' };
  });

  // 8 切换账号 3
  await check('8. 「切到此号」→ 风险确认 → 「使用中」移到第 3 张卡', async () => {
    const idx = 2;
    await click(cdp, `#accounts .account:nth-of-type(${idx + 1}) [data-act="switch"]`, '第 3 张卡 切到此号');
    const modal = await confirmModal(cdp, '切换确认');
    // 前端 switch 的风险提示文案：「把运行中的请求切到 xxx？正在跑的任务可能中断。」
    if (!/切到/.test(modal) || !/中断/.test(modal)) throw new Error('切换确认文案异常: ' + modal.slice(0, 140));
    await waitMockState((s) => s.accounts.find((a) => a.current).n === 3, 'mock current=3');
    await waitIdle(cdp, '切换完成');
    await waitExpr(cdp, CARD(idx) + ".includes('使用中')", '第 3 张卡出现「使用中」', 15000);
    await waitExpr(cdp, "!" + CARD(0) + ".includes('使用中')", '第 1 张卡不再是「使用中」', 15000);
    await waitToast(cdp, /切换到账号 3/, '切换成功 toast');
    const st = await mockState();
    return { ok: st.selection.pinned === 3, detail: 'pinned=' + st.selection.pinned + ' 模态=' + modal.replace(/\s+/g, ' ').slice(0, 30) };
  });

  // 9 切到账号 2（switch 会固定它）→ 点卡片上的「解除固定」
  await check('9. 再切到账号 2 + 点「解除固定」→ mock selection.pinned 清空', async () => {
    const idx = 1;
    await click(cdp, `#accounts .account:nth-of-type(${idx + 1}) [data-act="switch"]`, '第 2 张卡 切到此号');
    await confirmModal(cdp, '第二次切换确认');
    await waitMockState((s) => s.accounts.find((a) => a.current).n === 2 && s.selection.pinned === 2, 'mock current=2 pinned=2');
    await waitIdle(cdp, '第二次切换完成');
    await waitExpr(cdp, CARD(idx) + ".includes('使用中') && !" + CARD(2) + ".includes('使用中')", '「使用中」移到第 2 张卡', 15000);
    // switch 会固定账号（pinned=2），卡片上应出现「已固定 / 解除固定」
    await waitExpr(cdp, CARD(idx) + ".includes('已固定')", '第 2 张卡显示「已固定」', 15000);
    await click(cdp, `#accounts .account:nth-of-type(${idx + 1}) [data-act="unpin"]`, '第 2 张卡 解除固定');
    const modal = await confirmModal(cdp, '解除固定确认');
    if (!/解除/.test(modal) || !/503/.test(modal)) throw new Error('解除固定确认文案异常: ' + modal.slice(0, 140));
    await waitMockState((s) => s.selection.pinned === null, 'mock pinned=null');
    await waitIdle(cdp, '解除固定完成');
    const toast = await waitToast(cdp, /取消固定|解除/, '解除固定 toast');
    const st = await mockState();
    const stillCurrent = st.accounts.find((a) => a.current).n === 2;
    return {
      ok: st.selection.pinned === null && stillCurrent,
      detail: toast.replace(/\s+/g, ' ').slice(0, 60) + ' / pinned=' + String(st.selection.pinned),
    };
  });

  // 10 策略页：阈值滑块改成 65（真实点滑块 + 真实方向键微调）
  await check('10. 策略页阈值改为 65 并保存（mock policy.minWaitMin=65）', async () => {
    const readWait = () => ev(cdp, "Number(document.querySelector('#pol-wait').value)");
    const info = await ev(cdp, "(() => { const el = document.querySelector('#pol-wait'); return { value: Number(el.value), min: Number(el.min), max: Number(el.max) }; })()");
    const frac = (65 - info.min) / (info.max - info.min);
    // 真鼠标点在「65 对应的大致位置」，再用方向键 ±step 微调到恰好 65
    await clickFraction(cdp, '#pol-wait', frac, '策略阈值滑块');
    let v = await readWait();
    const presses = [];
    let mode = 'click+keys';
    for (let i = 0; i < 40 && v !== 65; i++) {
      const key = v < 65 ? 'ArrowRight' : 'ArrowLeft';
      await pressKey(cdp, key);
      presses.push(key === 'ArrowRight' ? '+' : '-');
      await sleep(45);
      const nv = await readWait();
      if (nv === v) {
        // 键盘没生效（焦点被丢/滑块没接住点击）：先补一次 focus，再不行才退回脚本赋值
        await ev(cdp, "document.querySelector('#pol-wait').focus()");
        await pressKey(cdp, key);
        await sleep(60);
        const nv2 = await readWait();
        if (nv2 === v) {
          mode = 'js-fallback';
          break;
        }
        v = nv2;
        continue;
      }
      v = nv;
    }
    if (v !== 65 && mode === 'js-fallback') {
      await ev(cdp, "(() => { const el = document.querySelector('#pol-wait'); el.value = '65'; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
      v = await readWait();
    }
    if (v !== 65) throw new Error('无法把滑块调到 65（当前 ' + v + '，初始 ' + info.value + '，按键 ' + presses.join('') + '，方式 ' + mode + '）');
    await click(cdp, '#btn-save-policy', '保存策略');
    await waitMockState((s) => s.policy.minWaitMin === 65, 'mock policy.minWaitMin=65');
    await waitToast(cdp, /策略已保存/, '策略保存 toast');
    await waitIdle(cdp, '策略保存完成');
    const st = await mockState();
    const shown = await readWait();
    return {
      ok: st.policy.minWaitMin === 65 && shown === 65,
      detail: 'mock=' + st.policy.minWaitMin + ' dom=' + shown + ' 初始=' + info.value + ' 方式=' + mode + ' 按键=' + (presses.join('') || '无'),
    };
  });

  // 11 策略页：自动切号 off -> on
  await check('11. 自动切号 off→on 并保存（mock policy.autoSwitch=true）', async () => {
    await waitExpr(cdp, "!!document.querySelector('#pol-auto')", '策略页渲染', 15000);
    const before = await ev(cdp, "document.querySelector('#pol-auto').checked");
    if (before !== false) throw new Error('自动切号初始应为 off，实际 ' + before);
    await click(cdp, '#pol-auto', '自动切号开关');
    const nowOn = await ev(cdp, "document.querySelector('#pol-auto').checked");
    if (nowOn !== true) throw new Error('点击后复选框没有变成 on');
    await click(cdp, '#btn-save-policy', '保存策略(自动切号)');
    await waitMockState((s) => s.policy.autoSwitch === true, 'mock policy.autoSwitch=true');
    await waitToast(cdp, /策略已保存/, '自动切号保存 toast');
    await waitIdle(cdp, '自动切号保存完成');
    const st = await mockState();
    return { ok: st.policy.autoSwitch === true, detail: 'off->on, minWaitMin=' + st.policy.minWaitMin };
  });

  // 12 路由页重启
  await check('12. 路由页「重启路由」→ toast 含「路由已重启 · PID 9999」', async () => {
    await click(cdp, '#router-actions [data-router="restart"]', '重启路由');
    const modal = await confirmModal(cdp, '重启路由确认');
    if (!/重启/.test(modal)) throw new Error('重启路由确认文案异常: ' + modal.slice(0, 120));
    const toast = await waitToast(cdp, /路由已重启 · PID 9999/, '重启路由 toast');
    await waitMockState((s) => s.router && s.router.pid === 9999, 'mock router.pid=9999');
    await waitIdle(cdp, '路由重启完成');
    return { ok: /端口 56014/.test(toast), detail: toast };
  });

  // 13 时间线
  await check('13. 事件时间线至少 5 条', async () => {
    const n = await ev(cdp, "document.querySelectorAll('#timeline .tl-row').length");
    const first = await ev(cdp, "((document.querySelector('#timeline .tl-row') || {}).innerText || '').replace(/\\s+/g, ' ').slice(0, 48)");
    return { ok: n >= 5, detail: n + ' 条 / 首行: ' + first };
  });

  // 14 无未捕获异常 / 无 4xx-5xx
  await check('14. 页面无未捕获 JS 异常且无 4xx/5xx 网络请求', async () => {
    await sleep(400); // 让最后一批事件落地
    const exc = cdp.exceptions.slice(0, 3);
    const bad = cdp.badResponses.slice(0, 5);
    const cerr = cdp.consoleErrors.slice(0, 3);
    return {
      ok: cdp.exceptions.length === 0 && cdp.badResponses.length === 0 && cdp.consoleErrors.length === 0,
      detail:
        'exceptions=' + cdp.exceptions.length + ' badResponses=' + cdp.badResponses.length + ' consoleErrors=' + cdp.consoleErrors.length +
        (exc.length ? ' :: ' + exc.join(' | ').slice(0, 200) : '') +
        (bad.length ? ' :: ' + bad.join(' | ').slice(0, 200) : '') +
        (cerr.length ? ' :: ' + cerr.join(' | ').slice(0, 200) : ''),
    };
  });

  return cdp;
}

// ---------------------------------------------------------------- 收尾

async function screenshot(cdp) {
  try {
    const res = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(FAIL_SHOT, Buffer.from(res.data, 'base64'));
    console.log('失败截图: ' + FAIL_SHOT);
    return true;
  } catch (err) {
    console.error('截图失败: ' + ((err && err.message) || err));
    return false;
  }
}

async function finish(cdp) {
  // 只截图一次：失败才写
  if (cdp && failed.length && !fs.existsSync(FAIL_SHOT)) await screenshot(cdp);
  if (cdp) {
    try {
      await cdp.send('Browser.close');
    } catch (err) {
      /* ignore */
    }
  }
}

(async () => {
  let cdp = null;
  let envError = null;
  const t0 = Date.now();
  try {
    cdp = await main();
  } catch (err) {
    if (err && err.env) envError = err;
    // CDP domain/target timeouts are host-browser setup failures. Keep them
    // distinct from product assertion failures so CI can report NOT_RUN.
    if (err && /CDP (超时|WebSocket|未就绪|连接)/.test(String(err.message || err))) {
      envError = err;
    }
    console.error('\nE2E 中断: ' + ((err && err.stack) || err));
    results.push({ name: 'E2E 流程未中断', ok: false, detail: String((err && err.message) || err).slice(0, 200) });
    failed.push('E2E 流程未中断');
  }

  const pass = results.filter((r) => r.ok).length;
  const total = results.length;

  console.log('\n========================================');
  if (cdp) {
    const exc = cdp.exceptions;
    const bad = cdp.badResponses;
    if (exc.length) console.log('捕获到的未处理异常: ' + exc.slice(0, 3).join(' | ').slice(0, 400));
    if (bad.length) console.log('捕获到的错误响应: ' + bad.slice(0, 5).join(' | ').slice(0, 400));
  }
  console.log('PASS ' + pass + '/' + total + (total === EXPECTED ? '' : ' （预期 ' + EXPECTED + ' 条，实际执行 ' + total + ' 条）'));
  if (failed.length) {
    console.log('失败明细:');
    for (const f of failed) console.log('  - ' + f);
  }
  console.log('耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
  console.log('========================================');

  await finish(cdp);
  const code = failed.length ? (envError ? 2 : 1) : 0;
  process.exitCode = code;

  // 必须显式收尾：mock 子进程句柄和 Edge 的 CDP WebSocket 都会把事件循环钉住，
  // 只挂 process.on('exit') 永远等不到 exit（实测会一直挂着不返回）。
  R.done = true;
  cleanup();
  console.log('收尾完成：Browser.close + Edge / mock 子进程已清理（exit ' + code + '）');
  // 正常情况句柄清空后自然退出；万一还有残留句柄，250ms 后强制退出。
  setTimeout(() => process.exit(code), 250).unref();
})();
