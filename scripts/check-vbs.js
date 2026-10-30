#!/usr/bin/env node
// 启动器 .vbs 语法闸门。
//
// 背景：.vbs 的编码对了（UTF-16LE+BOM）不代表能跑。引号多一个，cscript 立刻报
// "Unterminated string constant"，而计划任务只会留下一个退出码 1，很容易被当成
// "策略没跑" 去查别处。2026-10-25 部署时就踩过这个坑（路径脱敏后多了一个引号）。
//
// 做法：把 .vbs 复制到临时文件，把所有 `sh.Run` / `MsgBox` 语句替换成
// `WScript.Echo`，再交给 cscript 编译。这样只验证语法，不会真的启动进程或弹窗。
// 语法错误 → 退出码 1；运行期错误（如 CI 上没有 node.exe）不算失败。
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'bin', 'obj', 'versions', 'usage', 'cache', 'tmp',
  'runtime-shadow-homes', 'app-bind', '.app-data',
]);

function listVbs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listVbs(full, out);
    else if (entry.name.toLowerCase().endsWith('.vbs')) out.push(full);
  }
  return out;
}

// 只保留语法：去掉会真正执行动作/弹窗的语句。
function sanitize(text) {
  return text
    .split(/\r?\n/)
    .map((line) =>
      /\.Run\b/.test(line) || /^\s*MsgBox\b/i.test(line)
        ? "WScript.Echo \"[syntax-only]\""
        : line,
    )
    .join('\r\n');
}

function checkOne(file) {
  const raw = fs.readFileSync(file);
  const text =
    raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe
      ? raw.subarray(2).toString('utf16le')
      : raw.toString('utf8').replace(/^\uFEFF/, '');
  const safe = sanitize(text);
  const tmp = path.join(
    os.tmpdir(),
    `vbs-syntax-${process.pid}-${Math.random().toString(16).slice(2)}.vbs`,
  );
  // 临时文件仍写成 UTF-16LE+BOM：和真实启动器的编码保持一致。
  fs.writeFileSync(tmp, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(safe, 'utf16le')]));
  try {
    const r = spawnSync('cscript', ['//nologo', tmp], { encoding: 'utf8', timeout: 30000 });
    if (r.error) return { ok: false, message: `无法运行 cscript: ${r.error.message}` };
    const output = `${r.stdout || ''}${r.stderr || ''}`;
    const compileError = output.match(/Microsoft VBScript compilation error[^\r\n]*/i);
    if (compileError) {
      const location = output.split(/\r?\n/).find((l) => /\.vbs\(\d+/.test(l)) || '';
      return { ok: false, message: `${compileError[0]} ${location.trim()}`.trim() };
    }
    return { ok: true };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* 临时文件清理失败不影响结论 */ }
  }
}

function main() {
  const files = listVbs(ROOT);
  let failed = 0;
  for (const file of files) {
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    const r = checkOne(file);
    if (r.ok) {
      console.log(`ok   ${rel}`);
    } else {
      failed += 1;
      console.error(`FAIL ${rel}\n     ${r.message}`);
    }
  }
  console.log(`启动器语法检查：${files.length} 个 .vbs，${failed} 个失败`);
  return failed === 0 ? 0 : 1;
}

process.exitCode = main();
