'use strict';
/**
 * 账号操作稳健性回归测试（对应“恢复账号按钮报错”）。
 *
 * 背景：线上出现过 POST /api/account 等 25 秒后失败、面板只显示“账号操作失败”的情况。
 * 这里用假 CLI 覆盖三层保障：
 *   1. CLI 超时后自动重试一次并成功；
 *   2. 两次都超时时，失败原因可读（而不是固定的“账号操作失败”）；
 *   3. 普通非超时失败不重试；
 *   4. CLI 的 stdin 必须被关闭，否则等待输入的 CLI 会挂到超时（spawn 'ignore'）。
 */
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const FAKE_SOURCE = `'use strict';
const fs = require('fs');
const marker = process.env.FAKE_CMA_MARKER || '';
const mode = process.env.FAKE_CMA_MODE || 'ok';
const args = process.argv.slice(2);
let count = 0;
try { count = Number(fs.readFileSync(marker + '.count', 'utf8')) || 0; } catch { count = 0; }
try { fs.writeFileSync(marker + '.count', String(count + 1)); } catch { /* ignore */ }
try { fs.appendFileSync(marker, args.join(' ') + '\\n'); } catch { /* ignore */ }
if (mode.startsWith('reserve-')) {
  let policy = { index: 2, emergencyOnly: false, paused: false };
  try { policy = JSON.parse(fs.readFileSync(marker + '.policy', 'utf8')); } catch {}
  if (args[1] === 'policy') {
    process.stdout.write(JSON.stringify({ accounts: [policy] }));
    process.exit(0);
  }
  if (args[1] === 'pause' || (mode === 'reserve-rollback-fail' && args[3] === 'off')) {
    process.stderr.write('simulated write failure');
    process.exit(1);
  }
  if (args[1] === 'emergency-only') policy.emergencyOnly = args[3] === 'on';
  if (args[1] === 'unpause') policy.paused = false;
  fs.writeFileSync(marker + '.policy', JSON.stringify(policy));
  process.stdout.write('Updated');
  process.exit(0);
}
if (mode === 'hang-first' && count === 0) {
  setInterval(() => {}, 1000);
} else if (mode === 'hang-always') {
  setInterval(() => {}, 1000);
} else if (mode === 'exit-1') {
  process.stderr.write('fake cli failure\\n');
  process.exit(1);
} else if (mode === 'stdin-wait') {
  process.stdout.write('stdin check\\n');
  process.stdin.on('data', () => {});
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
} else {
  process.stdout.write('Updated account ' + (args[2] || '') + ': ' + (args[1] || 'ok') + '.\\n');
}
`;

const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-acct-actions-'));
const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-acct-home-'));
const marker = path.join(appData, 'fake-calls.log');
const fakeDir = path.join(appData, 'npm', 'node_modules', 'codex-multi-auth', 'scripts');
fs.mkdirSync(fakeDir, { recursive: true });
fs.writeFileSync(path.join(fakeDir, 'codex-multi-auth.js'), FAKE_SOURCE);

// paths.CLI 在 require 时由 APPDATA 决定；务必先改 env 再加载被测模块。
process.env.APPDATA = appData;
process.env.CODEX_HOME = codexHome;
process.env.FAKE_CMA_MARKER = marker;
process.env.PANEL_ACCOUNT_ACTION_TIMEOUT_MS = '700';
process.env.PANEL_ACCOUNT_ACTION_RETRY_DELAY_MS = '100';

const { runAccountAction } = require('../lib/account-actions');

after(() => {
  fs.rmSync(appData, { recursive: true, force: true });
  fs.rmSync(codexHome, { recursive: true, force: true });
});

function reset() {
  try { fs.unlinkSync(marker); } catch { /* ignore */ }
  try { fs.unlinkSync(marker + '.count'); } catch { /* ignore */ }
  try { fs.unlinkSync(marker + '.policy'); } catch { /* ignore */ }
}

function calls() {
  try { return fs.readFileSync(marker, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; }
}

test('第一次超时后自动重试一次并成功', async () => {
  reset();
  process.env.FAKE_CMA_MODE = 'hang-first';
  const r = await runAccountAction(2, 'unpause');
  assert.equal(r.ok, true);
  assert.match(r.out, /Updated account 2: unpause\./);
  assert.deepEqual(calls(), ['account unpause 2', 'account unpause 2']);
});

test('两次都超时返回可读失败原因', async () => {
  reset();
  process.env.FAKE_CMA_MODE = 'hang-always';
  const r = await runAccountAction(3, 'pause');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'CLI_TIMEOUT');
  assert.match(r.error, /重试一次仍超时/);
  assert.equal(calls().length, 2);
});

test('普通非超时失败不重试', async () => {
  reset();
  process.env.FAKE_CMA_MODE = 'exit-1';
  const r = await runAccountAction(4, 'pause');
  assert.equal(r.ok, false);
  assert.equal(r.code, 1);
  assert.equal(calls().length, 1);
});

test('CLI stdin 被关闭，等待输入的 CLI 不会挂起', async () => {
  reset();
  process.env.FAKE_CMA_MODE = 'stdin-wait';
  const started = Date.now();
  const r = await runAccountAction(2, 'unpause');
  const elapsed = Date.now() - started;
  assert.equal(r.ok, true, 'CLI 被挂起：' + (r.error || r.out));
  assert.ok(elapsed < 5000, 'stdin 未关闭导致挂起，耗时 ' + elapsed + 'ms');
});

test('备用号配套暂停失败会恢复并读回原状态，同时失效缓存', async () => {
  reset();
  process.env.FAKE_CMA_MODE = 'reserve-pause-fail';
  const cache = require('../lib/state-cache').cache;
  const generation = cache.generation;
  const result = await runAccountAction(2, 'reserve');
  assert.equal(result.code, 'ACCOUNT_ACTION_ROLLED_BACK');
  assert.equal(result.ok, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(marker + '.policy', 'utf8')), {index: 2, emergencyOnly: false, paused: false});
  assert.ok(cache.generation > generation);
});

test('备用号恢复失败保留部分失败错误，不能提示恢复成功', async () => {
  reset();
  process.env.FAKE_CMA_MODE = 'reserve-rollback-fail';
  const result = await runAccountAction(2, 'reserve');
  assert.equal(result.code, 'ACCOUNT_ACTION_PARTIAL');
  assert.equal(result.ok, false);
  assert.match(result.error, /未确认/);
});
