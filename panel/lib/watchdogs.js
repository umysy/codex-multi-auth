'use strict';
/**
 * 两个后台看门狗：
 *   1) 登录窗口超过 15 分钟未结束 → 杀掉；
 *   2) 路由器“上游传输失败后长期无进展” → 自动重启。
 *
 * 判断逻辑抽成纯函数（isTransportError / nextRouterWatch / shouldKillLogin）并导出，
 * 单测不需要真的等待 setInterval 或起停进程。
 */
const paths = require('./paths');
const { appendPolicyLine } = require('./events');
const { loginStateAge, findLoginDetails, killLoginWindows, cleanLoginArtifacts } = require('./login-flow');
const { readRouter, startRouter, stopRouter, resetRouterError, readLaunchExit } = require('./router-control');
const { ensureProviderConfig, ensureProviderLabel, sweepOrphanRouters } = require('./binding-guard');
const { accountsFile } = require('./proxy-accounts');
const fs = require('fs');
const { withLock } = require('./operation-lock');
const { invalidate } = require('./state-cache');
const { readJson } = require('./fs-json');
const { spawn } = require('child_process');

// 观察到的真实现象：Codex 桌面版的请求偶尔会遇到上游传输失败
// （lastError = "fetch failed" / "upstream fetch timed out"），路由器会重试并自行恢复。
// 但如果连续 2 分钟没有任何新请求、错误也一直没恢复，说明卡住了，此时自动重启路由。
const TRANSPORT_ERR = /fetch failed|timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|network/i;
const STALE_MS = 120000;
const RESTART_COOLDOWN_MS = 15 * 60 * 1000;
const DOWN_RESTART_COOLDOWN_MS = 60000; // 路由进程不在时每 60 秒拉一次（计划任务要等 5 分钟）
// 只有「配额类」阻塞才值得踢策略：网络冷却（cooling-down:*）是上游/代理抖动的自然后果，
// 策略换号也治不了；踢了只会每分钟空跑一次 PowerShell。
const QUOTA_BLOCK_REASONS = Object.freeze(['rate-limited', 'quota-exhausted']);
const MODEL_CAPACITY_RE = /model[\s_-]*capacity|capacity[\s_-]*(?:exhausted|insufficient|unavailable)/i;
const AUTH_RUNTIME_RE = /(?:auth|unauthori[sz]ed|token)[\s_-]*(?:invalid|expired|revoked|failed)|invalid[\s_-]*token/i;

let _watch = { lastRequests: -1, still: 0, lastRestartAt: 0, down: 0 };
let _loginGuardBusy = false;
let _routerWatchBusy = false;

/** 纯函数：错误文本像不像“上游传输失败”。 */
function isTransportError(text) {
  return !!text && TRANSPORT_ERR.test(text);
}

/**
 * 纯函数：一次看门狗 tick 的判断。
 * prev / 返回的 next 都是 { lastRequests, still, lastRestartAt }；
 * restart=true 时调用方负责 stop → wait → start → reset。
 */
function nextRouterWatch(prev, rt, nowMs) {
  const next = { lastRequests: prev.lastRequests, still: prev.still, lastRestartAt: prev.lastRestartAt, down: prev.down || 0 };
  if (!rt || !rt.running) {
    next.down += 1;
    // 进程还在、只是状态文件过期：多半是电脑刚从睡眠唤醒（路由每秒写状态的定时器还没跑）。
    // 以前这里直接判死并重启，把正在输出的对话全部掐断（10-28/29 一天十几次）。再等一个 tick 确认。
    if (rt && rt.alive && next.down < 2) return { next, restart: false, reason: 'router status stale' };
    // 进程不在（或状态文件已经过期）→ 直接拉起，别等 5 分钟的计划任务，
    // 这段时间里 Codex 的每个请求都会失败。
    const restart = nowMs - next.lastRestartAt > DOWN_RESTART_COOLDOWN_MS;
    if (restart) { next.lastRestartAt = nowMs; next.down = 0; }
    return { next, restart, reason: 'router not running' };
  }
  next.down = 0;
  if (rt.requests === next.lastRequests) next.still += 1;
  else { next.still = 0; next.lastRequests = rt.requests; }
  const transport = isTransportError(rt.lastError);
  const stale = rt.lastErrorAt ? nowMs - rt.lastErrorAt > STALE_MS : false;
  const restart = Boolean(
    transport && !rt.errorRecovered && stale && next.still >= 2 && nowMs - next.lastRestartAt > RESTART_COOLDOWN_MS,
  );
  if (restart) { next.lastRestartAt = nowMs; next.still = 0; }
  return { next, restart, reason: rt.lastError || '' };
}

