'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const key = n => 'sha256:' + String(n).repeat(64);
let sandbox, data, scenarioFile, child, base, token;
const config = () => ({ version: 1, mode: 'daily-reserve', daily: [key(2), key(1)], reserve: [key(3)], dailySelection: 'priority', shortUsedPercent: 95, weeklyUsedPercent: 98, waitBeforeSwitchMin: 45, minGapSec: 120, returnToDaily: false, accountRules: { [key(1)]: { shortUsedPercent: 80, waitBeforeSwitchMin: 0 } } });
const scenario = () => ({ accountCount: 3, policy: [1, 2, 3].map(n => ({ accountKey: key(n) })), quota: [] });
const file = () => path.join(data, 'panel-config.json');
async function request(body, url = '/api/policy') {
  const r = await fetch(base + url, { method: 'POST', headers: { 'x-panel-token': token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
  return { status: r.status, body: await r.json() };
}
before(async () => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-rules-'));
  data = path.join(sandbox, 'home/multi-auth'); fs.mkdirSync(data, { recursive: true });
  scenarioFile = path.join(sandbox, 'scenario.json'); fs.writeFileSync(scenarioFile, JSON.stringify(scenario()));
  const fake = path.join(sandbox, 'appdata/npm/node_modules/codex-multi-auth/scripts/codex-multi-auth.js');
  fs.mkdirSync(path.dirname(fake), { recursive: true }); fs.copyFileSync(path.join(__dirname, 'fixtures/fake-cma.js'), fake);
  fs.writeFileSync(file(), JSON.stringify({ autoSwitch: false, minWaitMin: 120, reserveIndex: 3, allowFailover: false }));
  const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port; await new Promise(r => listener.close(r));
  base = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, [path.join(root, 'panel/server.js')], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, USERPROFILE: sandbox, APPDATA: path.join(sandbox, 'appdata'), CODEX_HOME: path.join(sandbox, 'home'), PANEL_PORT: String(port), CMA_SCENARIO: scenarioFile, CMA_CALLS: path.join(sandbox, 'calls.txt') } });
  for (let i = 0; i < 100; i++) {
    try { const page = await fetch(base); token = (await page.text()).match(/name="panel-token" content="([^"]+)"/)?.[1];
      if (token && !fs.existsSync(path.join(data, 'account-operations.lock'))) return;
    } catch { /* server booting */ }
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('isolated panel did not start');
});
after(async () => {
  if (child && child.exitCode === null) { const exited = new Promise(r => child.once('exit', r)); child.kill(); await exited; }
  if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true });
});

test('custom rule save returns all settings and preserves omitted base fields and unrelated configuration', async () => {
  const r = await request({ rotation: config() });
  assert.equal(r.status, 200); assert.deepEqual(r.body.policy.rotation, config());
  const saved = JSON.parse(fs.readFileSync(file()));
  assert.equal(saved.autoSwitch, false); assert.equal(saved.minWaitMin, 120); assert.equal(saved.allowFailover, false);
  assert.deepEqual(saved.rotation, config());
});

test('stale account bindings and invalid rules are rejected without replacing the saved configuration', async () => {
  const before = fs.readFileSync(file(), 'utf8');
  const incomplete = config(); incomplete.daily = [key(1)];
  let r = await request({ rotation: incomplete });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'ACCOUNT_POOL_CHANGED');
  r = await request({ rotation: { ...config(), shortUsedPercent: 101 } });
  assert.equal(r.status, 400); assert.equal(r.body.code, 'ROTATION_CONFIG_INVALID');
  assert.equal(fs.readFileSync(file(), 'utf8'), before);
});

test('a busy account operation and unavailable CLI leave existing rules intact', async () => {
  const before = fs.readFileSync(file(), 'utf8');
  const lock = path.join(data, 'account-operations.lock'); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() }));
  try { const r = await request({ rotation: config() }); assert.equal(r.status, 409); assert.equal(r.body.code, 'ACCOUNT_OPERATION_BUSY'); }
  finally { fs.unlinkSync(lock); }
  fs.writeFileSync(scenarioFile, JSON.stringify({ ...scenario(), failCommand: 'account policy list --json' }));
  try { const r = await request({ rotation: config() }); assert.equal(r.status, 503); assert.equal(r.body.code, 'ACCOUNT_POLICY_READ_FAILED'); }
  finally { fs.writeFileSync(scenarioFile, JSON.stringify(scenario())); }
  assert.equal(fs.readFileSync(file(), 'utf8'), before);
});

test('legacy role actions cannot conflict with custom roles, and explicit disable preserves base parameters', async () => {
  const r = await request({ n: 1, action: 'reserve' }, '/api/account');
  assert.equal(r.body.code, 'CUSTOM_ROLE_RULE_REQUIRED');
  const disabled = await request({ rotation: null }); assert.equal(disabled.status, 200);
  const saved = JSON.parse(fs.readFileSync(file()));
  assert.equal(saved.rotation, null); assert.equal(saved.autoSwitch, false); assert.equal(saved.minWaitMin, 120);
  assert.doesNotMatch(fs.readFileSync(path.join(sandbox, 'calls.txt'), 'utf8'), /emergency-only/);
});
