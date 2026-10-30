'use strict';
/**
 * scripts/sync-public.js：私有仓库 → 公开仓库快照。
 * 在临时目录里建两个 Git 仓库跑真实脚本；敏感值来自临时 CODEX_HOME，不读真实 ~/.codex。
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'sync-public.js');
const FAKE_KEY = 'ab'.repeat(32);

function repo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'test'); g('config', 'user.email', 'test@example.com'); g('config', 'core.autocrlf', 'false');
  return g;
}

function write(dir, file, text) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), text);
}

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-sync-'));
  const src = path.join(root, 'private');
  const dst = path.join(root, 'public');
  const home = path.join(root, 'codex');
  const gs = repo(src);
  write(src, 'README.md', '# panel\n');
  write(src, 'docs/使用说明.txt', '说明\n');
  write(src, '.audit/log.tsv', 'internal\n');
  gs('add', '-A'); gs('commit', '-q', '-m', 'init');
  const gd = repo(dst);
  write(dst, 'stale.txt', 'old\n');
  gd('add', '-A'); gd('commit', '-q', '-m', 'old');
  write(home, 'multi-auth/app-bind/runtime-rotation-app-bind.json', JSON.stringify({ clientApiKey: FAKE_KEY, identityToken: 'cd'.repeat(24) }));
  return { root, src, dst, home, gs };
}

function run(s) {
  return spawnSync(process.execPath, [SCRIPT, s.dst], { cwd: s.src, encoding: 'utf8', env: Object.assign({}, process.env, { CODEX_HOME: s.home }) });
}

test('同步：写入 HEAD 的文件，中文文件名不乱码，跳过 .audit，删除公开仓库里的旧文件', () => {
  const s = sandbox();
  try {
    const r = run(s);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(fs.readFileSync(path.join(s.dst, 'README.md'), 'utf8'), '# panel\n');
    assert.equal(fs.readFileSync(path.join(s.dst, 'docs', '使用说明.txt'), 'utf8'), '说明\n');
    assert.equal(fs.existsSync(path.join(s.dst, '.audit')), false, '.audit 不能进公开仓库');
    assert.equal(fs.existsSync(path.join(s.dst, 'stale.txt')), false, '源仓库没有的文件要删掉');
    assert.ok(!r.stdout.includes(FAKE_KEY));
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('文件里出现本机真实 key 时失败（退出码 2），且输出不含 key 本身', () => {
  const s = sandbox();
  try {
    write(s.src, 'panel/test/fixture.js', 'const key = "' + FAKE_KEY + '";\n');
    s.gs('add', '-A'); s.gs('commit', '-q', '-m', 'leak');
    const r = run(s);
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.match(r.stderr, /fixture\.js：路由 clientApiKey/);
    assert.ok(!(r.stderr + r.stdout).includes(FAKE_KEY));
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('私有仓库有未提交改动时拒绝同步', () => {
  const s = sandbox();
  try {
    write(s.src, 'README.md', '# changed\n');
    const r = run(s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /未提交/);
    assert.equal(fs.existsSync(path.join(s.dst, 'README.md')), false, '拒绝时不写目标');
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});

test('目标把私有仓库加成 remote 时拒绝', () => {
  const s = sandbox();
  try {
    execFileSync('git', ['remote', 'add', 'origin', s.src], { cwd: s.dst });
    const r = run(s);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /remote/);
  } finally { fs.rmSync(s.root, { recursive: true, force: true }); }
});