/** 纯函数：登录窗口是否该被强杀（默认超过 15 分钟）。 */
function shouldKillLogin(ageMs, maxMs) {
  const limit = maxMs === undefined ? paths.LOGIN_MAX_MS : maxMs;
  return Number(ageMs) > Number(limit);
}

/** 纯函数：一条退出记录 → 面板事件文案。 */
function describeRouterExit(entry) {
  if (!entry || !entry.raw) return '';
  const at = /^\[(.*?)\]/.exec(entry.raw);
  const when = at ? at[1] : '';
  return '路由进程退出（exit=' + entry.code + (when ? '，发生在 ' + when : '') + '）';
}

/**
 * 纯函数：只上报「新出现」的退出记录（面板刚启动时先把已有记录记为已上报，避免刷旧账）。
 * 返回 { raw, report }：raw 是下次的 prevRaw，report 表示这次要不要写事件。
 */
function nextLaunchExitSeen(prevRaw, entry) {
  const raw = entry && entry.raw ? entry.raw : '';
  return { raw, report: Boolean(raw) && raw !== (prevRaw || '') };
}

function startLoginGuard() {
  setInterval(async () => {
    if (_loginGuardBusy) return;
    _loginGuardBusy = true;
    try {
      const age = loginStateAge();
      if (!shouldKillLogin(age)) return;
      const info = await findLoginDetails();
      killLoginWindows(info.pids.concat(info.loginNodes));
      cleanLoginArtifacts();
      appendPolicyLine('GUARD', '登录窗口超过 15 分钟未结束，已强制关闭');
    } catch (e) { /* ignore */ } finally { _loginGuardBusy = false; }
  }, 60000).unref();
}

/**
 * 是否需要立刻踢一次策略：运行时刚报过"池耗尽 / 某账号硬阻塞（含 cooling-down 网络冷却）"。
 * 只认 90 秒内的观测，且两次踢之间至少间隔 60 秒（策略自身还有互斥体与 5 秒耗时）。
 */
function shouldKickPolicy(obs, lastKickAt, nowMs, opts) {
  if (!obs || typeof obs !== 'object') return false;
  const maxAgeMs = (opts && opts.maxAgeMs) || 90000;
  const throttleMs = (opts && opts.throttleMs) || 5 * 60 * 1000; // 与策略自身 5 分钟节奏对齐
  const updatedAt = Number(obs.updatedAt);
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  const age = nowMs - updatedAt;
  if (age < 0 || age > maxAgeMs) return false;
  if (lastKickAt && nowMs - lastKickAt < throttleMs) return false;
  const skips = obs.accountSkipReasons && typeof obs.accountSkipReasons === 'object' ? obs.accountSkipReasons : {};
  // 只认配额类：网络冷却/模型不支持都不该触发「立刻踢策略」。
  return Object.keys(skips).some((k) => {
    const reason = String(skips[k] || '').trim().toLowerCase();
    return QUOTA_BLOCK_REASONS.indexOf(reason) >= 0 || MODEL_CAPACITY_RE.test(reason) || AUTH_RUNTIME_RE.test(reason);
  });
}

function shouldKickStalePolicy(schedule, lastKickAt, nowMs, opts) {
  if (!schedule || typeof schedule !== 'object') return false;
  const maxAgeMs = (opts && opts.maxAgeMs) || 12 * 60 * 1000;
  const throttleMs = (opts && opts.throttleMs) || 10 * 60 * 1000;
  const lastRun = Number(schedule.lastRunAtMs);
  if (!Number.isFinite(lastRun) || lastRun <= 0 || nowMs - lastRun <= maxAgeMs) return false;
  return !lastKickAt || nowMs - lastKickAt >= throttleMs;
}

/** 后台踢一次策略脚本（不阻塞看门狗；策略自己会抢互斥体，重复踢无副作用）。 */
function kickPolicy() {
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', paths.POLICY_PS1], {
      detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
    });
    child.once('error', (err) => appendPolicyLine('ERROR', '策略触发失败（' + String(err && err.message || err).slice(0, 300) + '）'));
    child.once('close', (code) => {
      if (code !== 0) appendPolicyLine('ERROR', '策略触发进程退出码 ' + code + '（请检查 quota-policy.log）');
    });
    child.unref();
    return true;
  } catch (e) { return false; }
}

/**
 * 纯函数：把「运行时当下的阻塞画像」压成一行签名（池耗尽原因 + 跳过原因）。
 * 用途：观察值不变时不要反复踢策略——lastPoolExhaustionReason 会长期挂着（sticky），
 * 只看它会在池子恢复前每分钟触发一次。签名变了才说明出现了新的阻塞。
 */
