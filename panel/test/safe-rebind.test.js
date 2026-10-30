'use strict';
/**
 * 「重新绑定桌面版」回归测试：重新绑定只能改 Codex 配置里指向本机路由的四行，
 * 不得碰其它设置、启动项、app-bind、账号或策略文件，也不得再调用 CLI 的 bind-app。
 * 全部在临时目录里跑，不读写真实 ~/.codex，也不碰正在运行的路由。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { planRebind, safeRebind } = require('../lib/safe-rebind');

const KEY = 'a1'.repeat(32); // 64 位十六进制假值
const STALE_KEY = '1'.repeat(64);
const BIND = { port: 53742, clientApiKey: KEY, identityToken: 'f'.repeat(48), host: '127.0.0.1' };
const PROVIDER = 'codex-multi-auth-runtime-proxy';

/** 贴近真实结构的 config：顶层两行、其它段里也有 base_url / *_BASE_URL，provider 段在后面。 */
function config({ port = 56014, key = STALE_KEY, eol = '\n', topProvider = PROVIDER, withTopBase = true, withToken = true, withProvider = true } = {}) {
  const lines = [
    'model_provider = "' + topProvider + '"  # 本机路由',
    ...(withTopBase ? ['openai_base_url = "http://127.0.0.1:' + port + '"'] : []),
    'model = "gpt-6.1-sol"',
    'model_reasoning_effort = "high"',
    '',
    '[desktop]',
    'theme = "dark"',
    '',
    '[shell_environment_policy.set]',
    'ANTHROPIC_BASE_URL = "https://api.example.invalid/anthropic"',
    '',
    '[model_providers.other]',
    'name = "other"',
    'base_url = "http://127.0.0.1:9999"',
    'experimental_bearer_token = "' + '2'.repeat(64) + '"',
    '',
    "[projects.'D:\\work\\CodexMultiAuth']",
    'trust_level = "trusted"',
    '',
  ];
  if (withProvider) {
    lines.push(
      '[model_providers.' + PROVIDER + ']',
      'name = "账号2 · someone@example.com"',
      'base_url = "http://127.0.0.1:' + port + '"',
      'requires_openai_auth = false',
      ...(withToken ? ['experimental_bearer_token = "' + key + '" # router key'] : []),
      'http_headers = { "x-openai-actor-authorization" = "codex-multi-auth-local" }',
      'wire_api = "responses"',
      '',
    );
  }
  return lines.join(eol);
}

function changedLines(a, b) {
  const x = a.split(/\r?\n/), y = b.split(/\r?\n/);
  assert.equal(x.length, y.length, '行数必须不变');
  return x.map((l, i) => (l !== y[i] ? i : -1)).filter((i) => i >= 0).map((i) => y[i]);
}

test('只改四行：顶层 model_provider / openai_base_url 与 provider 段 base_url / token，其余字节不变', () => {
  const before = config({ topProvider: 'openai' });
  const plan = planRebind(before, BIND);
  assert.equal(plan.ok, true);
  assert.equal(plan.changed, true);
  assert.deepEqual(changedLines(before, plan.next), [
    'model_provider = "' + PROVIDER + '"  # 本机路由',
    'openai_base_url = "http://127.0.0.1:53742"',
    'base_url = "http://127.0.0.1:53742"',
    'experimental_bearer_token = "' + KEY + '" # router key',
  ]);
  assert.deepEqual(plan.fields.sort(), ['base_url', 'experimental_bearer_token', 'model_provider', 'openai_base_url']);
  // 其它段里的同名键不受影响
  assert.match(plan.next, /\[model_providers\.other\]\nname = "other"\nbase_url = "http:\/\/127\.0\.0\.1:9999"\nexperimental_bearer_token = "2{64}"/);
  assert.match(plan.next, /ANTHROPIC_BASE_URL = "https:\/\/api\.example\.invalid\/anthropic"/);
  assert.match(plan.next, /name = "账号2 · someone@example\.com"/, 'provider 显示名不动');
});

