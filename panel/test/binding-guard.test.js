'use strict';
/**
 * app-bind 配置守卫的纯函数 + 端到端（临时目录）测试。
 *
 * 背景：app-login 中断会把真实 config.toml 留在临时 router 的端口/token 上，
 * Codex 于是 503。这里锁住「该修什么、只修那三行、不该动时装死」。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const guard = require('../lib/binding-guard');

// 测试不能碰本机：不写真实 panel-events.log，也不把编出来的 pid 交给 taskkill。
const quiet = () => {};
const killed = [];
const recordKill = async (pid) => { killed.push(pid); };

const BIND = {
  port: 53742,
  clientApiKey: 'test-client-key-not-a-real-secret-0000000000000000000000000000',
};

function configText(overrides) {
  const o = overrides || {};
  const top = o.topBase || 'http://127.0.0.1:53742';
  const base = o.base || 'http://127.0.0.1:53742';
  const token = o.token || BIND.clientApiKey;
  return [
    'model_provider = "codex-multi-auth-runtime-proxy"',
    'openai_base_url = "' + top + '"',
    'model = "gpt-6.1-sol"',
    '',
    '[desktop]',
    'appearanceTheme = "dark"',
    '',
    '[model_providers.codex-multi-auth-runtime-proxy]',
    'name = "codex-multi-auth"',
    'base_url = "' + base + '"',
    'requires_openai_auth = false',
    'experimental_bearer_token = "' + token + '"',
    'http_headers = { "x-openai-actor-authorization" = "codex-multi-auth-local" }',
    'wire_api = "responses"',
    '',
  ].join('\n');
}

test('needsProviderRepair：一致时不修，端口/token 不一致时指出原因', () => {
  assert.deepEqual(guard.needsProviderRepair(configText(), BIND), { needed: false, reason: 'ok' });
  assert.deepEqual(guard.needsProviderRepair(configText({ topBase: 'http://127.0.0.1:58932' }), BIND), { needed: true, reason: 'top-openai_base_url' });
  assert.deepEqual(guard.needsProviderRepair(configText({ base: 'http://127.0.0.1:58932' }), BIND), { needed: true, reason: 'provider-base_url' });
  assert.deepEqual(guard.needsProviderRepair(configText({ token: '010d0f60deadbeef' }), BIND), { needed: true, reason: 'provider-token' });
  assert.deepEqual(guard.needsProviderRepair('model = "x"\n', BIND), { needed: false, reason: 'no-provider-section' });
  assert.deepEqual(guard.needsProviderRepair(configText(), null), { needed: false, reason: 'no-bind' });
});

test('applyProviderRepair：只回写 base_url 与 token，其余内容保持不变', () => {
  const before = configText({ topBase: 'http://127.0.0.1:58932', base: 'http://127.0.0.1:58932', token: '010d0f60deadbeef' });
  const after = guard.applyProviderRepair(before, BIND);
  assert.match(after, /openai_base_url = "http:\/\/127\.0\.0\.1:53742"/);
  assert.match(after, /\[model_providers\.codex-multi-auth-runtime-proxy\][\s\S]*base_url = "http:\/\/127\.0\.0\.1:53742"/);
  assert.match(after, /experimental_bearer_token = "test-client-key-not-a-real-secret-0000000000000000000000000000"/);
  assert.doesNotMatch(after, /58932/);
  assert.doesNotMatch(after, /010d0f60deadbeef/);
  // 其它段原样保留
  assert.match(after, /\[desktop\][\s\S]*appearanceTheme = "dark"/);
  assert.match(after, /http_headers = \{ "x-openai-actor-authorization" = "codex-multi-auth-local" \}/);
  assert.equal(guard.needsProviderRepair(after, BIND).needed, false);
});

test('pickOrphanRouters：只挑临时 app-login home 上的 router', () => {
  const processes = [
    { pid: 9192, commandLine: '"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\codex-multi-auth\\scripts\\codex-app-router.js" --port 53742 --status "C:\\Users\\me\\.codex\\multi-auth\\app-bind\\runtime-rotation-app-bind-status.json"' },
    { pid: 24916, commandLine: '"node.exe" "codex-app-router.js" --port 0 --status "C:\\Users\\me\\AppData\\Local\\Temp\\cma-app-login-ftywHo\\multi-auth\\app-bind\\runtime-rotation-app-bind-status.json"' },
    { pid: 10712, commandLine: '"node.exe" "D:\\work\\CodexMultiAuth\\panel\\server.js"' },
    { pid: 4242, commandLine: '' },
  ];
  assert.deepEqual(guard.pickOrphanRouters(processes), [24916]);
  assert.deepEqual(guard.pickOrphanRouters(processes, 'cma-app-login-nope-'), []);
});

test('ensureProviderConfig：端口在监听时备份并回写；不在监听时不写', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-binding-guard-'));
  try {
    const bindFile = path.join(dir, 'runtime-rotation-app-bind.json');
    const cfgFile = path.join(dir, 'config.toml');
    fs.writeFileSync(bindFile, JSON.stringify({ port: 53742, clientApiKey: BIND.clientApiKey }), 'utf8');
    fs.writeFileSync(cfgFile, configText({ base: 'http://127.0.0.1:58932', token: 'deadbeef' }), 'utf8');

    const down = await guard.ensureProviderConfig({ bindPath: bindFile, configPath: cfgFile, listening: false, force: true, log: quiet });
    assert.equal(down.repaired, false);
    assert.equal(down.reason, 'bind-port-down');
    assert.equal(fs.readFileSync(cfgFile, 'utf8'), configText({ base: 'http://127.0.0.1:58932', token: 'deadbeef' }));

    const up = await guard.ensureProviderConfig({ bindPath: bindFile, configPath: cfgFile, listening: true, force: true, log: quiet });
    assert.equal(up.repaired, true);
    assert.ok(up.backup && fs.existsSync(up.backup), '必须留下备份文件');
    const after = fs.readFileSync(cfgFile, 'utf8');
    assert.doesNotMatch(after, /58932/);
    assert.match(after, /experimental_bearer_token = "test-client-key-not-a-real/);

    const again = await guard.ensureProviderConfig({ bindPath: bindFile, configPath: cfgFile, listening: true, force: true, log: quiet });
    assert.equal(again.repaired, false);
    assert.equal(again.reason, 'ok');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sweepOrphanRouters：临时 router 活着但超期/父进程已死时按泄漏清理', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-sweep-'));
  const home = path.join(tmpRoot, 'cma-app-login-TESTME');
  const bindDir = path.join(home, 'multi-auth', 'app-bind');
  fs.mkdirSync(bindDir, { recursive: true });
  const statusPath = path.join(bindDir, 'runtime-rotation-app-bind-status.json');
  fs.writeFileSync(statusPath, JSON.stringify({ pid: 111, running: true }), 'utf8');
  const nowMs = 1793100000000;
  const cmd = '"node.exe" "C:\\npm\\codex-multi-auth\\scripts\\codex-app-router.js" --port 0 --status "' + statusPath + '"';
  try {
    const r = await guard.sweepOrphanRouters({
      force: true,
      log: quiet,
      kill: recordKill,
      tmpRoot,
      nowMs,
      processes: [{ pid: 111, parentPid: 999, startedAtMs: nowMs - 20 * 60 * 1000, commandLine: cmd }],
    });
    assert.equal(r.killed, 1, '超期的临时 router 应被清理');
    assert.deepEqual(killed, [111], '只通过注入的 kill 处理，不调用真实 taskkill');
    assert.equal(fs.existsSync(home), false);
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});

test('sweepOrphanRouters：刚开始、父进程还活着的临时 router 不动', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-sweep2-'));
  const home = path.join(tmpRoot, 'cma-app-login-LIVEBIND');
  const bindDir = path.join(home, 'multi-auth', 'app-bind');
  fs.mkdirSync(bindDir, { recursive: true });
  const statusPath = path.join(bindDir, 'runtime-rotation-app-bind-status.json');
  fs.writeFileSync(statusPath, JSON.stringify({ pid: process.pid, running: true }), 'utf8');
  const nowMs = 1793100000000;
  const cmd = '"node.exe" "C:\\npm\\codex-multi-auth\\scripts\\codex-app-router.js" --port 0 --status "' + statusPath + '"';
  try {
    const r = await guard.sweepOrphanRouters({
      force: true,
      log: quiet,
      kill: recordKill,
      tmpRoot,
      nowMs,
      processes: [
        { pid: process.pid, parentPid: process.ppid, startedAtMs: nowMs - 60 * 1000, commandLine: cmd },
        { pid: process.ppid, parentPid: 1, startedAtMs: nowMs - 5 * 60 * 1000, commandLine: 'node.exe login' },
      ],
    });
    assert.equal(r.killed, 0, '进行中的 bind 不应被杀');
    assert.equal(fs.existsSync(home), true, '进行中的临时 home 不应被删');
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
});