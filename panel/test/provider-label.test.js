'use strict';
/**
 * Codex 侧栏底部显示的是 model_providers.<当前 provider>.name（应用不是 ChatGPT 登录时）。
 * 这里锁住：显示名跟随当前账号、只改 provider 段里的 name 一行、其它内容逐字节不变。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { providerLabel, applyProviderName, ensureProviderLabel } = require('../lib/binding-guard');
// 不写真实的 panel-events.log（测试进程用的是本机 CODEX_HOME 路径）
const quiet = () => {};

const CONFIG = [
  'model_provider = "codex-multi-auth-runtime-proxy"',
  'openai_base_url = "http://127.0.0.1:53742"',
  'model = "gpt-6.1-sol"',
  '',
  '[projects.\'D:\\work\\CodexMultiAuth\']',
  'trust_level = "trusted"',
  '',
  '[model_providers.other]',
  'name = "other"',
  '',
  '[model_providers.codex-multi-auth-runtime-proxy]',
  'name = "codex-multi-auth"',
  'base_url = "http://127.0.0.1:53742"',
  'requires_openai_auth = false',
  'experimental_bearer_token = "secret"',
  'http_headers = { "x-openai-actor-authorization" = "codex-multi-auth-local" }',
  'wire_api = "responses"',
  '',
].join('\r\n');

const ACCOUNTS = {
  ok: true,
  activeIndex: 1,
  accounts: [
    { index: 0, email: 'a@example.com' },
    { index: 1, email: 'b@example.com' },
  ],
};

test('providerLabel：当前账号序号 + 邮箱；没有账号时不给名字', () => {
  assert.strictEqual(providerLabel(ACCOUNTS), '账号2 · b@example.com');
  assert.strictEqual(providerLabel({ ok: true, activeIndex: 0, accounts: [{ index: 0, email: '' }] }), '账号1');
  assert.strictEqual(providerLabel({ ok: false, accounts: [] }), null);
  assert.strictEqual(providerLabel({ ok: true, activeIndex: 3, accounts: [{ index: 0, email: 'a@x' }] }), null);
});

test('applyProviderName：只改本工具 provider 段的 name，其它行逐字节不变', () => {
  const out = applyProviderName(CONFIG, '账号2 · b@example.com');
  const expected = CONFIG.replace('name = "codex-multi-auth"', 'name = "账号2 · b@example.com"');
  assert.strictEqual(out, expected);
  assert.match(out, /\[model_providers\.other\]\r\nname = "other"/, '别的 provider 不能被改');
  assert.strictEqual(applyProviderName(out, '账号2 · b@example.com'), out, '幂等');
  assert.strictEqual(applyProviderName(CONFIG, 'x"y\\z'), CONFIG.replace('name = "codex-multi-auth"', 'name = "x\\"y\\\\z"'), 'TOML 转义');
  const noSection = 'model = "x"\n';
  assert.strictEqual(applyProviderName(noSection, 'whatever'), noSection, '没有本工具的段就不动');
});

test('ensureProviderLabel：名字变了才写盘，写完再跑一次是 no-op', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-label-'));
  const cfg = path.join(dir, 'config.toml');
  try {
    fs.writeFileSync(cfg, CONFIG, 'utf8');
    const first = ensureProviderLabel({ force: true, log: quiet, configPath: cfg, accounts: ACCOUNTS });
    assert.strictEqual(first.changed, true, JSON.stringify(first));
    assert.match(fs.readFileSync(cfg, 'utf8'), /name = "账号2 · b@example\.com"/);
    const again = ensureProviderLabel({ force: true, log: quiet, configPath: cfg, accounts: ACCOUNTS });
    assert.strictEqual(again.changed, false);
    assert.strictEqual(again.reason, 'same');
    const switched = ensureProviderLabel({ force: true, log: quiet, configPath: cfg, accounts: Object.assign({}, ACCOUNTS, { activeIndex: 0 }) });
    assert.strictEqual(switched.changed, true);
    assert.match(fs.readFileSync(cfg, 'utf8'), /name = "账号1 · a@example\.com"/);
    assert.deepStrictEqual(fs.readdirSync(dir), ['config.toml'], '不留临时文件、不产生备份');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
