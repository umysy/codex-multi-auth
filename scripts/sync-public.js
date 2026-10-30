'use strict';
/**
 * 把私有开发仓库的 HEAD 同步到公开仓库的工作区，并用本机真实敏感值逐个比对。
 *
 *   node scripts/sync-public.js <公开仓库的本地目录>
 *
 * 公开仓库是独立的 Git 仓库，只收快照、不共享历史（见 docs/PUBLISH_CHECKLIST.md）。
 * 这个脚本只写目标工作区，不提交、不推送；提交前还要在目标目录跑 npm run verify。
 *
 * 退出码：0 成功；1 参数或仓库状态不对；2 在写出的文件里发现了本机敏感值（目标工作区保留现场供检查）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

/** 不进公开仓库的路径前缀（内部决策记录）。 */
const EXCLUDE = ['.audit/'];

function git(cwd, args, opts) {
  return execFileSync('git', args, Object.assign({ cwd, maxBuffer: 1 << 30 }, opts || {}));
}

function fail(code, msg) { console.error('sync-public: ' + msg); process.exit(code); }

/** 源仓库 HEAD 的文件清单（-z：中文文件名不经转义，避免 tar 那类解码错乱）。 */
function sourceFiles(src) {
  const out = git(src, ['ls-tree', '-r', '-z', '--full-tree', 'HEAD']).toString('utf8');
  return out.split('\0').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    const [mode, type, sha] = line.slice(0, tab).split(' ');
    return { mode, type, sha, file: line.slice(tab + 1) };
  }).filter((e) => e.type === 'blob' && !EXCLUDE.some((p) => e.file.startsWith(p)));
}

/** 本机真实敏感值：只用于比对，从不打印值本身。 */
function localSecrets(env) {
  const codexHome = env.CODEX_HOME || path.join(env.USERPROFILE || os.homedir(), '.codex');
  const data = path.join(codexHome, 'multi-auth');
  const secrets = [];
  const add = (label, value) => { if (typeof value === 'string' && value.length >= 8) secrets.push({ label, value }); };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const bindFiles = [path.join(data, 'app-bind', 'runtime-rotation-app-bind.json')];
  try {
    for (const v of fs.readdirSync(path.join(data, 'versions'))) bindFiles.push(path.join(data, 'versions', v, 'app-bind', 'runtime-rotation-app-bind.json'));
  } catch { /* 没有备份目录 */ }
  for (const f of bindFiles) {
    const b = readJson(f);
    if (b) { add('路由 clientApiKey', b.clientApiKey); add('路由 identityToken', b.identityToken); }
  }
  const acc = readJson(path.join(data, 'openai-codex-accounts.json'));
  ((acc && acc.accounts) || []).forEach((a, i) => {
    for (const k of ['accessToken', 'refreshToken', 'idToken', 'accountId', 'email', 'organizationId', 'userId']) add('账号' + (i + 1) + ' ' + k, a[k]);
  });
  const lq = readJson(path.join(data, 'live-quota.json'));
  Object.keys((lq && lq.byAccountId) || {}).forEach((id, i) => add('账号 id ' + (i + 1), id));
  const auth = readJson(path.join(codexHome, 'auth.json'));
  if (auth) {
    for (const [k, v] of Object.entries(auth.tokens || {})) add('Codex 登录 ' + k, v);
    add('Codex 登录 OPENAI_API_KEY', auth.OPENAI_API_KEY);
  }
  // 同一个值只比一次
  const seen = new Set();
  return secrets.filter((s) => (seen.has(s.value) ? false : (seen.add(s.value), true)));
}

/** 通用形态：JWT、sk- key、40 位以上的随机十六进制（排除 sha256: 指纹和全同字符占位）。 */
const PATTERNS = [
  ['JWT', /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./g],
  ['sk- key', /\bsk-[A-Za-z0-9]{20,}/g],
  ['长随机十六进制', /(?<!sha256:)\b[0-9a-f]{40,}\b/gi],
];

function scan(target, files, secrets) {
  const findings = [];
  for (const f of files) {
    const text = fs.readFileSync(path.join(target, f), 'latin1');
    for (const s of secrets) if (text.includes(s.value)) findings.push(f + '：' + s.label);
    for (const [name, re] of PATTERNS) {
      for (const m of text.match(re) || []) if (!/^(.)\1+$/.test(m)) { findings.push(f + '：' + name); break; }
    }
  }
  return findings;
}

function main(argv, env) {
  const target = argv[0] ? path.resolve(argv[0]) : '';
  if (!target) fail(1, '用法：node scripts/sync-public.js <公开仓库的本地目录>');
  const src = git(process.cwd(), ['rev-parse', '--show-toplevel']).toString().trim();
  if (path.resolve(src) === target) fail(1, '目标不能是私有仓库本身');
  if (!fs.existsSync(path.join(target, '.git'))) fail(1, '目标不是 Git 仓库：' + target + '（先 git init 或 clone 公开仓库）');
  if (git(src, ['status', '--porcelain', '--untracked-files=no']).toString().trim()) fail(1, '私有仓库有未提交的改动；先提交，保证同步的是确定的版本');
  const real = (p) => { try { return fs.realpathSync.native(path.resolve(p)).toLowerCase(); } catch { return null; } };
  const srcReal = real(src);
  const urls = git(target, ['remote', '-v']).toString().split(/\r?\n/).map((l) => l.split(/\s+/)[1]).filter(Boolean);
  if (urls.some((u) => real(u.replace(/^file:\/\/\/?/, '')) === srcReal)) fail(1, '目标仓库把私有仓库加成了 remote，请先移除');

  const head = git(src, ['rev-parse', '--short', 'HEAD']).toString().trim();
  const files = sourceFiles(src);
  const keep = new Set(files.map((e) => e.file));
  // 删掉公开仓库里已不在源仓库的文件
  const existing = git(target, ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  let removed = 0;
  for (const f of existing) if (!keep.has(f)) { fs.rmSync(path.join(target, f), { force: true }); removed += 1; }
  for (const e of files) {
    const dst = path.join(target, e.file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, git(src, ['cat-file', 'blob', e.sha]));
  }
  console.log('已同步 ' + files.length + ' 个文件（删除 ' + removed + ' 个，跳过 ' + EXCLUDE.join(', ') + '）自私有 ' + head);

  const secrets = localSecrets(env);
  const findings = scan(target, files.map((e) => e.file), secrets);
  console.log('敏感值比对：本机 ' + secrets.length + ' 个真实值 + ' + PATTERNS.length + ' 种通用形态');
  if (findings.length) {
    console.error('发现敏感内容，不要提交：');
    for (const f of findings) console.error('  - ' + f);
    process.exit(2);
  }
  console.log('通过。下一步：在 ' + target + ' 运行 npm run verify，然后提交 "Sync from private ' + head + '"。');
}

if (require.main === module) main(process.argv.slice(2), process.env);

module.exports = { sourceFiles, localSecrets, scan, EXCLUDE };
