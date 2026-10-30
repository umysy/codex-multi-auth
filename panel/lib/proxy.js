'use strict';
/**
 * proxy.js — 解析 CLI 子进程要用的本地 HTTP 代理。
 *
 * 背景：额度探测在 codex-multi-auth 里走 Node 的 fetch；Node 只有在子进程环境
 * 同时具备 HTTP(S)_PROXY 与 NODE_USE_ENV_PROXY=1 时才会让 fetch 走代理。
 * 面板进程常常由桌面端 / 快捷方式拉起，自身环境里没有代理变量，于是 CLI 直连
 * chatgpt.com 被墙：探测静默失败、额度缓存不更新，面板上「刷新额度」看起来没反应。
 *
 * 因此这里按「环境变量 → panel-config.json 的 proxy → Windows 系统代理」兜底，
 * 并把结果收敛成一组子进程环境变量（含 NODE_USE_ENV_PROXY）。
 *
 * 约束：无第三方依赖；读盘/读注册表都吞异常，解析失败一律当作“没有代理”。
 */
const fs = require('fs');
const { execFileSync } = require('child_process');

const NO_PROXY_BASE = 'localhost,127.0.0.1,::1';
const RESOLVE_TTL_MS = 60 * 1000;

function cleanUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) return '';
  return text.replace(/\/+$/, '');
}

/** 从进程环境取代理（大小写两种写法都认）。 */
function envProxy(env) {
  const e = env || {};
  return cleanUrl(e.HTTPS_PROXY || e.https_proxy || e.HTTP_PROXY || e.http_proxy);
}

/** 从 panel-config.json 的 "proxy" 字段取代理；文件缺失/损坏/字段非法都返回空串。 */
function configProxy(configPath) {
  if (!configPath) return '';
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return cleanUrl(raw && raw.proxy);
  } catch (e) {
    return '';
  }
}

// 系统代理可能是 "host:port"，也可能是 "http=host:port;https=host:port"。
function parseProxyServer(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.indexOf('=') === -1) return cleanUrl('http://' + text);
  const parts = text.split(';').map((s) => s.trim()).filter(Boolean);
  let fallback = '';
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const scheme = part.slice(0, idx).trim().toLowerCase();
    const target = part.slice(idx + 1).trim();
    if (!target) continue;
    if (scheme === 'https' || scheme === 'http') {
      // 本机代理基本都是 HTTP CONNECT：统一按 http:// 交给 curl/fetch。
      const url = cleanUrl('http://' + target);
      if (scheme === 'https') return url;
      fallback = fallback || url;
    }
  }
  return fallback;
}

/** Windows 系统代理（Internet Settings）；非 Windows 或未启用返回空串。 */
function systemProxy(platform, run) {
  const os = platform || process.platform;
  if (os !== 'win32') return '';
  const exec = run || execFileSync;
  const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
  try {
    const enabled = String(exec('reg', ['query', key, '/v', 'ProxyEnable'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }) || '');
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(enabled)) return '';
  } catch (e) {
    return '';
  }
  try {
    const out = String(exec('reg', ['query', key, '/v', 'ProxyServer'], { encoding: 'utf8', windowsHide: true, timeout: 3000 }) || '');
    const match = out.match(/ProxyServer\s+REG_SZ\s+(.+)$/im);
    return match ? parseProxyServer(match[1]) : '';
  } catch (e) {
    return '';
  }
}

/**
 * 解析最终代理地址（按 环境 → 配置 → 系统 的顺序，第一个可用的胜出）。
 * 纯逻辑：系统代理探测函数可注入，便于单测。
 */
function resolveProxyUrl(options) {
  const opts = options || {};
  const fromEnv = envProxy(opts.env || process.env);
  if (fromEnv) return fromEnv;
  const fromConfig = configProxy(opts.configPath);
  if (fromConfig) return fromConfig;
  return systemProxy(opts.platform, opts.run);
}

let cached = null; // { url, at }

/** 带短缓存的解析：避免每次派 CLI 都读一次注册表。 */
function currentProxyUrl(configPath) {
  const now = Date.now();
  if (cached && now - cached.at < RESOLVE_TTL_MS) return cached.url;
  const url = resolveProxyUrl({ configPath });
  cached = { url, at: now };
  return url;
}

/** 合并 NO_PROXY：本机地址永远不走代理，用户配置的额外项去重保留。 */
function noProxyList(env) {
  const e = env || process.env;
  return [NO_PROXY_BASE, e.NO_PROXY || e.no_proxy || '']
    .join(',')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(',');
}

/**
 * 生成交给 CLI 子进程的代理环境变量。
 * NODE_USE_ENV_PROXY=1 是关键：缺了它 Node 的 fetch 不会读 HTTP(S)_PROXY。
 */
function proxyEnv(url, env) {
  const target = cleanUrl(url);
  if (!target) return {};
  const noProxy = noProxyList(env);
  return {
    HTTP_PROXY: target, HTTPS_PROXY: target,
    http_proxy: target, https_proxy: target,
    NO_PROXY: noProxy, no_proxy: noProxy,
    NODE_USE_ENV_PROXY: '1',
  };
}

/** 测试用：清掉解析缓存。 */
function resetCache() {
  cached = null;
}

module.exports = {
  NO_PROXY_BASE,
  cleanUrl,
  envProxy,
  configProxy,
  parseProxyServer,
  systemProxy,
  resolveProxyUrl,
  currentProxyUrl,
  noProxyList,
  proxyEnv,
  resetCache,
};
