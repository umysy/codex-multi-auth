'use strict';
/**
 * 路由进程（codex-app-router）的观察与控制：读状态、修启动项、启停、错误陈旧化判定。
 *
 * 把“纯判断”单独导出（describeRouterStatus / nextErrorCache / errorMetaOf / needsStartRepair），
 * 文件读写与进程操作留在外层函数里——这样单测不用真的起进程或改本机启动项。
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const paths = require('./paths');
const { readJson, writeJson } = require('./fs-json');
const { processEnvLines, shQuote } = require('./cli');
const { appendPolicyLine } = require('./events');
const { invalidate } = require('./state-cache');

let _routerErrCache = null;

/**
 * 纯函数：错误计时的下一步。
 * prev 是上一次的 { text, at, requestsAt }（null/false 表示还没有记录）；
 * text 第一次出现或发生变化时 started=true，由调用方负责落盘。
 */
function nextErrorCache(prev, text, requests, nowMs) {
  if (!prev || prev === true || prev.text !== text) {
    return { cache: { text, at: nowMs, requestsAt: requests || 0 }, started: true };
  }
  return { cache: prev, started: false };
}

/**
 * 纯函数：这条错误是否已经“恢复”。
 * 记录错误时的请求数之后又成功处理了 >= 2 个请求，才认为陈旧错误已恢复。
 */
function errorMetaOf(cache, requests) {
  if (!cache || cache === true) return { at: null, since: 0, recovered: true };
  const since = Math.max(0, (requests || 0) - (cache.requestsAt || 0));
  return { at: cache.at, since, recovered: since >= 2 };
}

/**
 * 路由器状态文件里的 lastError 一旦写入就永不自动清空。
 * 这里记录该错误首次被观察到的时刻与当时的请求计数：
 * 之后若又成功处理了请求（计数增长），就把它标成“已恢复的陈旧错误”。
 */
function trackRouterError(text, requests) {
  if (_routerErrCache === undefined || _routerErrCache === null) {
    _routerErrCache = readJson(paths.ROUTER_STATE_FILE, null) || false;
  }
  if (!text) {
    if (_routerErrCache) resetRouterError();
    return errorMetaOf(null, requests);
  }
  const step = nextErrorCache(_routerErrCache || false, text, requests, Date.now());
  if (step.started) {
    _routerErrCache = step.cache;
    try { writeJson(paths.ROUTER_STATE_FILE, _routerErrCache); } catch (e) { /* ignore */ }
  }
  return errorMetaOf(_routerErrCache, requests);
}

/** 手动清除“路由错误陈旧”判定（启停/重启后调用）。 */
function resetRouterError() {
  _routerErrCache = false;
  try { fs.unlinkSync(paths.ROUTER_STATE_FILE); } catch (e) { /* ignore */ }
}

/** 纯函数：原始状态 JSON + 进程是否存活 → 面板使用的形状。 */
const STATUS_FRESH_MS = 15000;

function describeRouterStatus(st, alive, errMeta, nowMs) {
  const meta = errMeta || { at: null, since: 0, recovered: true };
  // 路由活着时每秒都会重写状态文件；updatedAt 过期就说明它已经不在了。
  // 只信 PID 会误判：Windows 的 PID 会被系统复用，kill(pid,0) 可能命中别的进程。
  const updatedAt = Number(st.updatedAt) || 0;
  const now = Number(nowMs) || Date.now();
  const fresh = updatedAt > 0 && now - updatedAt <= STATUS_FRESH_MS;
  return {
    running: st.state === 'running' && alive === true && fresh,
    alive: alive === true,
    pid: st.pid || null,
    port: Number(st.port) || 56014,
    requests: st.totalRequests || 0,
    upstream: st.upstreamRequests || 0,
    rotations: st.rotations || 0,
    retries: st.retries || 0,
    ws: st.websocketConnections || 0,
    lastError: st.lastError || '',
    lastErrorAt: meta.at,
    requestsSinceError: meta.since,
    errorRecovered: meta.recovered,
    lastAccountIndex: typeof st.lastAccountIndex === 'number' ? st.lastAccountIndex + 1 : null,
    startedAt: st.startedAt || null,
    updatedAt: st.updatedAt || null,
  };
}

function readRouter() {
  const st = readJson(paths.STATUS_JSON, null);
  if (!st) return { running: false, pid: null };
  const bind = readJson(path.join(paths.APP_BIND, 'runtime-rotation-app-bind.json'), null);
  if (bind && bind.port) st.port = bind.port;
  let alive = false;
  try { process.kill(st.pid, 0); alive = true; } catch { alive = false; }
  const errMeta = trackRouterError(st.lastError || '', st.totalRequests || 0);
  return describeRouterStatus(st, alive, errMeta, Date.now());
}

