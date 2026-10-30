'use strict';
// 配置 schema 单测：只跑纯函数与仓库示例文件，不联网、不 spawn。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  validateConfig,
  normalizePanelConfig,
  checkPanelConfig,
  checkDesktopConfig,
  checkAccountPolicies,
  DESKTOP_DEFAULTS,
} = require('../lib/config-schema');
const { readJsonResult, writeJson } = require('../lib/fs-json');

const repoRoot = path.resolve(__dirname, '..', '..');

function readExample(rel) {
  const text = fs.readFileSync(path.join(repoRoot, rel), 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

test('仓库里的三个配置示例都能通过 schema 校验', () => {
  const cases = [
    ['panel-config.example.json', 'panelConfig'],
    ['panel/desktop/app-config.example.json', 'desktopConfig'],
    ['account-policies.example.json', 'accountPolicies'],
  ];
  for (const [rel, schema] of cases) {
    const result = validateConfig(schema, readExample(rel));
    assert.equal(result.ok, true, `${rel} 应该通过校验：${result.errors.join('; ')}`);
  }
});

test('app-config 示例覆盖桌面端 AppConfig 的全部字段', () => {
  const desktop = readExample('panel/desktop/app-config.example.json');
  assert.deepEqual(Object.keys(desktop).sort(), Object.keys(DESKTOP_DEFAULTS).sort());
});

test('panel-config：类型/范围错误逐条指出字段路径', () => {
  const bad = { autoSwitch: 'yes', minWaitMin: 3, reserveIndex: 0, allowFailover: 1 };
  const result = checkPanelConfig(bad);
  assert.equal(result.ok, false);
  assert.equal(result.errors.length, 4);
  assert.ok(result.errors.some((e) => e.includes('panel-config.autoSwitch')));
  assert.ok(result.errors.some((e) => e.includes('panel-config.minWaitMin') && e.includes('[5, 600]')));
  assert.ok(result.errors.some((e) => e.includes('panel-config.reserveIndex') && e.includes('>= 1')));
  assert.ok(result.errors.some((e) => e.includes('panel-config.allowFailover')));
});

test('panel-config 归一化：钳位三项，同时保留 allowFailover（缺省 true）', () => {
  assert.deepEqual(normalizePanelConfig({}), { autoSwitch: true, minWaitMin: 60, reserveIndex: 1, allowFailover: true });
  assert.deepEqual(
    normalizePanelConfig({ autoSwitch: false, minWaitMin: 9999, reserveIndex: 0, allowFailover: false }),
    { autoSwitch: false, minWaitMin: 600, reserveIndex: 1, allowFailover: false });
  assert.deepEqual(
    normalizePanelConfig({ minWaitMin: 7.6, reserveIndex: 2.4 }),
    { autoSwitch: true, minWaitMin: 8, reserveIndex: 2, allowFailover: true });
});

test('app-config：Url 必须是本机回环，尺寸/坐标必须是整数', () => {
  const ok = checkDesktopConfig(readExample('panel/desktop/app-config.example.json'));
  assert.equal(ok.ok, true);

  const bad = checkDesktopConfig({ Url: 'http://example.com:8766/', Width: 100, X: 1.5, Maximized: 'no' });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.includes('app-config.Url')));
  assert.ok(bad.errors.some((e) => e.includes('app-config.Width')));
  assert.ok(bad.errors.some((e) => e.includes('app-config.X')));
  assert.ok(bad.errors.some((e) => e.includes('app-config.Maximized')));
});

test('account-policies：缺 accounts、条目缺 accountKey、flag 非布尔都会报错', () => {
  assert.equal(checkAccountPolicies({ accounts: {} }).ok, true);

  const missing = checkAccountPolicies({ version: 1 });
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some((e) => e.includes('accounts 缺失')));

  const badEntry = checkAccountPolicies({
    version: 1,
    accounts: {
      'sha256:abc': { tags: ['x', 3], weight: -1, paused: 'no' },
    },
  });
  assert.equal(badEntry.ok, false);
  assert.ok(badEntry.errors.some((e) => e.includes('.accountKey')));
  assert.ok(badEntry.errors.some((e) => e.includes('.tags')));
  assert.ok(badEntry.errors.some((e) => e.includes('.weight')));
  assert.ok(badEntry.errors.some((e) => e.includes('.paused')));
});

test('validateConfig：未知 schema 名返回明确错误而不是抛异常', () => {
  const result = validateConfig('nope', {});
  assert.equal(result.ok, false);
  assert.ok(result.errors[0].includes('未知 schema'));
});

test('JSON 配置写入使用临时文件替换，且能区分缺失与损坏', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'cma-json-'));
  const file = path.join(dir, 'config.json');
  try {
    assert.equal(readJsonResult(file).exists, false);
    fs.writeFileSync(file, '{"autoSwitch":', 'utf8');
    assert.equal(readJsonResult(file).exists, true);
    assert.equal(readJsonResult(file).ok, false);
    writeJson(file, { autoSwitch: false, minWaitMin: 60 });
    assert.deepEqual(readJsonResult(file).value, { autoSwitch: false, minWaitMin: 60 });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
