'use strict';
/**
 * 面板调用 codex-multi-auth CLI 的白名单：rotation（bind-app / unbind-app / enable / disable /
 * reset-runtime）和 uninstall 会改写 Codex 配置或路由启动项，面板任何入口都不能触发。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

// paths 在 require 时定型：先把数据目录指到临时目录，拒绝时写的错误日志不落到真实 ~/.codex。
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-cli-allow-'));
process.env.CODEX_HOME = sandbox;
process.env.APPDATA = path.join(sandbox, 'appdata');

const { test, after } = require('node:test');
const assert = require('node:assert');
const { runCli, ALLOWED_SUBCOMMANDS } = require('../lib/cli');

after(() => { try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ } });

test('会改写 Codex 配置的子命令被拒绝，且不启动进程', async () => {
  const forbidden = [
    ['rotation', 'bind-app', '--native'],
    ['rotation', 'unbind-app'],
    ['rotation', 'enable'],
    ['rotation', 'disable'],
    ['rotation', 'reset-runtime'],
    ['uninstall'],
    [],
  ];
  for (const args of forbidden) {
    const started = Date.now();
    const r = await runCli(args);
    assert.equal(r.ok, false, args.join(' '));
    assert.equal(r.code, 'CLI_FORBIDDEN', args.join(' '));
    assert.match(r.error, /不允许/);
    assert.ok(Date.now() - started < 200, '拒绝必须在启动进程之前');
  }
});

test('白名单只含只读或账号级子命令', () => {
  assert.deepEqual([...ALLOWED_SUBCOMMANDS].sort(), ['account', 'limits', 'login', 'status', 'switch']);
});

/** 去掉注释，只看代码里的字符串。 */
function code(text) { return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1'); }

test('绕开 runCli 直接起 CLI 的地方只有已审核的几处，且只用白名单子命令', () => {
  const root = path.resolve(__dirname, '..');
  const callers = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', 'bin', 'obj', 'test', 'tests', '.app-data'].includes(e.name)) walk(p); continue; }
      if (!/\.(js|mjs|cs|ps1|vbs|cmd)$/.test(e.name)) continue;
      const text = code(fs.readFileSync(p, 'utf8'));
      if (/paths\.CLI|deps\.cli\b|codex-multi-auth\.(js|cmd)/.test(text)) callers[path.relative(root, p).replace(/\\/g, '/')] = text;
    }
  };
  walk(root);
  // 新增直接调用 CLI 的文件必须先审核它会跑哪些子命令，再加进这张表。
  assert.deepEqual(Object.keys(callers).sort(), [
    'app/Infra.cs', // 只有一个未使用的 CliCmd 路径属性，不起进程
    'install.ps1', // 只检查 CLI 是否已安装
    'lib/cli.js', // 白名单入口
    'lib/config-schema.js', // CliCmd 路径默认值，不起进程
    'lib/login-flow.js', // login --preserve-selection
    'lib/paths.js', // 路径定义
    'lib/usage-logs.js', // 把路径交给 usage/accounts.js
    'lib/usage/accounts.js', // status --json
  ]);
  assert.match(callers['lib/login-flow.js'], /paths\.CLI \+ '" login --preserve-selection'/);
  assert.match(callers['lib/usage/accounts.js'], /\[deps\.cli, 'status', '--json'\]/);
  for (const [file, text] of Object.entries(callers)) {
    // 单独的 'rotation' / 'uninstall' 参数、命令行里的 rotation enable|disable，或任何 bind-app / reset-runtime。
    const banned = /['"`](rotation|uninstall)['"`]|\brotation\s+(enable|disable)\b|\buninstall\b|\b(un)?bind-app\b|\breset-runtime\b/;
    assert.ok(!banned.test(text), file + ' 不能出现会改写 Codex 配置的子命令');
  }
});
