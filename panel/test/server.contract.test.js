'use strict';
/**
 * 后端契约测试：**启动真正的 panel/server.js**（不是 mock），验证对外契约没被改坏。
 *
 * 覆盖的是"改一处、客户端静默失效"的重灾区：
 *   - 页面里的 token 注入（前端靠它带鉴权头，注入格式一变全站 401）
 *   - /api/* 的鉴权、错误码、响应信封 { ok, state|logs|policy, error }
 *   - /api/policy 的字段名 + 钳位规则（前端和策略脚本都依赖这三个字段名）
 *   - 静态路由与 404 兜底
 *
 * 刻意不断言 /api/state 的内容：它依赖 codex-multi-auth CLI 与本机真实额度，
 * 在 CI/别人的机器上没有意义。这里只锁"稳定的契约层"。
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

let child = null;
let port = 0;
let token = '';
let codexHome = '';
let dataDir = '';
const stderrChunks = [];

function request(method, pathname, { headers = {}, body = null } = {}) {
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
    req.setTimeout(8000, () => req.destroy(new Error('request timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`server 提前退出 (code=${child.exitCode})\n${stderrChunks.join('')}`);
    }
    try {
      const res = await request('GET', '/');
      if (res.status === 200) return res;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`server 未在 ${timeoutMs}ms 内就绪: ${lastErr && lastErr.message}\n${stderrChunks.join('')}`);
}

function tokenFromIndex(html) {
  const m = html.match(/<meta\s+name="panel-token"\s+content="([^"]+)"/);
  return m ? m[1] : '';
}

before(async () => {
  // 用独立的 CODEX_HOME，绝不碰真实 ~/.codex
  codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-panel-test-'));
  dataDir = path.join(codexHome, 'multi-auth');
  fs.mkdirSync(dataDir, { recursive: true });

  for (let attempt = 0; attempt < 12 && !child; attempt++) {
    port = 20000 + Math.floor(Math.random() * 20000);
    const candidate = spawn(process.execPath, [SERVER], {
      cwd: ROOT,
      env: Object.assign({}, process.env, {
        CODEX_HOME: codexHome,
        // 只换 CODEX_HOME 不够：APPDATA 下是真实 CLI，USERPROFILE 下是真实路由启动项。
        // 真实 CLI 在空 CODEX_HOME 里会做首次绑定、起临时路由并改写真实 ~/.codex/config.toml。
        USERPROFILE: path.join(codexHome, 'home'),
        APPDATA: path.join(codexHome, 'appdata'),
        PANEL_PORT: String(port),
        // 防止测试机上有代理环境变量时 server 去连代理
        HTTP_PROXY: '',
        HTTPS_PROXY: '',
        http_proxy: '',
        https_proxy: '',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    candidate.stderr.on('data', (c) => stderrChunks.push(c.toString()));
    child = candidate;
    try {
      const res = await waitForServer();
      token = tokenFromIndex(res.text);
      assert.match(token, /^[0-9a-f]{36}$/, '首页必须注入 36 位十六进制 token');
      return;
    } catch (err) {
      try { candidate.kill(); } catch { /* ignore */ }
      child = null;
      stderrChunks.push(`\n[retry ${attempt}] ${err.message}`);
    }
  }
  throw new Error(`无法启动 server：\n${stderrChunks.join('')}`);
});

