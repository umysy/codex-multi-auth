'use strict';
/**
 * 依赖方向闸门的单元测试。
 * 覆盖：真实仓库干净、向上依赖、跨端依赖、纯模块污染、新模块未登记、成环、路径解析、脚本退出码。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const gate = require(path.join(ROOT, 'scripts', 'check-imports.js'));

function makeFixture(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-imports-'));
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, 'utf8');
  }
  return root;
}

test('真实仓库的依赖图干净（0 个问题）', () => {
  const result = gate.check(ROOT);
  assert.deepStrictEqual(result.problems, []);
  assert.ok(result.modules >= 30, `模块数应 >= 30，实际 ${result.modules}`);
  assert.ok(result.edges >= 50, `内部依赖应 >= 50，实际 ${result.edges}`);
  for (const file of gate.listSources(ROOT)) {
    assert.ok(gate.LEVEL_OF.has(file), `${file} 未登记进 LAYERS`);
  }
});

test('允许上层依赖下层（routes → dashboard）', () => {
  assert.deepStrictEqual(gate.classify('panel/lib/routes.js', 'panel/lib/dashboard.js'), { ok: true });
});

test('拒绝下层依赖上层（dashboard → routes）', () => {
  const verdict = gate.classify('panel/lib/dashboard.js', 'panel/lib/routes.js');
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.kind, 'upward');
});

test('拒绝后端依赖前端', () => {
  const verdict = gate.classify('panel/server.js', 'panel/public/modules/api.mjs');
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.kind, 'cross-domain');
});

test('纯模块不得有任何内部依赖', () => {
  const verdict = gate.classify('panel/lib/policy-config.js', 'panel/policy-core.js');
  assert.strictEqual(verdict.ok, false);
  assert.strictEqual(verdict.kind, 'pure');
});

test('新模块未登记时临时项目直接报错', () => {
  const root = makeFixture({
    'panel/server.js': "require('./lib/brand-new')\n",
    'panel/lib/brand-new.js': 'module.exports = {}\n',
  });
  const result = gate.check(root);
  const kinds = result.problems.map((problem) => problem.kind);
  assert.ok(kinds.includes('unregistered'), `应报 unregistered，实际 ${kinds.join(',')}`);
});

test('临时项目能同时抓到向上依赖与成环', () => {
  const root = makeFixture({
    'panel/server.js': "require('./lib/routes')\n",
    'panel/lib/routes.js': "require('./dashboard')\n",
    'panel/lib/dashboard.js': "require('./routes')\n",
  });
  const result = gate.check(root);
  const kinds = result.problems.map((problem) => problem.kind);
  assert.ok(kinds.includes('upward'), `应报 upward，实际 ${kinds.join(',')}`);
  assert.ok(kinds.includes('cycle'), `应报 cycle，实际 ${kinds.join(',')}`);
});

test('环检测：有环返回环，无环返回空', () => {
  assert.deepStrictEqual(gate.findCycles([['a', 'b']]), []);
  const cycles = gate.findCycles([
    ['a', 'b'],
    ['b', 'c'],
    ['c', 'a'],
  ]);
  assert.strictEqual(cycles.length, 1);
  assert.deepStrictEqual(cycles[0].slice().sort(), ['a', 'b', 'c']);
});

test('解析相对依赖：省略扩展名、index、.. 都能落到真实文件', () => {
  assert.strictEqual(gate.resolveSpec(ROOT, 'panel/lib/routes.js', './dashboard'), 'panel/lib/dashboard.js');
  assert.strictEqual(gate.resolveSpec(ROOT, 'panel/lib/dashboard.js', './usage-logs'), 'panel/lib/usage-logs.js');
  assert.strictEqual(gate.resolveSpec(ROOT, 'panel/lib/usage-logs.js', '../usage.js'), 'panel/usage.js');
  assert.strictEqual(gate.resolveSpec(ROOT, 'panel/usage.js', './lib/usage'), 'panel/lib/usage/index.js');
  assert.strictEqual(gate.resolveSpec(ROOT, 'panel/lib/paths.js', './nope-not-here'), null);
});

test('闸门脚本端到端：真实仓库 exit 0 且报告 0 个问题', () => {
  const output = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'check-imports.js')], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.match(output, /0 个问题/);
});
