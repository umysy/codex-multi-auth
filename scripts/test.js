'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const files = fs.readdirSync(path.join(root, 'panel/test')).filter(f => f.endsWith('.test.js')).sort().map(f => path.join(root, 'panel/test', f));

// Tripwire: the suite must never touch this machine's real Codex setup. A test that
// spawned the panel with only CODEX_HOME redirected let the real CLI rebind and point
// ~/.codex/config.toml at a throwaway router (2026-10-29). Fail loudly if that recurs.
const home = process.env.USERPROFILE || os.homedir();
const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
const REAL_FILES = [
  path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'),
  path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Codex Multi Auth Runtime Router.cmd'),
];
function fingerprint(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; }
}
const before = REAL_FILES.map(fingerprint);

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit', cwd: root, env: { ...process.env, CMA_TEST_MODE: '1' } });
process.exitCode = result.status ?? 1;

const changed = REAL_FILES.filter((file, i) => fingerprint(file) !== before[i]);
if (changed.length) {
  // The running panel's binding guard can also write config.toml (e.g. the account
  // label) during a long run; re-run before blaming a test.
  console.error('\n✖ 测试改动了本机真实文件（测试必须重定向 CODEX_HOME、USERPROFILE、APPDATA）：\n  ' + changed.join('\n  '));
  process.exitCode = 1;
}