after(() => {
  if (child && child.exitCode === null) {
    try { child.kill(); } catch { /* ignore */ }
  }
  try { fs.rmSync(codexHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

const auth = () => ({ 'x-panel-token': token });

test('静态首页：200 + token 注入 + 引用的资源都存在', async () => {
  const res = await request('GET', '/');
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'] || '', /text\/html/);
  for (const asset of ['/app.mjs', '/modules/format.mjs', '/modules/actions.mjs', '/style.css', '/favicon.svg']) {
    const r = await request('GET', asset);
    assert.equal(r.status, 200, `${asset} 必须可访问（index.html / 模块 import 引用了它）`);
  }
});

test('鉴权：所有 /api/* 在缺少 token 时返回 401，且错误信封为 { ok:false, error }', async () => {
  const routes = [
    ['GET', '/api/state'],
    ['GET', '/api/usage'],
    ['GET', '/api/logs'],
    ['GET', '/api/diagnostics'],
    ['POST', '/api/refresh'],
    ['POST', '/api/account'],
    ['POST', '/api/policy'],
    ['POST', '/api/policy/preview'],
    ['POST', '/api/router'],
  ];
  for (const [method, route] of routes) {
    const res = await request(method, route, {});
    assert.equal(res.status, 401, `${method} ${route} 未鉴权时应为 401`);
    assert.equal(res.json && res.json.ok, false);
    assert.equal(typeof (res.json && res.json.error), 'string');
  }
  const wrong = await request('GET', '/api/logs', { headers: { 'x-panel-token': 'deadbeef'.repeat(5) } });
  assert.equal(wrong.status, 401, '错误 token 必须被拒绝');
});

test('Host / Origin 防护：非本机 Host 直接 403', async () => {
  const res = await request('GET', '/api/logs', { headers: Object.assign({ Host: 'evil.example.com' }, auth()) });
  assert.equal(res.status, 403);
  assert.equal(res.json.ok, false);
});

test('GET /api/logs：200 + { ok:true, logs: [] }', async () => {
  const res = await request('GET', '/api/logs', { headers: auth() });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.ok(Array.isArray(res.json.logs), 'logs 必须是数组（前端直接 forEach）');
});

test('GET /api/diagnostics：返回可分享脱敏快照，不含凭据或绝对路径', async () => {
  const res = await request('GET', '/api/diagnostics', { headers: auth() });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.diagnostics.privacy.redacted, true);
  assert.equal(res.json.diagnostics.privacy.credentialsIncluded, false);
  assert.equal(Object.prototype.hasOwnProperty.call(res.json.diagnostics, 'CODEX_HOME'), false);
});

test('POST /api/policy：字段名固定、越界值被钳位，落盘时保留 UI 不认识的字段', async () => {
  // 预置一份带脚本侧字段（allowFailover）与未知字段的配置，验证保存不会把它们抹掉。
  const cfgPath = path.join(dataDir, 'panel-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    autoSwitch: true, minWaitMin: 30, reserveIndex: 2, allowFailover: false, futureField: { keep: 1 },
  }, null, 2));

  const res = await request('POST', '/api/policy', {
    headers: auth(),
    body: { autoSwitch: false, minWaitMin: 99999, reserveIndex: 0 },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const p = res.json.policy;
  assert.deepEqual(Object.keys(p).sort(), ['autoSwitch', 'minWaitMin', 'reserveIndex'], '字段名是前端契约，不能改');
  assert.equal(p.autoSwitch, false);
  assert.equal(p.minWaitMin, 600, 'minWaitMin 上限 600');
  assert.equal(p.reserveIndex, 1, 'reserveIndex 下限 1');

  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  for (const key of Object.keys(p)) {
    assert.deepEqual(onDisk[key], p[key], `落盘字段 ${key} 必须与响应一致（策略脚本读同一份文件）`);
  }
  assert.deepEqual(Object.keys(onDisk).filter((k) => !(k in p)).sort(), ['allowFailover', 'futureField'],
    'UI 不认识的字段应原样保留，而不是被保存动作抹掉');
});

test('POST /api/policy/preview：干跑给出与策略脚本同源的决策，且不改配置', async () => {
  const cfgFile = path.join(dataDir, 'panel-config.json');
  const before = fs.readFileSync(cfgFile, 'utf8');
  const nowMs = Date.now();
  const quota = (used5, used7) => ({
    planType: 'plus',
    primary: { usedPercent: used5, windowMinutes: 300, resetAtMs: nowMs + 120 * 60000 },
    secondary: { usedPercent: used7, windowMinutes: 10080, resetAtMs: nowMs + 7000 * 60000 },
  });
  const res = await request('POST', '/api/policy/preview', {
    headers: auth(),
    body: {
      nowMs,
      activeIndex: 0,
      accountCount: 2,
      quotaByIndex: { 0: quota(40, 20), 1: quota(10, 5) },
      pausedIdx: [],
      policyPaused: [],
      autoSwitch: true,
      minWaitMin: 60,
      reserveIndex: 2,
      dryRun: true,
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  const d = res.json.decision;
  assert.equal(d.action, 'OK', '当前号有额度时应判 OK');
  assert.equal(d.details.curNo, 1);
  assert.equal(typeof d.reason, 'string');
  assert.equal(fs.readFileSync(cfgFile, 'utf8'), before, '试算不能写配置（它是只读接口）');
});

test('POST /api/account：非法账号序号返回 400（不会去调 CLI）', async () => {
  const res = await request('POST', '/api/account', { headers: auth(), body: { n: 0, action: 'pause' } });
  assert.equal(res.status, 400);
  assert.equal(res.json.ok, false);
});

test('未知路由返回 404 + 错误信封', async () => {
  const res = await request('GET', '/api/definitely-not-a-route', { headers: auth() });
  assert.equal(res.status, 404);
  assert.equal(res.json.ok, false);
});

test('响应头：不得缓存 API 响应（缓存会导致面板显示过期额度）', async () => {
  const res = await request('GET', '/api/logs', { headers: auth() });
  assert.match(res.headers['cache-control'] || '', /no-store/);
});
