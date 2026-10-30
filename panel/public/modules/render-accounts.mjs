'use strict';
/**
 * 账号卡片区：额度环、角色 chip、每张卡上的操作按钮。
 * 纯函数（state → HTML），按钮只带 data-act/data-n，事件由 app.mjs 统一委托。
 */
import { esc, countdown, pct } from './format.mjs';

export function ringSvg(win) {
  const C = 2 * Math.PI * 21;
  if (!win) {
    return `<div class="ring-wrap"><svg width="54" height="54" viewBox="0 0 54 54">
      <circle class="ring-bg" cx="27" cy="27" r="21" fill="none" stroke-width="5"></circle>
    </svg><div class="ring-center empty">—</div></div>`;
  }
  if (win.expired) {
    // 窗口已重置：百分比仍要显示（这是旧快照的用量），但用灰色环+灰字标出“上一窗口”。
    const rem = pct(win.remaining);
    const offset = C * (1 - rem / 100);
    return `<div class="ring-wrap">
      <svg width="54" height="54" viewBox="0 0 54 54">
        <circle class="ring-bg" cx="27" cy="27" r="21" fill="none" stroke-width="5"></circle>
        <circle class="ring-fg" cx="27" cy="27" r="21" fill="none" stroke="#9aa0a6" stroke-width="5"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
      </svg>
      <div class="ring-center empty">${rem}%</div></div>`;
  }
  const rem = pct(win.remaining);
  const color = rem > 55 ? 'var(--green)' : rem > 25 ? 'var(--amber)' : 'var(--red)';
  const offset = C * (1 - rem / 100);
  return `<div class="ring-wrap">
    <svg width="54" height="54" viewBox="0 0 54 54">
      <circle class="ring-bg" cx="27" cy="27" r="21" fill="none" stroke-width="5"></circle>
      <circle class="ring-fg" cx="27" cy="27" r="21" fill="none" stroke="${color}" stroke-width="5"
        stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"></circle>
    </svg>
    <div class="ring-center">${rem}%</div>
  </div>`;
}

export function roleChip(a) {
  if (a.role === 'reserve') return '<span class="chip reserve">储备号</span>';
  if (a.role === 'paused') return '<span class="chip paused">已暂停</span>';
  return '<span class="chip ready">日常</span>';
}

export function accountsHtml(state) {
  const accounts = state.accounts || [];
  if (!accounts.length) {
    return '<div class="empty-note">没有读到账号，先确认 CLI 与登录状态。</div>';
  }
  return accounts.map((a) => {
    const cls = ['account', a.current ? 'is-current' : '', a.paused ? 'is-idle' : ''].filter(Boolean).join(' ');
    const initial = (a.email || '?').slice(0, 1).toUpperCase();
    const isPinned = !!(state.selection && state.selection.pinned === a.n);
    const chips = [a.current ? '<span class="chip current">使用中</span>' : '', isPinned ? '<span class="chip pinned">已固定</span>' : '', roleChip(a)].join('');
    // 固定（pin）= 手动选中：Codex 运行时只路由到它，它一旦限流就是 503，
    // 所以卡片上要给一个显式的「解除固定」，恢复自动轮转。
    const pinBtn = isPinned ? `<button class="btn btn-sm" data-act="unpin" data-n="${a.n}">解除固定</button>` : '';
    const drain = a.drainPerHour ? a.drainPerHour.toFixed(2) + '%/h' : '—';
    const reauthBtn = a.authRequired ? `<button class="btn btn-sm btn-primary" data-router="login">重新登录</button>` : '';
    const foot = a.paused
      ? [a.emergencyOnly
          ? `<button class="btn btn-sm" data-act="unreserve" data-n="${a.n}">恢复为日常</button>`
          : `<button class="btn btn-sm" data-act="unpause" data-n="${a.n}">恢复使用</button>`]
      : [a.current ? '' : `<button class="btn btn-sm btn-primary" data-act="switch" data-n="${a.n}">切到此号</button>`,
         `<button class="btn btn-sm" data-act="pause" data-n="${a.n}">暂停</button>`,
        `<button class="btn btn-sm" data-act="reserve" data-n="${a.n}">设为储备</button>`,
         pinBtn].join('');
    const footWithAuth = reauthBtn + foot;
    return `<article class="${cls}">
      <div class="acc-head">
        <div class="acc-avatar">${esc(initial)}</div>
        <div class="acc-id">
          <div class="acc-email" title="${esc(a.email || a.label)}">${esc(a.email || a.label || ('账号 ' + a.n))}</div>
          <div class="acc-meta">账号 ${a.n} · ${esc(a.planLabel || a.plan || '')} · ${a.quotaStale ? '额度快照较旧（点刷新额度更新）' : '消耗 ' + drain}</div>
        </div>
        ${chips}
      </div>
      <div class="acc-rings">
        <div class="ring-block">
          ${ringSvg(a.h5)}
          <div class="ring-info">
            <div class="ring-name">5 小时窗口</div>
            <div class="ring-sub" data-reset="${a.h5 ? a.h5.resetAt : ''}">${a.h5 ? esc(countdown(a.h5.resetAt)) : '该账号无 5h 限速'}</div>
          </div>
        </div>
        <div class="ring-block">
          ${ringSvg(a.h7)}
          <div class="ring-info">
            <div class="ring-name">7 天窗口</div>
            <div class="ring-sub" data-reset="${a.h7 ? a.h7.resetAt : ''}">${a.h7 ? esc(countdown(a.h7.resetAt)) : '无数据'}</div>
          </div>
        </div>
      </div>
      <div class="acc-foot">
        <span class="drain">${a.note ? esc(a.note) : (a.reason ? esc(a.reason) : '')}</span>
        ${footWithAuth}
        <button class="btn btn-sm" data-act="note" data-n="${a.n}">备注</button>
      </div>
    </article>`;
  }).join('');
}
