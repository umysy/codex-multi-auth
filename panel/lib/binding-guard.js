'use strict';
/**
 * app-bind 与 Codex 配置（config.toml）的一致性守卫。
 *
 * 事故复盘：app-login 流程会用临时 CODEX_HOME 起一个隔离 router，并在绑定期间改写真实
 * `~/.codex/config.toml`（model_providers 的 base_url 与 experimental_bearer_token）。
 * 如果流程被中途打断（关窗口 / 测试进程被 kill / 面板重启），配置会停留在临时 router 的
 * 端口与 token 上；临时 router 随后留在 %TEMP%\cma-app-login-* 里变成孤儿进程。
 * 用户侧表现：Codex 一直 503 "All managed Codex accounts are temporarily unavailable"，
 * 因为它连的是那个已经不该再被使用的临时 router。
 *
 * 这里只做两件事，都基于「本机 app-bind 状态」这个唯一可信来源：
 *   1) 配置与 app-bind 不一致（且 app-bind 端口确实在监听）→ 备份后回写；
 *   2) 清理挂在临时 app-login home 上的孤儿 router 与其临时目录。
 *
 * 纯判断函数单独导出，单测不用起进程、也不用碰真实 ~/.codex。
 */
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const paths = require('./paths');
const { readJson } = require('./fs-json');
const { appendPolicyLine } = require('./events');
const { readProxyAccounts } = require('./proxy-accounts');

const PROVIDER = 'codex-multi-auth-runtime-proxy';
const LOGIN_TMP_PREFIX = 'cma-app-login-';
/** 临时 router 存活超过这个时间仍未结束，就按泄漏处理（登录窗口本身 15 分钟超时）。 */
const TEMP_ROUTER_MAX_MS = 15 * 60 * 1000;
const PORT_PROBE_MS = 600;
const CONFIG_BACKUP_KEEP = 5;

function bindPath() { return path.join(paths.APP_BIND, 'runtime-rotation-app-bind.json'); }
function configPath() { return path.join(paths.CODEX_HOME, 'config.toml'); }

/** 转义正则元字符（provider 名固定，但保持函数通用）。 */
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** 取出 `[model_providers.<name>]` 段文本；没有该段时返回 null。 */
function providerSection(configText, provider) {
  const re = new RegExp('\\[model_providers\\.' + escapeRe(provider || PROVIDER) + '\\]([\\s\\S]*?)(?=\\n\\s*\\[|\\s*$)');
  const m = re.exec(String(configText || ''));
  return m ? m[1] : null;
}

/**
 * 纯函数：config 与 app-bind 是否不一致。
 * 返回 { needed, reason }。缺 app-bind 或 config 里没有本插件段时一律不动
 * （没有可信目标，猜着改只会把问题弄大）。
 */
function needsProviderRepair(configText, bind) {
  if (!bind || !bind.port || !bind.clientApiKey) return { needed: false, reason: 'no-bind' };
  const section = providerSection(configText, PROVIDER);
  if (section === null) return { needed: false, reason: 'no-provider-section' };
  const expectedBase = 'http://127.0.0.1:' + bind.port;
  const top = /^\s*openai_base_url\s*=\s*"([^"]*)"/m.exec(String(configText || ''));
  const base = /^\s*base_url\s*=\s*"([^"]*)"/m.exec(section);
  const token = /^\s*experimental_bearer_token\s*=\s*"([^"]*)"/m.exec(section);
  if (top && top[1] !== expectedBase) return { needed: true, reason: 'top-openai_base_url' };
  if (!base || base[1] !== expectedBase) return { needed: true, reason: 'provider-base_url' };
  if (!token || token[1] !== bind.clientApiKey) return { needed: true, reason: 'provider-token' };
  return { needed: false, reason: 'ok' };
}

/**
 * 纯函数：把 config 文本回写成 app-bind 的目标值（只动工具自己写过的那三行）。
 * 找不到目标行时原样返回，绝不凭猜测插入新段。
 */