function kickSignature(obs) {
  if (!obs || typeof obs !== 'object') return '';
  const skips = obs.accountSkipReasons && typeof obs.accountSkipReasons === 'object' ? obs.accountSkipReasons : {};
  const parts = Object.keys(skips).sort().map((k) => k + '=' + String(skips[k]));
  const exhausted = obs.lastPoolExhaustionReason === undefined || obs.lastPoolExhaustionReason === null
    ? '' : String(obs.lastPoolExhaustionReason);
  // 注意：不要把 lastPoolExhaustionRetryAfterMs 放进签名——它是「还剩多久」的倒计时，
  // 每次观测都在变，等于每次都被判成新阻塞，去重就失效了。
  return [exhausted, parts.join(',')].join('|');
}

/** 纯函数：该不该现在踢一次——在 shouldKickPolicy 之外再要求「阻塞画像和上次踢时不一样」。 */
function shouldKickNow(obs, lastKickAt, lastSig, nowMs, opts) {
  if (!shouldKickPolicy(obs, lastKickAt, nowMs, opts)) return false;
  return kickSignature(obs) !== (lastSig || '');
}

let _policyKickAt = 0;
let _policyKickSig = '';
let _policyStaleKickAt = 0;
let _launchExitRaw = null;
let _launchExitInit = false;

function startRouterWatchdog() {
  setInterval(async () => {
    if (_routerWatchBusy) return;
    _routerWatchBusy = true;
    try {
      const now = Date.now();
      const step = nextRouterWatch(_watch, readRouter(), now);
      _watch = step.next;
      // 路由退出记录：launcher（cmd）只写文件，中文事件由这里补，避免批处理编码问题。
      const exitEntry = readLaunchExit();
      if (!_launchExitInit) {
        _launchExitInit = true;
        _launchExitRaw = exitEntry ? exitEntry.raw : null;
      } else {
        const seen = nextLaunchExitSeen(_launchExitRaw, exitEntry);
        _launchExitRaw = seen.raw || _launchExitRaw;
        if (seen.report) appendPolicyLine('ROUTER', describeRouterExit(exitEntry));
      }
      const obs = readJson(paths.OBSERVABILITY, null);
      const schedule = readJson(paths.SCHEDULE_FILE, null);
      if (shouldKickStalePolicy(schedule, _policyStaleKickAt, now)) {
        _policyStaleKickAt = now;
        appendPolicyLine('POLICY', '策略心跳已过期，自动触发一次策略恢复');
        if (kickPolicy()) invalidate();
      }
      if (shouldKickNow(obs, _policyKickAt, _policyKickSig, now)) {
        _policyKickAt = now;
        _policyKickSig = kickSignature(obs);
        appendPolicyLine('POLICY', '运行时报告池耗尽/账号冷却，立即触发一次策略（不等 5 分钟计划任务）');
        if (kickPolicy()) invalidate();
      }
      // Repair codex config if a half-finished app-login bind left it pointing at a temp router.
      try { await withLock(() => ensureProviderConfig()); } catch (e) { /* ignore */ }
      // Codex 侧栏显示的账号名；切号时由 startLabelSync 即时同步，这里兜底（例如 Codex 改回了配置）。
      try { await withLock(async () => ensureProviderLabel()); } catch (e) { /* ignore */ }
      // 泄漏的 app-login router 只要活着就会继续改写 config.toml，所以每分钟也扫一遍。
      try { await sweepOrphanRouters(); } catch (e) { /* ignore */ }
      if (!step.restart) return;
      appendPolicyLine('ROUTER', '上游传输失败超过 2 分钟无进展（' + step.reason + '），已自动重启路由');
      await stopRouter();
      await new Promise((r) => setTimeout(r, 1200));
      await startRouter();
      resetRouterError();
      invalidate();
    } catch (e) { /* ignore */ } finally { _routerWatchBusy = false; }
  }, 60000).unref();
}

let _labelBusy = false;
/** 账号库一变（策略切号 / 面板手动切号）就同步 Codex 侧栏显示的账号名。 */
function startLabelSync() {
  const sync = async () => {
    if (_labelBusy) return;
    _labelBusy = true;
    try { await withLock(async () => ensureProviderLabel()); } catch (e) { /* 锁被占用：下一次变化或每分钟兜底 */ } finally { _labelBusy = false; }
  };
  try { fs.watchFile(accountsFile(), { interval: 3000, persistent: false }, () => { void sync(); }); } catch (e) { /* ignore */ }
  void sync();
}

function startWatchdogs() { startLoginGuard(); startRouterWatchdog(); startLabelSync(); }

module.exports = {
  startWatchdogs,
  startLoginGuard,
  startRouterWatchdog,
  startLabelSync,
  isTransportError,
  nextRouterWatch,
  shouldKillLogin,
  shouldKickPolicy,
  shouldKickStalePolicy,
  kickPolicy,
  kickSignature,
  shouldKickNow,
  describeRouterExit,
  nextLaunchExitSeen,
  QUOTA_BLOCK_REASONS,
  DOWN_RESTART_COOLDOWN_MS,
};
