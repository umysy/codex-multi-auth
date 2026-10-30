'use strict';
/**
 * 依赖方向闸门（imports gate）
 *
 * 把 ARCHITECTURE「依赖方向只允许单向」从约定变成机械检查：
 *   1. 下层模块不许 require/import 上层模块（LEVEL 越大越靠上）；
 *   2. 后端（panel/lib、server、usage、policy-*）不许依赖前端（panel/public），反之亦然；
 *   3. 纯模块（policy-core、policy-config、format …）不得有任何内部依赖；
 *   4. 生产模块之间不得成环；
 *   5. 新模块必须登记进 LAYERS —— 否则闸门红，逼着改动者确认它属于哪一层；
 *   6. 相对路径依赖必须能解析到真实文件（顺手抓 typo）。
 *
 * 只扫描 panel/ 下的生产模块（测试、脚本、C#、静态资源不参与分层）。
 * 用法：node scripts/check-imports.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 分层表：level 越大越靠上；上层可以依赖下层，反之不行。 */
const LAYERS = [
  // ── 第 0 层：叶子（纯函数 / 无 IO 工具 / 无内部依赖）
  { level: 0, domain: 'backend', pure: true, files: ['panel/policy-core.js', 'panel/lib/live-quota.js', 'panel/lib/policy-config.js', 'panel/lib/paths.js', 'panel/lib/fs-json.js', 'panel/lib/state-cache.js', 'panel/lib/errors.js', 'panel/lib/protected-data.js'] },
  { level: 0, domain: 'public', pure: true, files: ['panel/public/modules/format.mjs', 'panel/public/modules/api.mjs'] },
  // ── 第 1 层：只依赖第 0 层的小工具
  { level: 1, domain: 'backend', files: ['panel/lib/cli.js', 'panel/lib/events.js', 'panel/lib/config-schema.js', 'panel/lib/policy-decision.js', 'panel/lib/usage/paths.js', 'panel/lib/panel-http.js', 'panel/lib/operation-lock.js', 'panel/lib/retention.js', 'panel/lib/app-auth.js', 'panel/lib/proxy-accounts.js', 'panel/lib/proxy.js'] },
  { level: 1, domain: 'public', files: ['panel/public/modules/dom.mjs', 'panel/public/modules/render-overview.mjs', 'panel/public/modules/render-accounts.mjs', 'panel/public/modules/render-panels.mjs', 'panel/public/modules/rotation-editor.mjs'] },
  // ── 第 2 层：单功能流程（登录/配置读写/账号动作/用量解析）
  { level: 1, domain: 'backend', files: ['panel/lib/error-journal.js'] },
  { level: 1, domain: 'backend', files: ['panel/lib/rotation-policy.js', 'panel/lib/runtime-health.js'] },
  { level: 2, domain: 'backend', files: ['panel/policy-cli.js', 'panel/lib/login-flow.js', 'panel/lib/binding-guard.js', 'panel/lib/policy-store.js', 'panel/lib/account-actions.js', 'panel/lib/usage/threads.js', 'panel/lib/usage/accounts.js', 'panel/lib/usage/ledger.js', 'panel/lib/usage/sessions.js', 'panel/lib/usage/buckets.js'] },
  { level: 2, domain: 'public', files: ['panel/public/modules/actions.mjs'] },
  // ── 第 3–6 层：后端读模型 / 用量入口 / 日志聚合
  { level: 3, domain: 'backend', files: ['panel/lib/usage/collect.js', 'panel/lib/router-control.js', 'panel/sync-label.js', 'panel/lib/safe-rebind.js'] },
  { level: 4, domain: 'backend', files: ['panel/lib/usage/index.js', 'panel/lib/watchdogs.js'] },
  { level: 5, domain: 'backend', files: ['panel/usage.js'] },
  { level: 6, domain: 'backend', files: ['panel/lib/usage-logs.js'] },
  { level: 7, domain: 'backend', files: ['panel/lib/diagnostics.js'] },
  { level: 7, domain: 'backend', files: ['panel/lib/dashboard.js'] },
  { level: 8, domain: 'backend', files: ['panel/lib/routes.js'] },
  { level: 9, domain: 'backend', files: ['panel/server.js'] },
  // ── 前端入口
  { level: 3, domain: 'public', files: ['panel/public/app.mjs'] },
];

const LEVEL_OF = new Map();
for (const layer of LAYERS) {
  for (const file of layer.files) {
    LEVEL_OF.set(file, { level: layer.level, domain: layer.domain, pure: layer.pure === true });
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'bin', 'obj', 'versions', 'cache', 'tmp', 'runtime-shadow-homes', 'app-bind', '.app-data', 'test', 'tests', 'app', 'desktop']);

function walk(root, dirRel, out) {
  const abs = path.join(root, dirRel);
  if (!fs.existsSync(abs)) return;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = dirRel + '/' + entry.name;
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(root, rel, out);
    } else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) {
      out.push(rel);
    }
  }
}

/** 生产模块清单：固定入口 + panel/lib + panel/public。 */
const FIXED_ENTRIES = ['panel/server.js', 'panel/usage.js', 'panel/policy-cli.js', 'panel/policy-core.js'];

