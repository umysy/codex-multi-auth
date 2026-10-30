'use strict';
/**
 * 决策核心的回归网：直接用 fixture 里冻结的输入跑 panel/policy-cli.js，
 * 断言动作、目标账号、干跑标记。fixture 由 parity 场景生成（见 docs/ARCHITECTURE.md
 * "决策只有一份"），改规则时必须同步改 fixture，否则这里会失败。
 *
 * 运行：node --test panel/test/policy-cli.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const CLI = path.join(ROOT, 'panel', 'policy-cli.js');
const FIXTURE = path.join(__dirname, 'fixtures', 'policy-decisions.json');

const fixture = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

function runCli(mode, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cli-test-'));
  try {
    const inFile = path.join(dir, 'in.json');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(inFile, JSON.stringify(payload), 'utf8');
    const res = spawnSync(process.execPath, [CLI, mode, '--in', inFile, '--out', outFile], { encoding: 'utf8' });
    return { res, dir, outFile };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

function runOk(mode, payload) {
  const { res, dir, outFile } = runCli(mode, payload);
  try {
    assert.strictEqual(res.status, 0, 'CLI 应成功退出：' + (res.stderr || '').trim());
    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, ''));
    assert.strictEqual(parsed.ok, true, '信封应是 ok:true');
    return parsed;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

for (const c of fixture.cases) {
  test('decide：' + c.id + ' → ' + c.expect.action, () => {
    const got = runOk('decide', c.input);
    const d = got.decision;
    assert.strictEqual(d.action, c.expect.action, c.desc);
    assert.strictEqual(d.targetIndex, c.expect.targetIndex, 'targetIndex');
    if (c.expect.dryRun) assert.strictEqual(d.details.dryRun, true, 'DryRun 必须只出决策、不执行');
    // reason 可含多行（先 LIMIT 解释、再动作行），与 PS1 写日志的格式一致；末行必须是动作文案
    const lines = d.reason.split('\n').map((s) => s.trim()).filter(Boolean);
    assert.ok(lines.length > 0, 'reason 不能为空');
    const last = lines[lines.length - 1];
    if (c.expect.dryRun) {
      // 普通切号文案是 "DRYRUN 将切换…"，储备号回切文案是 "SWITCH 储备号用毕…"（都由 PS1 统一映射成 DRYRUN 状态）
      assert.ok(last.startsWith('DRYRUN') || last.startsWith('SWITCH'), '干跑文案应以 DRYRUN/SWITCH 开头：' + last);
    } else {
      assert.ok(last.startsWith(d.action), '末行应以动作名开头：' + last);
    }
    assert.ok(d.details && typeof d.details === 'object', '必须带 details 供 PS/UI 使用');
  });
}

for (const c of fixture.configCases) {
  test('normalize-config：' + c.id, () => {
    const got = runOk('normalize-config', c.input);
    for (const [k, v] of Object.entries(c.expect)) {
      assert.strictEqual(got.policy[k], v, k);
    }
  });
}

test('缺少 nowMs 时返回 ERROR 决策而不是抛异常', () => {
  const got = runOk('decide', { accountCount: 1, activeIndex: 0 });
  assert.strictEqual(got.decision.action, 'ERROR');
});

test('--in 文件不存在时退出码 2 且带错误信封', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cli-test-'));
  try {
    const outFile = path.join(dir, 'out.json');
    const res = spawnSync(process.execPath, [CLI, 'decide', '--in', path.join(dir, 'missing.json'), '--out', outFile], { encoding: 'utf8' });
    assert.strictEqual(res.status, 2);
    // 指定了 --out 时错误信封写进文件（PS1 也是这么读的），stdout 不看
    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8'));
    assert.strictEqual(parsed.ok, false);
    assert.ok(typeof parsed.error === 'string' && parsed.error.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('输入不是合法 JSON 时退出码 2', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-cli-test-'));
  try {
    const inFile = path.join(dir, 'bad.json');
    fs.writeFileSync(inFile, '{not json', 'utf8');
    const res = spawnSync(process.execPath, [CLI, 'decide', '--in', inFile], { encoding: 'utf8' });
    assert.strictEqual(res.status, 2);
    assert.strictEqual(JSON.parse(res.stdout).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
