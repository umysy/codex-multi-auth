'use strict';
/**
 * 与后端通信的唯一入口：一次性 token、选择器、fetch 信封解包。
 * 设计：所有 /api 调用都经过这里，错误统一抛 Error，调用方只处理提示。
 * 注意：顶层不依赖 DOM 一定存在，这样同一批模块可以在 Node 里被单测直接 import。
 */

const doc = typeof document !== 'undefined' ? document : null;

export const TOKEN = (doc && doc.querySelector('meta[name="panel-token"]') || {}).content || '';

export const $ = (sel, root) => {
  const scope = root || doc;
  return scope ? scope.querySelector(sel) : null;
};

export async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: Object.assign({ 'x-panel-token': TOKEN }, options.body ? { 'Content-Type': 'application/json' } : {}),
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({ ok: false, error: '响应解析失败' }));
  if (!res.ok || data.ok === false) throw new Error((data.error || data.message || ('HTTP ' + res.status)) + (data.code ? ' [' + data.code + ']' : '') + (data.operationId ? ' #' + data.operationId : ''));
  return data;
}