function listSources(root = ROOT) {
  const files = FIXED_ENTRIES.filter((rel) => fs.existsSync(path.join(root, rel)));
  walk(root, 'panel/lib', files);
  walk(root, 'panel/public', files);
  return [...new Set(files)].sort();
}

const SPEC_RE = /(?:require\(\s*|import\s+(?:[^'"\n]*?\bfrom\s+)?|export\s+[^'"\n]*?\bfrom\s*)['"]([^'"\n]+)['"]/g;

/** 抽出所有相对依赖（内置/外部包返回空数组）。 */
function extractSpecs(text) {
  const specs = [];
  let match;
  SPEC_RE.lastIndex = 0;
  while ((match = SPEC_RE.exec(text)) !== null) {
    const spec = match[1];
    if (spec.startsWith('.')) specs.push(spec);
  }
  return [...new Set(specs)];
}

/** 相对 specifier → 仓库内相对路径（解析不到返回 null）。 */
function resolveSpec(root, fromRel, spec) {
  const base = path.resolve(root, path.dirname(fromRel), spec);
  const candidates = [base, base + '.js', base + '.mjs', path.join(base, 'index.js'), path.join(base, 'index.mjs')];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(root, candidate).split(path.sep).join('/');
    }
  }
  return null;
}

/** 单条依赖是否合法（供单元测试与主流程共用）。 */
function classify(fromFile, toFile) {
  const from = LEVEL_OF.get(fromFile);
  const to = LEVEL_OF.get(toFile);
  if (!from) return { ok: false, kind: 'unregistered-source', message: `${fromFile} 不在分层表里` };
  if (!to) {
    return { ok: false, kind: 'unregistered', message: `${fromFile} → ${toFile}：目标模块未登记（请加到 scripts/check-imports.js 的 LAYERS）` };
  }
  if (from.domain !== to.domain) {
    return { ok: false, kind: 'cross-domain', message: `${fromFile} → ${toFile}：后端与前端不得互相依赖（${from.domain} → ${to.domain}）` };
  }
  if (from.pure && to.level >= from.level) {
    return { ok: false, kind: 'pure', message: `${fromFile} → ${toFile}：纯模块不得依赖任何内部模块` };
  }
  if (to.level > from.level) {
    return { ok: false, kind: 'upward', message: `${fromFile} → ${toFile}：向上依赖（L${from.level} → L${to.level}），只允许上层依赖下层` };
  }
  return { ok: true };
}

/** Tarjan 强连通分量 → 有向环列表。 */
function findCycles(edges) {
  const graph = new Map();
  for (const [from, to] of edges) {
    if (!graph.has(from)) graph.set(from, []);
    graph.get(from).push(to);
    if (!graph.has(to)) graph.set(to, []);
  }
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const indices = new Map();
  const low = new Map();
  const cycles = [];

  function strongConnect(node) {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) || []) {
      if (!indices.has(next)) {
        strongConnect(next);
        low.set(node, Math.min(low.get(node), low.get(next)));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node), indices.get(next)));
      }
    }
    if (low.get(node) === indices.get(node)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      if (component.length > 1) cycles.push(component.reverse());
    }
  }

  for (const node of graph.keys()) {
    if (!indices.has(node)) strongConnect(node);
  }
  return cycles;
}

/** 扫描全仓库并返回结论（不打印、不退出，便于测试）。 */
function check(root = ROOT) {
  const modules = listSources(root);
  const edges = [];
  const problems = [];
  for (const file of modules) {
    if (!LEVEL_OF.has(file)) {
      problems.push({ kind: 'unregistered', file, message: `${file} 不在分层表里（新模块请登记 LAYERS）` });
    }
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    for (const spec of extractSpecs(text)) {
      const resolved = resolveSpec(root, file, spec);
      if (!resolved) {
        problems.push({ kind: 'unresolved', file, message: `${file}：无法解析相对依赖 "${spec}"` });
        continue;
      }
      edges.push([file, resolved]);
      const verdict = classify(file, resolved);
      if (!verdict.ok) problems.push({ kind: verdict.kind, file, to: resolved, message: verdict.message });
    }
  }
  for (const cycle of findCycles(edges)) {
    problems.push({ kind: 'cycle', message: '依赖成环：' + cycle.join(' → ') + ' → ' + cycle[0] });
  }
  return { modules: modules.length, edges: edges.length, problems };
}

function main() {
  const result = check();
  if (result.problems.length === 0) {
    console.log(`依赖方向检查：${result.modules} 个模块，${result.edges} 条内部依赖，0 个问题`);
    return;
  }
  for (const problem of result.problems) {
    console.log(`  ✗ ${problem.message}`);
  }
  console.log(`依赖方向检查：${result.modules} 个模块，${result.edges} 条内部依赖，${result.problems.length} 个问题`);
  console.log('提示：分层的唯一来源是 scripts/check-imports.js 的 LAYERS；新增模块时先想清它属于哪一层。');
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { LAYERS, LEVEL_OF, listSources, extractSpecs, resolveSpec, classify, findCycles, check };