function applyProviderRepair(configText, bind) {
  const text = String(configText || '');
  const expectedBase = 'http://127.0.0.1:' + bind.port;
  let out = text.replace(/^(\s*openai_base_url\s*=\s*")[^"]*(")/m, '$1' + expectedBase + '$2');
  const section = providerSection(out, PROVIDER);
  if (section === null) return out;
  const fixedSection = section
    .replace(/^(\s*base_url\s*=\s*")[^"]*(")/m, '$1' + expectedBase + '$2')
    .replace(/^(\s*experimental_bearer_token\s*=\s*")[^"]*(")/m, '$1' + bind.clientApiKey + '$2');
  out = out.slice(0, sectionStart(out)) + fixedSection + out.slice(sectionStart(out) + section.length);
  return out;
}

function sectionStart(text) {
  const m = new RegExp('\\[model_providers\\.' + escapeRe(PROVIDER) + '\\]').exec(String(text || ''));
  return m ? m.index + m[0].length : -1;
}

/** 端口是否在监听（只探本机回环，超时很短）。 */
function isListening(port) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const sock = net.connect({ host: '127.0.0.1', port: Number(port) });
      sock.setTimeout(PORT_PROBE_MS);
      sock.once('connect', () => { try { sock.destroy(); } catch (e) { /* ignore */ } finish(true); });
      sock.once('timeout', () => { try { sock.destroy(); } catch (e) { /* ignore */ } finish(false); });
      sock.once('error', () => finish(false));
    } catch (e) { finish(false); }
  });
}

/** 备份当前 config.toml，只保留最近 5 份。返回备份路径；失败返回 null。 */
function backupConfig(configFile) {
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const dst = configFile + '.bak-' + stamp;
    fs.copyFileSync(configFile, dst);
    try {
      const dir = path.dirname(configFile);
      const backups = fs.readdirSync(dir)
        .filter((n) => n.indexOf(path.basename(configFile) + '.bak-') === 0)
        .sort();
      for (const old of backups.slice(0, Math.max(0, backups.length - CONFIG_BACKUP_KEEP))) {
        try { fs.unlinkSync(path.join(dir, old)); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    return dst;
  } catch (e) { return null; }
}

/**
 * 检查并修复 config.toml：
 *   - app-bind 端口必须真的在监听（路由器活着）才动手，避免把一个坏目标写进配置；
 *   - 先备份再写；写入失败时保留备份路径方便人工回滚。
 */
async function ensureProviderConfig(deps) {
  const d = deps || {};
  // 测试套件（scripts/test.js 会设 CMA_TEST_MODE=1）里的面板进程跑在临时 CODEX_HOME 上，
  // 守卫在这里既没有意义又会抢 PowerShell/进程枚举的开销，直接跳过；单测用 deps.force 覆盖。
  if (d.force !== true && process.env.CMA_TEST_MODE === '1') return { ok: true, repaired: false, reason: 'test-mode' };
  const bindFile = d.bindPath || bindPath();
  const cfgFile = d.configPath || configPath();
  const bind = readJson(bindFile, null);
  if (!bind || !bind.port || !bind.clientApiKey) return { ok: true, repaired: false, reason: 'no-bind' };
  let text = '';
  try { text = fs.readFileSync(cfgFile, 'utf8'); } catch (e) { return { ok: true, repaired: false, reason: 'no-config' }; }
  const verdict = needsProviderRepair(text, bind);
  if (!verdict.needed) return { ok: true, repaired: false, reason: verdict.reason };
  const listening = d.listening === undefined ? await isListening(bind.port) : Boolean(d.listening);
  if (!listening) return { ok: true, repaired: false, reason: 'bind-port-down', mismatch: verdict.reason };
  const backed = backupConfig(cfgFile);
  if (!backed) {
    return { ok: false, repaired: false, reason: 'backup-failed', mismatch: verdict.reason };
  }
  const next = applyProviderRepair(text, bind);
  try {
    fs.writeFileSync(cfgFile, next, 'utf8');
  } catch (e) {
    return { ok: false, repaired: false, reason: 'write-failed', error: String(e) };
  }
  const log = d.log || ((msg) => appendPolicyLine('GUARD', msg));
  try { log('Codex 配置指向了别的本地 router（' + verdict.reason + '），已按 app-bind 备份并回写'); } catch (e) { /* ignore */ }
  return { ok: true, repaired: true, reason: verdict.reason, backup: backed };
}

/* ------------------------------------------------------------------ 显示名 */
/*
 * Codex 桌面版侧栏底部（设置菜单标题）的文字：应用不是 ChatGPT 登录时显示
 * `model_providers.<model_provider>.name`（应用包里 CNn() 的逻辑）。本工具用自带 token 走路由，
 * 所以那里一直是 "codex-multi-auth"。把它同步成当前账号，切号后 Codex 下次读配置就会跟着变。
 * name 只是显示用，不影响路由、鉴权；只改这一行，不备份（不然每次切号都多一份 config.toml.bak）。
 */

/** 纯函数：账号库 → 显示名。没有可用账号时返回 null（保持原样，不猜）。 */
function providerLabel(info) {
  if (!info || !info.ok || !Array.isArray(info.accounts) || info.accounts.length === 0) return null;
  const current = info.accounts[info.activeIndex];
  if (!current) return null;
  const no = '账号' + (Number(current.index) + 1);
  const email = String(current.email || '').trim();
  return email ? no + ' · ' + email : no;
}

function tomlString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** 纯函数：把 provider 段里已有的 name 行改成 label；没有该段或该行时原样返回。 */
function applyProviderName(configText, label) {
  const text = String(configText || '');
  const section = providerSection(text, PROVIDER);
  if (section === null || !label) return text;
  const fixed = section.replace(/^(\s*name\s*=\s*)(?:"(?:[^"\\]|\\.)*"|'[^']*')/m, (all, head) => head + tomlString(label));
  if (fixed === section) return text;
  const start = sectionStart(text);
  return text.slice(0, start) + fixed + text.slice(start + section.length);
}

/**
 * 让 Codex 显示的 provider 名跟随当前账号。只在名字确实变化时写盘（临时文件 + 改名）。
 * 返回 { ok, changed, reason }。
 */
function ensureProviderLabel(deps) {
  const d = deps || {};
  if (d.force !== true && process.env.CMA_TEST_MODE === '1') return { ok: true, changed: false, reason: 'test-mode' };
  const cfgFile = d.configPath || configPath();
  const label = providerLabel(d.accounts || readProxyAccounts(d.accountsFile));
  if (!label) return { ok: true, changed: false, reason: 'no-account' };
  let text = '';
  try { text = fs.readFileSync(cfgFile, 'utf8'); } catch (e) { return { ok: true, changed: false, reason: 'no-config' }; }
  const next = applyProviderName(text, label);
  if (next === text) return { ok: true, changed: false, reason: providerSection(text, PROVIDER) === null ? 'no-provider-section' : 'same' };
  const tmp = cfgFile + '.label-tmp';
  try {
    // 读改写之间 Codex 可能自己写过配置：再读一次，变了就放弃本轮（下一轮再来）。
    if (fs.readFileSync(cfgFile, 'utf8') !== text) return { ok: true, changed: false, reason: 'raced' };
    fs.writeFileSync(tmp, next, 'utf8');
    fs.renameSync(tmp, cfgFile);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ }
    return { ok: false, changed: false, reason: 'write-failed', error: String(e) };
  }
  const log = d.log || ((msg) => appendPolicyLine('LABEL', msg));
  try { log('Codex 侧栏显示的账号已同步为' + label.split(' · ')[0]); } catch (e) { /* ignore */ }
  return { ok: true, changed: true, reason: 'updated', label };
}

/**
 * 纯函数：从进程快照里挑出孤儿 app-login router 的 pid。
 * 只认「命令行同时含 codex-app-router.js 与临时 app-login 目录」的进程，
 * 生产 router（真实 ~/.codex）与别的 node 进程都不会被误杀。
 */
function pickOrphanRouters(processes, loginHomePrefix) {
  const prefix = loginHomePrefix || LOGIN_TMP_PREFIX;
  const out = [];
  for (const p of processes || []) {
    const cmd = String((p && p.commandLine) || '');
    if (!cmd) continue;
    if (cmd.indexOf('codex-app-router.js') < 0) continue;
    if (cmd.indexOf(prefix) < 0) continue;
    const pid = Number(p.pid);
    if (Number.isFinite(pid) && pid > 0) out.push(pid);
  }
  return out;
}

/** CIM 时间（PS 5.1 的 /Date(ms)/ 或 ISO 字符串）→ 毫秒时间戳；解析不了返回 0。 */
function cimTimeMs(value) {
  if (typeof value === 'number') return value;
  const text = String(value === null || value === undefined ? '' : value);
  const m = text.match(/\/Date\((\d+)\)\//);
  if (m) return Number(m[1]);
  const t = Date.parse(text);
  return Number.isFinite(t) ? t : 0;
}

/** 列出当前所有 node 进程的 pid + 命令行（一次 PowerShell 调用，失败返回空数组）。 */
function listNodeProcesses() {
  return new Promise((resolve) => {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Select-Object ProcessId,ParentProcessId,CreationDate,CommandLine | ConvertTo-Json -Compress";
    try {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000 }, (err, stdout) => {
        if (err) return resolve([]);
        try {
          const j = JSON.parse(String(stdout || '[]').trim() || '[]');
          const arr = Array.isArray(j) ? j : [j];
          return resolve(arr.map((x) => ({
              pid: x.ProcessId,
              parentPid: x.ParentProcessId,
              startedAtMs: cimTimeMs(x.CreationDate),
              commandLine: x.CommandLine,
            })));
        } catch (e) { return resolve([]); }
      });
    } catch (e) { resolve([]); }
  });
}

function isPidAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return false; }
}

