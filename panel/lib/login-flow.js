'use strict';
/**
 * 「添加账号」登录窗口的生命周期管理。
 *
 * 事故复盘：旧实现 spawn(node, [cli,'login'], { stdio:'ignore', detached:true })
 * 没有 TTY，CLI 的交互菜单立刻读到 EOF 并取默认项，login 的 while(true) 于是反复走
 * “添加账号 -> 打开浏览器”，十几秒开出成百上千个窗口，直接把机器卡死。
 * 现在：
 *   1) 生成 .cmd，用 `cmd /c start "标题" file.cmd` 在独立可见的命令行窗口里跑 login（真 TTY，提示会阻塞）；
 *   2) 加 --preserve-selection，跳过登录仪表盘菜单循环；
 *   3) 单飞：以登录窗口自己写的 panel-login.state + 进程探测判断，一次只允许一个；
 *   4) 15 分钟看门狗（见 watchdogs.js），超时结束整棵进程树。
 */
const fs = require('fs');
const { execFile } = require('child_process');
const paths = require('./paths');
const { processEnvLines } = require('./cli');

function writeLoginLauncher(dryOverride) {
  const dry = dryOverride === true || paths.LOGIN_DRY;
  const lines = dry
    ? [
        '@echo off',
        'title ' + paths.LOGIN_TITLE + ' (DRY RUN)',
        '> "%~dp0panel-login.state" echo started',
        'echo DRY RUN: login window launched successfully.',
        'echo Close this window when done.',
        'timeout /t 120 >nul',
        'del "%~dp0panel-login.state" >nul 2>nul',
      ]
    : [
        '@echo off',
        'title ' + paths.LOGIN_TITLE + ' - finish sign-in, then close this window',
        'chcp 65001 >nul',
        ...processEnvLines(),
        '> "%~dp0panel-login.state" echo started',
        'echo.',
        'echo ==== Codex add account ====',
        'echo A browser window will open. Finish sign-in there.',
        'echo Then CLOSE this window and click "refresh" in the panel.',
        'echo.',
        '"' + paths.NODE_EXE + '" "' + paths.CLI + '" login --preserve-selection',
        'echo.',
        'del "%~dp0panel-login.state" >nul 2>nul',
        'echo Finished. Close this window and refresh the panel.',
        'pause >nul',
      ];
  fs.writeFileSync(paths.LOGIN_CMD, lines.join('\r\n') + '\r\n', 'latin1');
}

function loginStateAge() {
  try {
    // Windows 的 mtimeMs 带亚毫秒精度，而 Date.now() 只有毫秒：刚写完状态文件就再点一次时，
    // 时间差会算出小于 0 的“负数年龄”。负数必须按“刚启动”处理，否则单飞失效、会重复开登录窗口。
    const age = Date.now() - fs.statSync(paths.LOGIN_STATE).mtimeMs;
    return age > 0 ? age : 0;
  } catch (e) {
    // 文件在、但 stat 瞬间失败（Windows 上刚写完就被杀软/索引服务锁住很常见）：
    // 这时必须按「刚启动」处理。宁可拦住一次重复点击，也不要再开一个登录窗口。
    try { return fs.existsSync(paths.LOGIN_STATE) ? 0 : -1; } catch (e2) { return 0; }
  }
}

function findLoginDetails() {
  return new Promise((resolve) => {
    const script = [
      "$cmd=@(Get-CimInstance Win32_Process -Filter \"Name='cmd.exe'\" | Where-Object { $_.CommandLine -like '*panel-open-login*' } | Select-Object -ExpandProperty ProcessId)",
      "$node=@(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*codex-multi-auth.js*' -and $_.CommandLine -like '*login*' } | Select-Object -ExpandProperty ProcessId)",
      "[ordered]@{cmd=$cmd;node=$node} | ConvertTo-Json -Compress",
    ].join('; ');
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 20000 }, (err, stdout) => {
        if (err) return resolve({ pids: [], loginNodes: [] });
        try {
          const j = JSON.parse(String(stdout || '{}').trim() || '{}');
          const toArr = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v])).map((x) => parseInt(x, 10)).filter((x) => Number.isFinite(x));
          return resolve({ pids: toArr(j.cmd), loginNodes: toArr(j.node) });
        } catch (e) { return resolve({ pids: [], loginNodes: [] }); }
      });
    } catch (e) { resolve({ pids: [], loginNodes: [] }); }
  });
}

function killLoginWindows(pids) {
  for (const pid of pids || []) { try { execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {}); } catch (e) { /* ignore */ } }
}

function cleanLoginArtifacts() {
  try { fs.unlinkSync(paths.LOGIN_STATE); } catch (e) { /* ignore */ }
  try { fs.unlinkSync(paths.LOGIN_CMD); } catch (e) { /* ignore */ }
}

module.exports = { writeLoginLauncher, loginStateAge, findLoginDetails, killLoginWindows, cleanLoginArtifacts };
