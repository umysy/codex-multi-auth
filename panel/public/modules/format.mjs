'use strict';
/**
 * 纯格式化工具：不碰 DOM、不读全局状态，所以能在 Node 里直接单测。
 * 前端其余模块只通过 import 使用这里的东西，避免"到处手写一遍格式化"。
 */

export function esc(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

export function pct(n) { return Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : 0; }

export function fmtDuration(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60), h = Math.floor(m / 60), d = Math.floor(h / 24);
  if (d > 0) return d + ' 天 ' + (h % 24) + ' 小时';
  if (h > 0) return h + ' 小时 ' + (m % 60) + ' 分';
  return m + ' 分钟';
}

export function fmtClock(ts) {
  if (!ts) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

export function fmtHours(h) {
  if (!Number.isFinite(h) || h <= 0) return '0';
  if (h >= 24) return (h / 24).toFixed(1) + ' 天';
  return h.toFixed(1) + ' 小时';
}

export function fmtTimeShort(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** now 可注入，方便单测需要稳定输出时使用。 */
export function countdown(ts, now = Date.now()) {
  if (!ts) return '无窗口';
  const left = ts - now;
  if (left <= 0) return '已重置';
  return fmtDuration(left) + '后重置';
}

export function fmtErrorAt(ts) {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch (e) { return ''; }
}