function killPid(pid) {
  return new Promise((resolve) => {
    execFile('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
  });
}

/**
 * 清理孤儿 app-login router：杀掉进程，再删掉它对应的临时 home。
 * 临时目录只在确实没有存活的 router 指向它时才删。
 */
async function sweepOrphanRouters(deps) {
  const d = deps || {};
  if (d.force !== true && process.env.CMA_TEST_MODE === '1') return { killed: 0, removedDirs: 0, skipped: 'test-mode' };
  const tmpRoot = d.tmpRoot || os.tmpdir();
  const processes = d.processes || await listNodeProcesses();
  const nowMs = Number.isFinite(Number(d.nowMs)) ? Number(d.nowMs) : Date.now();
  const livePids = new Set((processes || []).map((p) => Number(p && p.pid)).filter((n) => Number.isFinite(n)));
  const victims = pickOrphanRouters(processes, LOGIN_TMP_PREFIX).filter((pid) => {
    // 正常进行中的 app-login bind 由它的父进程（login CLI）掌管；父进程还在、
    // 存活时间也在宽限期内，就保留它。除此之外的临时 router 都是泄漏。
    const proc = (processes || []).find((p) => Number(p && p.pid) === pid) || null;
    const cmd = String((proc && proc.commandLine) || '');
    const match = cmd.match(/(?:--status|--status-file)\s+(?:"([^"]+)"|'([^']+)'|(\S+))/i);
    const statusPath = match ? (match[1] || match[2] || match[3]) : '';
    const status = statusPath && /runtime-rotation-app-bind-status\.json$/i.test(statusPath)
      ? readJson(statusPath, null) : null;
    const live = status && Number(status.pid) === pid && status.running !== false;
    if (!live) return true;
    const startedAt = proc && Number(proc.startedAtMs);
    const ageMs = Number.isFinite(startedAt) && startedAt > 0 ? nowMs - startedAt : null;
    if (ageMs !== null && ageMs > TEMP_ROUTER_MAX_MS) return true;
    const parentPid = Number(proc && proc.parentPid);
    const parentKnown = Number.isFinite(parentPid) && parentPid > 0 && parentPid !== pid;
    const parentAlive = parentKnown && (livePids.has(parentPid) || isPidAlive(parentPid));
    return !parentAlive;
  });
  // 测试注入 d.kill：测试里的 pid 是编的，交给真实 taskkill 会杀掉本机碰巧占用该 pid 的进程。
  const kill = d.kill || killPid;
  for (const pid of victims) await kill(pid);
  let removedDirs = 0;
  try {
    const dirs = fs.readdirSync(tmpRoot).filter((n) => n.indexOf(LOGIN_TMP_PREFIX) === 0);
    for (const name of dirs) {
      const dir = path.join(tmpRoot, name);
      const status = readJson(path.join(dir, 'multi-auth', 'app-bind', 'runtime-rotation-app-bind-status.json'), null);
      const pid = status && Number(status.pid);
      // 没有 router 状态文件的临时 home 可能是正在进行的登录/测试沙箱，绝不动它。
      if (!pid) continue;
      // 活着的、且不在本次受害者名单里的 router：说明它还在用这个 home，跳过。
      if (victims.indexOf(pid) < 0 && isPidAlive(pid)) continue;
      try { fs.rmSync(dir, { recursive: true, force: true }); removedDirs += 1; } catch (e) { /* 在用时跳过 */ }
    }
  } catch (e) { /* ignore */ }
  if (victims.length || removedDirs) {
    const log = d.log || ((msg) => appendPolicyLine('GUARD', msg));
    try { log('清理孤儿 app-login router：进程 ' + victims.length + ' 个，临时目录 ' + removedDirs + ' 个'); } catch (e) { /* ignore */ }
  }
  return { killed: victims.length, removedDirs };
}

module.exports = {
  PROVIDER,
  LOGIN_TMP_PREFIX,
  providerSection,
  needsProviderRepair,
  applyProviderRepair,
  ensureProviderConfig,
  providerLabel,
  applyProviderName,
  ensureProviderLabel,
  pickOrphanRouters,
  sweepOrphanRouters,
  isListening,
  backupConfig,
};
