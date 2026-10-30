'use strict';
/**
 * 所有路径与环境常量的唯一来源。
 *
 * 约束：只做“读环境、算路径”，不做 I/O、不抛异常。
 * 想改部署位置/端口/启动项路径，只改这一个文件。
 */
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');          // panel/
const PUBLIC = path.join(ROOT, 'public');
const HOME = process.env.USERPROFILE || os.homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const DATA = path.join(CODEX_HOME, 'multi-auth');
// Codex 应用自己的登录态：面板只读展示 + 需要时同步（见 lib/app-auth.js）
const CODEX_AUTH = path.join(CODEX_HOME, 'auth.json');
const APP_BIND = path.join(DATA, 'app-bind');
const STATUS_JSON = path.join(APP_BIND, 'runtime-rotation-app-bind-status.json');
const POLICY_LOG = path.join(DATA, 'quota-policy.log');
const EVENTS_LOG = path.join(DATA, 'panel-events.log');
const ROUTER_LOG = path.join(APP_BIND, 'runtime-rotation-app-router.log');
// 路由由 launcher 拉起，退出码写这里：路由自己往往 0 字节就消失了，靠这个才能知道为什么。
const ROUTER_LAUNCH_LOG = path.join(APP_BIND, 'runtime-rotation-app-router-launch.log');
const ROUTER_WRAPPER = path.join(APP_BIND, 'router-launch.cmd');
// 用 wscript 当脱壳器：它启动 launcher 后立刻退出，路由就不在面板进程树里了。
const ROUTER_VBS = path.join(APP_BIND, 'router-launch.vbs');
const CONFIG = path.join(DATA, 'panel-config.json');
const NODE_EXE = process.execPath;
const CLI = path.join(
  process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'),
  'npm', 'node_modules', 'codex-multi-auth', 'scripts', 'codex-multi-auth.js'
);
const ROUTER_CMD = path.join(
  HOME, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
  'Codex Multi Auth Runtime Router.cmd'
);
const PORT = Number(process.env.PANEL_PORT || 8766);

/* ------------------------------------------------------------ 登录（添加账号） */
const LOGIN_CMD = path.join(DATA, 'panel-open-login.cmd');
const LOGIN_STATE = path.join(DATA, 'panel-login.state');
const LOGIN_TITLE = 'Codex Add Account';
const LOGIN_MAX_MS = 15 * 60 * 1000;
const LOGIN_DRY = process.env.PANEL_LOGIN_DRY === '1';

/* --------------------------------------------------------------- 运行时文件 */
const SCHEDULE_FILE = path.join(DATA, 'quota-policy.state.json');
const ROUTER_STATE_FILE = path.join(DATA, 'panel-router-state.json');
const CACHE_FILE = path.join(DATA, 'panel-cache.json');
const OPERATIONS_LOCK = path.join(DATA, 'account-operations.lock');
const OBSERVABILITY = path.join(DATA, 'runtime-observability.json');
const LIVE_QUOTA = path.join(DATA, 'live-quota.json');
const POLICY_PS1 = path.join(DATA, 'quota-policy.ps1');

/* ------------------------------------------------------------------- 代理 */
// 代理完全跟随环境变量；没有配置就不注入，绝不写死本机端口。
const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  || process.env.https_proxy || process.env.http_proxy || '';
const NO_PROXY_BASE = 'localhost,127.0.0.1,::1';
const PROXY_ENV = PROXY_URL ? {
  HTTP_PROXY: PROXY_URL, HTTPS_PROXY: PROXY_URL,
  http_proxy: PROXY_URL, https_proxy: PROXY_URL,
  NO_PROXY: NO_PROXY_BASE, no_proxy: NO_PROXY_BASE,
} : {};

module.exports = {
  ROOT, PUBLIC, HOME, CODEX_HOME, CODEX_AUTH, DATA, APP_BIND, STATUS_JSON,
  POLICY_LOG, EVENTS_LOG, ROUTER_LOG, ROUTER_LAUNCH_LOG, ROUTER_WRAPPER, ROUTER_VBS, CONFIG, NODE_EXE, CLI, ROUTER_CMD, PORT,
  LOGIN_CMD, LOGIN_STATE, LOGIN_TITLE, LOGIN_MAX_MS, LOGIN_DRY,
  SCHEDULE_FILE, ROUTER_STATE_FILE, CACHE_FILE, OPERATIONS_LOCK, OBSERVABILITY, LIVE_QUOTA, POLICY_PS1,
  PROXY_URL, NO_PROXY_BASE, PROXY_ENV,
};
