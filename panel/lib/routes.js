'use strict';
/**
 * /api/* 路由表。
 *
 * 约定：进入这里的请求已经通过 Host / Origin / token 校验；
 * 每个 handler 只做「读 body -> 调领域函数 -> 统一信封」，不直接碰文件或 CLI。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const paths = require('./paths');
const { send, readBody } = require('./panel-http');
const { getState, refreshState } = require('./dashboard');
const { getUsage, readLogs } = require('./usage-logs');
const { runAccountAction } = require('./account-actions');
const { savePolicy } = require('./policy-store');
const { decideWithPolicy } = require('./policy-decision');
const { readRouter, startRouter, stopRouter, resetRouterError } = require('./router-control');
const {
  writeLoginLauncher, loginStateAge, findLoginDetails, killLoginWindows, cleanLoginArtifacts,
} = require('./login-flow');
const { runCli } = require('./cli');
const { invalidate } = require('./state-cache');
const { writeAppLogin } = require('./app-auth');
const { readProxyAccounts, findAccount } = require('./proxy-accounts');
const { AppError, errorInfo, redact } = require('./errors');
const { extractJson } = require('./fs-json');
const { validateRotation } = require('./rotation-policy');
const { withLock } = require('./operation-lock');
const { safeRebind } = require('./safe-rebind');
const { buildDiagnostics } = require('./diagnostics');

/** @returns {Promise<boolean>} true = 已处理；false = 交给 404。 */
async function handleApi(req, res, pathname, url) {
  if (req.method === 'GET' && pathname === '/api/state') {
    const force = url.searchParams.get('force') === '1';
    send(res, 200, { ok: true, state: await getState(force) });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/usage') {
    const q = url.searchParams;
    const days = Math.max(1, Math.min(14, Number(q.get('days') || 7)));
    try { send(res, 200, { ok: true, usage: await getUsage(days, q.get('force') === '1') }); }
    catch (e) { send(res, 500, Object.assign({}, errorInfo(e, 'USAGE_READ_FAILED'), { error: '用量统计失败: ' + redact(e) })); }
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/logs') {
    send(res, 200, { ok: true, logs: readLogs(120) });
    return true;
  }
  if (req.method === 'GET' && pathname === '/api/diagnostics') {
    try { send(res, 200, { ok: true, diagnostics: buildDiagnostics() }); }
    catch (e) { send(res, 500, errorInfo(e, 'DIAGNOSTICS_FAILED')); }
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/refresh') {
    // 深度刷新要打上游（实测约 7s）：后台跑，立刻返回当前数据 + meta.refreshing。
    // 点刷新不再让界面卡住，轮询会在构建完成后自动显示新数字。
    send(res, 200, { ok: true, state: await refreshState() });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/account') {
    const body = await readBody(req);
    const n = Math.round(Number(body.n));
    if (!n || n < 1) { send(res, 400, { ok: false, error: '账号序号无效' }); return true; }
    const r = await runAccountAction(n, String(body.action || ''), body.value);
    invalidate();
    const status = r.ok ? 200 : (['ACCOUNT_OPERATION_BUSY', 'CUSTOM_ROLE_RULE_REQUIRED'].includes(r.code) ? 409 : 500);
    send(res, status, r.ok
      ? { ok: true, message: (r.safeOut || r.out || '').trim().slice(0, 600), operationId: r.operationId }
      : Object.assign({}, errorInfo(r.error || r.safeOut || r.out || '账号操作失败', r.code || 'ACCOUNT_ACTION_FAILED'), { error: redact(r.error || r.safeOut || r.out || '账号操作失败'), operationId: r.operationId }));
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/policy') {
    const body = await readBody(req);
    const update = {};
    for (const key of ['autoSwitch', 'minWaitMin', 'reserveIndex']) {
      if (Object.prototype.hasOwnProperty.call(body, key)) update[key] = body[key];
    }
    if (Object.prototype.hasOwnProperty.call(body, 'rotation')) update.rotation = body.rotation;
    if (update.rotation) {
      try { update.rotation = validateRotation(update.rotation); }
      catch { throw new AppError('ROTATION_CONFIG_INVALID', '轮换规则无效，请检查角色、顺序和阈值', { status: 400 }); }
    }
    const saveBoundPolicy = async () => {
      if (update.rotation) {
        const result = await runCli(['account', 'policy', 'list', '--json'], 15000);
        const accounts = result.ok ? extractJson(result.out)?.accounts : null;
        if (!Array.isArray(accounts) || !accounts.length) throw new AppError('ACCOUNT_POLICY_READ_FAILED', '无法核对账户绑定，未保存规则。请刷新后重试', { status: 503 });
        const keys = [...update.rotation.daily, ...update.rotation.reserve];
        const actual = accounts.map(a => a.accountKey);
        if (keys.length !== actual.length || new Set(actual).size !== actual.length || actual.some(k => !keys.includes(k))) {
          throw new AppError('ACCOUNT_POOL_CHANGED', '账户池已变化，请刷新并为每个账户重新选择角色，原规则未改动', { status: 409 });
        }
      }
      return { policy: savePolicy(update) };
    };
    const saved = update.rotation ? await withLock(saveBoundPolicy) : { policy: savePolicy(update) };
    if (saved.busy) throw new AppError('ACCOUNT_OPERATION_BUSY', '其他账户操作正在执行，请稍后保存规则', { status: 409 });
    const policy = saved.policy;
    invalidate();
    send(res, 200, { ok: true, policy });
    return true;
  }
  // 策略试算：decide 纯函数的 HTTP 门面 —— 不读磁盘、不调 CLI、不执行任何动作。
  // 加一个“能看见规则效果”的能力只需要这一段 + 一条测试，不用碰决策核心。
  if (req.method === 'POST' && pathname === '/api/policy/preview') {
    const body = await readBody(req);
    const nowMs = Number(body.nowMs) > 0 ? Number(body.nowMs) : Date.now();
    const decision = decideWithPolicy(Object.assign({}, body, { nowMs }));
    send(res, 200, { ok: true, decision });
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/router') {
    const body = await readBody(req);
    const action = String(body.action || '');
    let r;
    if (action === 'start') {
      const started = await startRouter();
      if (!started.ok) { send(res, 500, Object.assign({}, errorInfo(started.error || '路由启动失败', 'ROUTER_START_FAILED'), { error: redact(started.error || '路由启动失败') })); return true; }
      resetRouterError();
      const rt = readRouter();
      r = rt.running ? { ok: true, message: '路由已启动 · PID ' + rt.pid + ' · 端口 ' + rt.port } : { ok: false, error: '路由启动失败，请检查启动项' };
    } else if (action === 'stop') {
      const stopped = await stopRouter();
      if (!stopped.ok) { send(res, 500, Object.assign({}, errorInfo(stopped.error || '路由停止失败', 'ROUTER_STOP_FAILED'), { error: redact(stopped.error || '路由停止失败') })); return true; }
      resetRouterError();
      r = { ok: true, message: '路由已停止' };
    } else if (action === 'restart') {
      const stopped = await stopRouter();
      if (!stopped.ok) { send(res, 500, Object.assign({}, errorInfo(stopped.error || '路由停止失败，未执行重启', 'ROUTER_RESTART_STOP_FAILED'), { error: redact(stopped.error || '路由停止失败，未执行重启') })); return true; }
      await new Promise((s) => setTimeout(s, 1200));
      const started = await startRouter();
      if (!started.ok) { send(res, 500, Object.assign({}, errorInfo(started.error || '路由重启失败', 'ROUTER_RESTART_START_FAILED'), { error: redact(started.error || '路由重启失败') })); return true; }
      resetRouterError();
      const rt = readRouter();
      r = rt.running ? { ok: true, message: '路由已重启 · PID ' + rt.pid + ' · 端口 ' + rt.port } : { ok: false, error: '路由重启失败，请检查启动项' };
    } else if (action === 'rebind') {
      // 不再调用 CLI 的 bind-app --native：它会删掉自定义 provider 段并重写启动项（见 safe-rebind.js）。
      const c = await withLock(() => safeRebind());
      if (c.busy) {
        send(res, 409, { ok: false, error: '账号或绑定操作正在进行，请稍后重试', code: c.code });
        return true;
      }
      r = { ok: c.ok, message: c.message, code: c.code };
    } else { send(res, 400, { ok: false, error: '未知路由操作' }); return true; }
    invalidate();
    const state = body.includeState === false ? undefined : await getState(true).catch(() => null);
    send(res, 200, Object.assign({ ok: r.ok !== false, state }, r));
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/login/cancel') {
    try {
      const info = await findLoginDetails();
      killLoginWindows(info.pids.concat(info.loginNodes));
      cleanLoginArtifacts();
      invalidate();
      send(res, 200, { ok: true, message: '已清理登录窗口（' + (info.pids.length) + ' 个）。' });
    } catch (err) { send(res, 500, errorInfo(err, 'LOGIN_CANCEL_FAILED')); }
    return true;
  }
  if (req.method === 'POST' && pathname === '/api/login') {
    try {
      const age = loginStateAge();
      // 单飞以 launcher 自己写的 panel-login.state 为准，而不是只靠进程探测：
      // 进程探测在「窗口刚起来 / 非交互环境 / 权限受限」时会漏，旧逻辑因此可能重复开窗。
      if (age >= 0 && age < 90000) {
        send(res, 409, { ok: false, error: '登录窗口刚刚启动，请稍等一下（不要重复点击）。' });
        return true;
      }
      const info = await findLoginDetails();
      if (info.pids.length > 0) {
        // 窗口在，但里面已经没有 login 进程：多半是授权已结束/浏览器页已关，窗口还赖着 → 视为陈旧，清掉重开
        if (info.loginNodes.length > 0) {
          send(res, 409, { ok: false, error: '登录窗口正在授权中（PID ' + info.pids.join(',') + '）。请先在那个命令行窗口里完成授权再试。' });
          return true;
        }
        killLoginWindows(info.pids);
        cleanLoginArtifacts();
      } else {
        // 没有任何存活的 cmd / CLI 进程：说明用户关掉了登录窗口或浏览器，直接清理残留 state 并重新打开
        cleanLoginArtifacts();
      }
      const body = await readBody(req).catch(() => ({}));
      const dry = body && body.dry === true;
      writeLoginLauncher(dry);
      if (process.env.PANEL_LOGIN_SPAWN === 'skip') {
        // 测试专用：只落 launcher 与 state，不真的开窗口。
        // 真实测试曾在开发机上弹出过一串登录窗口，所以这里留一个显式开关，测试环境永远不允许弹窗。
        try { fs.writeFileSync(paths.LOGIN_STATE, 'started'); } catch (e) { /* ignore */ }
      } else {
        spawn('cmd.exe', ['/c', 'start', paths.LOGIN_TITLE + (dry ? ' (DRY RUN)' : ''), paths.LOGIN_CMD], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
      }
      invalidate();
      send(res, 200, {
        ok: true,
        dry: dry,
        message: dry
          ? '试运行：已模拟打开登录窗口（不会真正登录，约 2 分钟后自动关闭）。'
          : '已打开登录窗口：在浏览器里完成授权，然后关闭那个命令行窗口，再点「刷新额度」。',
      });
    } catch (err) { send(res, 500, errorInfo(err, 'LOGIN_START_FAILED')); }
    return true;
  }
  // 把 Codex 应用的登录态同步成某个代理账号（默认：代理当前账号）。
  // 为什么需要它：面板切账号只改代理路由，应用界面的额度横幅读的是应用登录；
  // 两者不一致就会出现“代理明明有额度，Codex 却喊额度用完”。
  if (req.method === 'POST' && pathname === '/api/app-login') {
    const body = await readBody(req);
    if (body.file || body.authPath) { send(res, 400, { ok: false, error: '不允许通过 API 指定认证文件路径', code: 'AUTH_PATH_OVERRIDE_DENIED' }); return true; }
    const info = readProxyAccounts();
    if (!info.ok) { send(res, 400, { ok: false, error: '读取代理账号库失败', code: 'ACCOUNTS_READ_FAILED' }); return true; }
    const wantEmail = body && body.email ? String(body.email) : '';
    const wantN = body && body.n ? Number(body.n) : 0;
    const account = findAccount(info, { email: wantEmail, n: wantN });
    if (!account) {
      send(res, 400, { ok: false, error: '找不到要同步的账号' }); return true;
    }
    let out;
    try {
      out = await withLock(async () => writeAppLogin(account));
      if (out.busy) { send(res, 409, { ok: false, error: '账号操作正在进行', code: out.code }); return true; }
    } catch (err) {
      send(res, 500, errorInfo(err, 'APP_LOGIN_WRITE_FAILED')); return true;
    }
    invalidate();
    send(res, 200, {
      ok: true,
      email: out.email,
      backupProtected: !!out.backup,
      message: '已把应用登录同步为 ' + (out.email || '账号 ' + (account.index + 1)) + '（重启 Codex 应用后生效）',
    });
    return true;
  }
  return false;
}

module.exports = { handleApi };
