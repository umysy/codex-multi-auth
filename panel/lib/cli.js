'use strict';
/**
 * 调用 codex-multi-auth CLI 的唯一入口。
 *
 * 所有对 CLI 的 subprocess 都在这里，便于集中处理超时/代理/大输出。
 * 注意：这里只负责“执行命令并拿回文本”，不做业务判断。
 *
 * 用 spawn 而不是 execFile：CLI 都是非交互命令，stdin 必须显式关闭（'ignore'）。
 * execFile 会一直持有 stdin 管道——只要 CLI 里某个路径尝试读 stdin，子进程就会
 * 静默挂起直到 25s 超时，面板只能显示“账号操作失败”。这里同时自己实现超时与
 * 输出上限，把真实原因（超时/退出码/输出过长）带回上层。
 */
const { spawn } = require('child_process');
const paths = require('./paths');
const proxy = require('./proxy');
const { operationId, redact } = require('./errors');
const { recordError } = require('./error-journal');

const DEFAULT_TIMEOUT_MS = 25000;
/**
 * 面板允许调用的 CLI 子命令（白名单）。`rotation`（bind-app / unbind-app / enable / disable /
 * reset-runtime 都会改写 Codex 配置和路由启动项）与 `uninstall` 一律不放行：
 * 10-29 的 bind-app --native 事故就是从面板按钮进来的。新增子命令前先确认它不会写 Codex 配置。
 */
const ALLOWED_SUBCOMMANDS = new Set(['status', 'limits', 'account', 'switch', 'login']);
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * 解析当前该用的代理：环境变量 → panel-config.json 的 proxy → Windows 系统代理。
 * 面板常由桌面端/快捷方式拉起，自身环境没有代理变量，这里兜底才不至于让
 * CLI 的额度探测直连被墙（表现为“刷新额度没反应”）。
 */
function resolvedProxyUrl() {
  return proxy.currentProxyUrl(paths.CONFIG);
}

/** 子进程要继承的代理变量；没有配置就不注入。 */
function processEnvLines() {
  const url = resolvedProxyUrl();
  if (!url) return [];
  const noP = proxy.noProxyList(process.env);
  return [
    'set "HTTP_PROXY=' + url + '"',
    'set "HTTPS_PROXY=' + url + '"',
    'set "http_proxy=' + url + '"',
    'set "https_proxy=' + url + '"',
    'set "NO_PROXY=' + noP + '"',
    'set "no_proxy=' + noP + '"',
    // 关键：Node 只有看到这个变量才会让 fetch 走 HTTP(S)_PROXY。
    'set "NODE_USE_ENV_PROXY=1"',
  ];
}

/**
 * 跑一次 CLI，永不 reject。
 * @param {string[]} args
 * @param {number} [timeout] 毫秒；<=0 回退到默认 25s
 * @returns {Promise<{ok:boolean, code:(number|string), out:string, safeOut:string, error?:string, killed?:boolean, operationId:string}>}
 *   code 在失败时可能是数字退出码，或 'CLI_TIMEOUT' / 'CLI_SPAWN_FAILED' / 'CLI_OUTPUT_LIMIT'。
 */
function runCli(args, timeout = DEFAULT_TIMEOUT_MS) {
  const op = operationId();
  const limit = Number(timeout) > 0 ? Number(timeout) : DEFAULT_TIMEOUT_MS;
  const sub = String((args && args[0]) || '');
  if (!ALLOWED_SUBCOMMANDS.has(sub)) {
    const error = '面板不允许调用 codex-multi-auth ' + (sub || '（空命令）') + '：它可能改写 Codex 配置或路由启动项';
    recordError(new Error(error), 'CLI_FORBIDDEN', op);
    return Promise.resolve({ ok: false, code: 'CLI_FORBIDDEN', out: '', safeOut: '', error, killed: false, operationId: op });
  }
  return new Promise((resolve) => {
    const chunks = [];
    let outputBytes = 0;
    let dropped = false;
    let timedOut = false;
    let finished = false;
    let child;

    function finish(code, error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error === undefined) {
        const out = Buffer.concat(chunks).toString('utf8');
        resolve({ ok: true, code: 0, out, safeOut: redact(out), operationId: op });
        return;
      }
      recordError(error, typeof code === 'string' ? code : (timedOut ? 'CLI_TIMEOUT' : 'CLI_FAILED'), op);
      resolve({
        ok: false,
        code,
        out: Buffer.concat(chunks).toString('utf8'),
        safeOut: redact(Buffer.concat(chunks).toString('utf8')),
        error: error.message || String(error),
        killed: timedOut || dropped,
        operationId: op,
      });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
    }, limit);

    try {
      child = spawn(paths.NODE_EXE, [paths.CLI, ...args], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: Object.assign({}, process.env, proxy.proxyEnv(resolvedProxyUrl(), process.env), paths.PROXY_ENV),
      });
    } catch (e) {
      finish('CLI_SPAWN_FAILED', e);
      return;
    }

    const append = (chunk) => {
      if (dropped) return;
      const buffer = Buffer.from(chunk, 'utf8');
      outputBytes += buffer.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        dropped = true;
        const kept = Math.max(0, MAX_OUTPUT_BYTES - (outputBytes - buffer.length));
        chunks.push(buffer.subarray(0, kept));
        try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
      } else {
        chunks.push(buffer);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.on('error', (e) => finish('CLI_SPAWN_FAILED', e));
    child.on('close', (code, signal) => {
      if (timedOut) {
        finish('CLI_TIMEOUT', new Error('codex-multi-auth CLI 超时（' + limit + 'ms）'));
        return;
      }
      if (dropped) {
        finish('CLI_OUTPUT_LIMIT', new Error('codex-multi-auth CLI 输出超过 ' + MAX_OUTPUT_BYTES + ' 字节'));
        return;
      }
      if (code === 0) {
        finish(0, undefined);
        return;
      }
      const failedCode = code === null || code === undefined ? (signal || 1) : code;
      finish(failedCode, new Error('codex-multi-auth CLI 退出码 ' + failedCode));
    });
  });
}

function shQuote(s) { return '"' + String(s).replace(/"/g, '\\"') + '"'; }

module.exports = { processEnvLines, runCli, shQuote, ALLOWED_SUBCOMMANDS };
