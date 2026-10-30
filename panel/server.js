'use strict';
/**
 * Codex Quota Panel — 本地控制台入口。
 *
 * 这里只剩“装配”：HTTP 服务 + 路由分发 + 启动。业务逻辑都在 panel/lib/ 下：
 *   paths.js          路径/端口/代理常量
 *   panel-http.js     一次性 token、信封、静态文件、本机来源校验
 *   dashboard.js      状态快照读模型（缓存 + CLI 聚合）
 *   routes.js         /api/* 路由表
 *   router-control.js 路由进程观察/启停/自愈
 *   login-flow.js     「添加账号」窗口生命周期
 *   policy-store.js   策略配置与脚本状态读写
 *   watchdogs.js      后台定时器
 */
const http = require('http');
const paths = require('./lib/paths');
const { send, authed, isLocalHostHeader, originAllowed, isStatic, serveStatic } = require('./lib/panel-http');
const { getState, loadCache } = require('./lib/dashboard');
const { ensureRouterCmd } = require('./lib/router-control');
const { ensureProviderConfig, sweepOrphanRouters } = require('./lib/binding-guard');
const { withLock } = require('./lib/operation-lock');
const { handleApi } = require('./lib/routes');
const { startWatchdogs } = require('./lib/watchdogs');
const { recordError } = require('./lib/error-journal');
const { cleanupRuntimeFiles } = require('./lib/retention');

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://127.0.0.1');
  } catch (e) {
    return send(res, 400, { ok: false, error: 'bad request' });
  }
  const pathname = url.pathname;

  try {
    if (req.method === 'GET' && pathname === '/favicon.ico') return send(res, 204, '');
    if (!isLocalHostHeader(req.headers.host)) return send(res, 403, { ok: false, error: 'forbidden host' });
    if (!originAllowed(req)) return send(res, 403, { ok: false, error: 'forbidden origin' });
    if (req.method === 'GET' && isStatic(pathname)) return serveStatic(pathname, res);
    if (!authed(req)) return send(res, 401, { ok: false, error: 'unauthorized' });

    if (await handleApi(req, res, pathname, url)) return undefined;
    return send(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    return send(res, err.status || 500, recordError(err));
  }
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    try { send(res, 500, recordError(err)); } catch (e) { /* ignore */ }
  });
});

startWatchdogs();
loadCache();
cleanupRuntimeFiles();
setInterval(cleanupRuntimeFiles, 15 * 60 * 1000).unref();
server.listen(paths.PORT, '127.0.0.1', () => {
  console.log(`Codex Quota Panel -> http://127.0.0.1:${paths.PORT}/`);
  const guard = ensureRouterCmd();
  if (guard.repaired) console.log('router startup script repaired from app-bind config');
  // Codex 配置/孤儿 app-login router 守卫：修被中途打断的 app-bind，清理临时 router 进程。
  withLock(async () => {
    await ensureProviderConfig();
    await sweepOrphanRouters();
  }).catch(() => {});
  getState(false).catch(() => {});
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') { console.log('panel already running on ' + paths.PORT); process.exit(0); }
  console.error(err);
  process.exit(1);
});
