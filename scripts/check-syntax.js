'use strict';
/**
 * 语法闸门：仓库里每个 .js / .mjs 都要能通过 `node --check`。
 * 防止"改一处语法错误 → 面板直接白屏"这类低级崩溃进入主干。
 * `.mjs` 是浏览器端 ES 模块（panel/public/modules/*），Node 原生按 ESM 解析。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_ANY = new Set(['.git', 'node_modules', 'bin', 'obj']);
const SKIP_ROOT = new Set(['versions', 'usage', 'cache', 'tmp', 'runtime-shadow-homes', 'app-bind']);
function skip(full) {
  const rel = path.relative(ROOT, full);
  const segs = rel.split(/[\\/]/);
  if (segs.some((x) => SKIP_ANY.has(x))) return true;
  return SKIP_ROOT.has(segs[0]);
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (skip(full)) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const files = walk(ROOT).sort();
const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    const detail = String((err.stderr && err.stderr.toString()) || err.message).trim();
    failures.push({ file: path.relative(ROOT, file), detail });
  }
}

for (const f of failures) {
  console.error(`[语法错误] ${f.file}\n${f.detail}\n`);
}
console.log(`语法检查：${files.length} 个 .js/.mjs，${failures.length} 个失败`);
process.exit(failures.length === 0 ? 0 : 1);