/**
 * 纯函数：启动项要不要修。
 * 启动项可能被测试/外部工具改写到别的 HOME 或端口，这里只判断“与本机 app-bind 不一致”。
 * 缺少 app-bind 配置时返回 false（由调用方报错，不在这里静默改写）。
 */
function needsStartRepair(cmdText, bind) {
  // 配置不完整时无法判断“该长什么样”，交回调用方报错，绝不在这里猜着改写
  if (!bind || !bind.nodePath || !bind.routerScriptPath || !bind.port || !bind.statusPath) return false;
  const txt = String(cmdText || '');
  // 上游超时设置也算启动项契约的一部分：旧启动项没有这两行时会按 CLI 默认 60s/45s 超时，
  // 巨量上下文的请求就会频繁失败（upstream fetch timed out after 60000ms）。
  return !txt || txt.includes('codexquota-test') || !txt.includes('--port ' + bind.port) ||
    !txt.includes(bind.statusPath) || !txt.includes('CODEX_AUTH_FETCH_TIMEOUT_MS=') ||
    !txt.includes('CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=');
}

function ensureRouterCmd() {
  try {
    const bind = readJson(path.join(paths.APP_BIND, 'runtime-rotation-app-bind.json'), null);
    if (!bind || !bind.nodePath || !bind.routerScriptPath || !bind.port || !bind.statusPath) return { ok: false, reason: '缺少 app-bind 配置' };
    let txt = '';
    try { txt = fs.readFileSync(paths.ROUTER_CMD, 'utf8'); } catch (e) { txt = ''; }
    const bad = needsStartRepair(txt, bind);
    if (!bad) return { ok: true, repaired: false };
    const lines = ['@echo off'].concat(processEnvLines(), [
      'set "CODEX_AUTH_FETCH_TIMEOUT_MS=300000"',
      'set "CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=90000"',
      '"' + bind.nodePath + '" "' + bind.routerScriptPath + '" --port ' + bind.port +
        ' --status "' + bind.statusPath + '" --identity-token "' + bind.identityToken +
        '" --state "' + bind.statePath + '" --log "' + bind.logPath + '" --max-log-bytes 1048576',
    ]);
    fs.writeFileSync(paths.ROUTER_CMD, lines.join('\r\n') + '\r\n', 'ascii');
    appendPolicyLine('ROUTER', '路由启动项被改动过（非本机配置），已按 app-bind 自动修复');
    return { ok: true, repaired: true };
  } catch (e) { return { ok: false, reason: String(e) }; }
}

/** 路由进程需要的上游超时（毫秒）：大上下文请求远超 CLI 默认的 60s fetch / 45s stall。 */
const ROUTER_ENV = Object.freeze({
  CODEX_AUTH_FETCH_TIMEOUT_MS: '300000',
  CODEX_AUTH_STREAM_STALL_TIMEOUT_MS: '90000',
});

function routerEnv() { return Object.assign({}, process.env, ROUTER_ENV); }

/**
 * launcher 脚本文本（纯函数，便于单测）。
 * 目的：路由退出时把退出码和时间落盘——路由自身经常 0 字节就消失，没有这个只能靠猜。
 */
function launchWrapperText(routerCmd, launchLog) {
  const lines = [
    '@echo off',
    'setlocal',
    'call "' + routerCmd + '"',
    'set "EXITCODE=%ERRORLEVEL%"',
    'echo [%DATE% %TIME%] ROUTER-EXIT exit=%EXITCODE%>>"' + launchLog + '"',
    'endlocal',
  ];
  return lines.join('\r\n') + '\r\n';
}

/** 脱壳脚本：wscript 拉起 launcher 后立即退出（Shell.Run 第三个参数 false = 不等待）。 */
function launchVbsText(wrapperPath) {
  return [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Run """" & "' + wrapperPath + '" & """", 0, False',
    '',
  ].join('\r\n');
}

/** 写 launcher（每次启动都覆盖，内容只依赖启动项与日志路径）。 */
function writeLaunchWrapper() {
  try {
    fs.mkdirSync(path.dirname(paths.ROUTER_WRAPPER), { recursive: true });
  } catch (e) { /* 已存在即可 */ }
  fs.writeFileSync(paths.ROUTER_WRAPPER, launchWrapperText(paths.ROUTER_CMD, paths.ROUTER_LAUNCH_LOG), 'ascii');
  fs.writeFileSync(paths.ROUTER_VBS, launchVbsText(paths.ROUTER_WRAPPER), 'ascii');
  return paths.ROUTER_WRAPPER;
}