test('保留 CRLF 换行与文件结尾', () => {
  const before = config({ eol: '\r\n' });
  const plan = planRebind(before, BIND);
  assert.equal(plan.ok, true);
  assert.equal(plan.next.split('\r\n').length, before.split('\r\n').length);
  assert.ok(!/[^\r]\n/.test(plan.next), '不能混入 LF');
  assert.equal(plan.next.endsWith('\r\n'), before.endsWith('\r\n'));
});

test('已经一致时不改动', () => {
  const plan = planRebind(config({ port: 53742, key: KEY }), BIND);
  assert.equal(plan.ok, true);
  assert.equal(plan.changed, false);
});

test('没有顶层 openai_base_url 时不插入新行', () => {
  const before = config({ withTopBase: false });
  const plan = planRebind(before, BIND);
  assert.equal(plan.ok, true);
  assert.ok(!/openai_base_url/.test(plan.next));
  assert.equal(changedLines(before, plan.next).length, 2);
});

test('provider 段被整段删掉（bind-app --native 之后的样子）时拒绝，不补写', () => {
  const plan = planRebind(config({ withProvider: false }), BIND);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'REBIND_NO_PROVIDER');
  assert.match(plan.message, /手动恢复/);
});

test('配置里有 CLI 原生模式块时拒绝', () => {
  const native = '# codex-multi-auth native provider begin\nmodel_provider = "openai"\nopenai_base_url = "http://127.0.0.1:53742"\n# codex-multi-auth native provider end\n' + config();
  const plan = planRebind(native, BIND);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, 'REBIND_NATIVE_BLOCK');
});

test('缺 token 行或缺顶层 model_provider 时拒绝', () => {
  assert.equal(planRebind(config({ withToken: false }), BIND).code, 'REBIND_MISSING_LINE');
  const noTop = config().split('\n').slice(1).join('\n');
  assert.equal(planRebind(noTop, BIND).code, 'REBIND_MISSING_LINE');
});

test('provider 段重复时拒绝', () => {
  const dup = config() + '\n[model_providers.' + PROVIDER + ']\nbase_url = "http://127.0.0.1:1"\n';
  assert.equal(planRebind(dup, BIND).code, 'REBIND_DUPLICATE');
});

test('app-bind 不完整时拒绝（端口或密钥不合格）', () => {
  for (const bad of [null, {}, { port: 0, clientApiKey: KEY }, { port: 53742, clientApiKey: '' }, { port: 53742, clientApiKey: 'short' }]) {
    assert.equal(planRebind(config(), bad).code, 'REBIND_NO_BIND');
  }
});

test('任何返回消息都不含密钥', () => {
  const cases = [config(), config({ withProvider: false }), config({ withToken: false }), config({ port: 53742, key: KEY })];
  for (const c of cases) {
    const plan = planRebind(c, BIND);
    assert.ok(!JSON.stringify(Object.assign({}, plan, { next: undefined })).includes(KEY));
    assert.ok(!JSON.stringify(Object.assign({}, plan, { next: undefined })).includes(STALE_KEY));
  }
});

/* ---------------------------------------------------------------- 落盘 */

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-rebind-'));
  const files = {
    config: path.join(dir, 'config.toml'),
    bind: path.join(dir, 'app-bind', 'runtime-rotation-app-bind.json'),
    startup: path.join(dir, 'Startup', 'Codex Multi Auth Runtime Router.cmd'),
    accounts: path.join(dir, 'openai-codex-accounts.json'),
    policy: path.join(dir, 'quota-policy.json'),
  };
  for (const f of Object.values(files)) fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(files.config, config());
  fs.writeFileSync(files.bind, JSON.stringify(BIND, null, 2) + '\n');
  fs.writeFileSync(files.startup, '@echo off\r\nset "HTTPS_PROXY=http://127.0.0.1:7897"\r\n"node.exe" router.js --port 53742\r\n');
  fs.writeFileSync(files.accounts, JSON.stringify({ accounts: [{ index: 0 }, { index: 1 }] }));
  fs.writeFileSync(files.policy, JSON.stringify({ autoSwitch: true }));
  return { dir, files };
}

