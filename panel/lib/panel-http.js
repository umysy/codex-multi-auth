'use strict';
/**
 * HTTP 层细节：一次性 token、响应封装、请求体解析、本地来源校验、静态文件。
 *
 * 安全边界（contract 测试锁住）：
 *   - 只接受 Host 为 127.0.0.1/localhost/[::1]:PORT 的请求；
 *   - 非 GET 的静态资源与全部 /api/* 需要 x-panel-token 或 panel-token cookie；
 *   - 所有响应 Cache-Control: no-store。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const paths = require('./paths');

const TOKEN = crypto.randomBytes(18).toString('hex');

const JS_TYPE = 'application/javascript; charset=utf-8';
// 前端 ES 模块清单：新增一个模块文件时必须同时登记在这里，否则浏览器 404。
// `panel/test/static-manifest.test.js` 会对照 panel/public 的实际文件检查，漏登记直接失败。
const PUBLIC_MODULES = [
  'format', 'api', 'dom', 'render-overview', 'render-accounts', 'render-panels', 'rotation-editor', 'actions',
];

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', JS_TYPE],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
for (const name of PUBLIC_MODULES) {
  STATIC['/modules/' + name + '.mjs'] = ['modules/' + name + '.mjs', JS_TYPE];
}

function send(res, code, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, headers));
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1e6) { req.destroy(); finish({}); }
    });
    req.on('end', () => { try { finish(raw ? JSON.parse(raw) : {}); } catch { finish({}); } });
    req.on('error', () => finish({}));
    req.on('aborted', () => finish({}));
    req.on('close', () => finish({}));
  });
}

function authed(req) {
  const hdr = req.headers['x-panel-token'];
  if (hdr && hdr === TOKEN) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === 'panel-token=' + TOKEN);
}

/** 防 DNS rebinding：Host 必须是本机回环地址 + 本面板端口。 */
function isLocalHostHeader(h) {
  if (!h) return false;
  const s = String(h).toLowerCase();
  return s === '127.0.0.1:' + paths.PORT || s === 'localhost:' + paths.PORT || s === '[::1]:' + paths.PORT;
}

function originAllowed(req) {
  const o = req.headers.origin;
  if (!o) return true;
  return /^(https?:\/\/)(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(String(o));
}

function isStatic(pathname) { return Boolean(STATIC[pathname]); }

/** 返回 true 表示已响应。index.html 会把一次性 token 注入 meta 标签。 */
function serveStatic(pathname, res) {
  const [file, type] = STATIC[pathname];
  let body = fs.readFileSync(path.join(paths.PUBLIC, file), 'utf8');
  if (file === 'index.html') body = body.replace('__PANEL_TOKEN__', TOKEN);
  send(res, 200, body, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  return true;
}

module.exports = { TOKEN, STATIC, PUBLIC_MODULES, send, readBody, authed, isLocalHostHeader, originAllowed, isStatic, serveStatic };