/**
 * 独立启动：wscript 拉起 launcher 后立刻退出，路由因此挂在一个已退出的父进程下，
 * 面板托盘退出时的 Kill(entireProcessTree) 不会再把它一起带走。
 */
function spawnIndependent() {
  return spawn('wscript.exe', [paths.ROUTER_VBS], {
    detached: true, stdio: 'ignore', windowsHide: true, env: routerEnv(),
  });
}

function startRouter() {
  return new Promise((resolve) => {
    try {
      // 幂等：已经在跑就别再 spawn 一个（重复点、看门狗与手动操作撞车都会走到这里，
      // 两个路由器抢同一个端口只会互相打断，状态文件也会被后起的那个覆盖）。
      const cur = readRouter();
      if (cur.running && cur.pid) return resolve({ ok: true, pid: cur.pid, already: true, ms: 0 });
      const guard = ensureRouterCmd();
      if (!guard.ok) return resolve({ ok: false, error: guard.reason || '启动项不可用' });
      // 关键：不要直接 spawn 启动项（那样路由是面板的子进程，面板托盘退出时
      // Process.Kill(entireProcessTree) 会顺手把路由一起杀掉，用户看到的就是“重启面板后 Codex 掉线”）。
      // 改成 launcher + wscript 脱壳启动：路由不在面板进程树里，退出码也会被 launcher 写进 launch 日志。
      writeLaunchWrapper();
      const child = spawnIndependent();
      if (child && child.on) child.on('error', () => { /* WMI 失败时由下面的超时兜底 */ });
      child.unref();
      const t0 = Date.now();
      const tick = () => {
        const rt = readRouter();
        if (rt.running && rt.pid) { invalidate(); return resolve({ ok: true, pid: rt.pid, ms: Date.now() - t0 }); }
        if (Date.now() - t0 > 15000) { invalidate(); return resolve({ ok: false, error: '路由在 15 秒内未就绪' }); }
        setTimeout(tick, 400);
      };
      setTimeout(tick, 400);
    } catch (err) { resolve({ ok: false, error: String(err) }); }
  });
}

/**
 * 读 launcher 写下的最后一条退出记录（router-launch.cmd 会在路由退出时追加）。
 * 返回 { raw, code } 或 null；文件不存在/没有记录都返回 null。
 */
function readLaunchExit(logPath) {
  try {
    const file = logPath || paths.ROUTER_LAUNCH_LOG;
    if (!fs.existsSync(file)) return null;
    const text = fs.readFileSync(file, 'utf8');
    const matches = text.match(/^\[.*?\] ROUTER-EXIT exit=(-?\d+)$/gm);
    if (!matches || !matches.length) return null;
    const raw = matches[matches.length - 1].trim();
    const m = /exit=(-?\d+)$/.exec(raw);
    return { raw, code: Number(m[1]) };
  } catch (e) { return null; }
}

function stopRouter() {
  return new Promise((resolve) => {
    const cur = readRouter();
    if (!cur.running || !cur.pid) return resolve({ ok: true, note: '路由未运行' });
    try {
      const verifyStopped = (err, stderr) => {
        invalidate();
        setTimeout(() => {
          const after = readRouter();
          if (!after.running) return resolve({ ok: true });
          resolve({ ok: false, error: String(stderr || (err && err.message) || '路由进程仍在运行（PID ' + cur.pid + '）').trim() });
        }, 800);
      };
      execFile('taskkill.exe', ['/PID', String(cur.pid), '/T', '/F'], { windowsHide: true }, (err, stdout, stderr) => {
        if (!err) return verifyStopped(null, null);
        // 某些 Windows 环境对 taskkill 返回“拒绝访问”，同一用户仍可结束自己的 Node 进程。
        try { process.kill(Number(cur.pid)); } catch { /* fallback below */ }
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Stop-Process -Id ' + Number(cur.pid) + ' -Force'], { windowsHide: true }, () => {
          verifyStopped(err, stderr);
        });
      });
    } catch (err) { resolve({ ok: false, error: String(err) }); }
  });
}

module.exports = {
  STATUS_FRESH_MS,
  readRouter,
  describeRouterStatus,
  nextErrorCache,
  errorMetaOf,
  needsStartRepair,
  ensureRouterCmd,
  startRouter,
  stopRouter,
  resetRouterError,
  ROUTER_ENV,
  routerEnv,
  readLaunchExit,
  launchWrapperText,
  launchVbsText,
  writeLaunchWrapper,
};