const hash = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const logs = [];
const deps = (s, extra) => Object.assign({ bindPath: s.files.bind, configPath: s.files.config, log: (m) => logs.push(m) }, extra);

test('路由没在监听时拒绝，配置原样不动', async () => {
  const s = sandbox();
  try {
    const before = hash(s.files.config);
    const r = await safeRebind(deps(s, { listening: false }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'REBIND_ROUTER_DOWN');
    assert.match(r.message, /重启路由/);
    assert.equal(hash(s.files.config), before);
    assert.equal(fs.readdirSync(s.dir).filter((n) => n.includes('.bak-')).length, 0, '拒绝时不留备份');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('重新绑定：先备份，只改四行；app-bind、启动项、账号、策略文件一个字节都不变；再点一次不改', async () => {
  const s = sandbox();
  try {
    const original = fs.readFileSync(s.files.config, 'utf8');
    const untouched = ['bind', 'startup', 'accounts', 'policy'].map((k) => [k, hash(s.files[k])]);
    const r = await safeRebind(deps(s, { listening: true }));
    assert.equal(r.ok, true, r.message);
    assert.equal(r.changed, true);
    assert.ok(!r.message.includes(KEY) && !r.message.includes(STALE_KEY), '消息里不能出现密钥');
    assert.match(r.message, /重新打开 Codex/);
    const backups = fs.readdirSync(s.dir).filter((n) => n.startsWith('config.toml.bak-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(s.dir, backups[0]), 'utf8'), original, '备份是改之前的原文');
    assert.equal(changedLines(original, fs.readFileSync(s.files.config, 'utf8')).length, 3, '端口两处 + token 一处');
    for (const [k, h] of untouched) assert.equal(hash(s.files[k]), h, k + ' 不应被改动');
    assert.equal(fs.readdirSync(s.dir).filter((n) => n.endsWith('-tmp')).length, 0, '不留临时文件');
    assert.ok(logs.some((m) => /端口 53742/.test(m)) && logs.every((m) => !m.includes(KEY)));

    const again = await safeRebind(deps(s, { listening: true }));
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(fs.readdirSync(s.dir).filter((n) => n.startsWith('config.toml.bak-')).length, 1, '无改动时不再备份');
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

test('provider 段缺失时 safeRebind 拒绝且不写盘', async () => {
  const s = sandbox();
  try {
    fs.writeFileSync(s.files.config, config({ withProvider: false }));
    const before = hash(s.files.config);
    const r = await safeRebind(deps(s, { listening: true }));
    assert.equal(r.code, 'REBIND_NO_PROVIDER');
    assert.equal(hash(s.files.config), before);
  } finally { fs.rmSync(s.dir, { recursive: true, force: true }); }
});

/* ---------------------------------------------------------- 结构性防线 */

test('面板代码里不再有任何地方调用 CLI 的 bind-app / unbind-app', () => {
  const root = path.resolve(__dirname, '..');
  const hits = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'bin', 'obj', 'test', 'tests'].includes(e.name)) walk(p); continue; }
      if (!/\.(js|mjs|cs|ps1|html)$/.test(e.name)) continue;
      const text = fs.readFileSync(p, 'utf8');
      // 字符串字面量里出现命令名才算调用；注释里提到它不算。
      if (/['"`](?:un)?bind-app['"`]/.test(text)) hits.push(path.relative(root, p));
    }
  };
  walk(root);
  assert.deepEqual(hits, [], '这些文件把 bind-app / unbind-app 当命令参数用了：' + hits.join(', '));
});
