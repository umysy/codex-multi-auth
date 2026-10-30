'use strict';
/**
 * 总览区（顶栏状态 pills + 四张 KPI 卡）。
 * 全部是纯函数：吃 state，吐 HTML 字符串，不碰 DOM —— 因此可直接单测。
 */
import { esc, fmtHours, fmtClock, countdown } from './format.mjs';

// 路由器的 lastError 是"粘性"的：写进去就不会自己清空。
// 只要之后又成功处理过请求，就显示为"已恢复"，避免每次都像故障。
export function routerErrBadge(r) {
  if (!r || !r.lastError) return '';
  if (r.errorRecovered) return ' · <span style="color:var(--muted,#8b96a9)">曾重试，已恢复</span>';
  return ' · <span style="color:var(--red)">有错误</span>';
}

export function statusPillsHtml(s) {
  const pills = [];
  const router = s.router || {};
  pills.push(`<span class="pill ${router.running ? 'ok' : 'err'}"><i class="dot"></i>路由 ${router.running ? '运行中' : '未运行'}${router.running && router.pid ? ' · PID ' + esc(router.pid) : ''}</span>`);
  if (s.current) {
    pills.push(`<span class="pill ok"><i class="dot"></i>当前使用 <b>${esc(s.current.email || ('账号 ' + s.current.n))}</b></span>`);
  }
  pills.push(`<span class="pill ${s.selection.available > 0 ? '' : 'warn'}"><i class="dot"></i>可用账号 <b>${s.selection.available}/${s.selection.total}</b></span>`);
  pills.push(`<span class="pill ${s.policy.autoSwitch ? 'ok' : 'warn'}"><i class="dot"></i>自动切号 ${s.policy.autoSwitch ? '开' : '关'} · 阈值 ${s.policy.minWaitMin} 分</span>`);
  (s.errors || []).forEach((e) => pills.push(`<span class="pill err"><i class="dot"></i>${esc(e)}</span>`));
  if (s.runtime && s.runtime.globalIncident) {
    pills.push(`<span class="pill err"><i class="dot"></i>全局运行时故障：${esc(s.runtime.globalIncident)}</span>`);
  } else if (s.runtime && s.runtime.present && !s.runtime.fresh) {
    pills.push(`<span class="pill warn"><i class="dot"></i>运行时观测已过期</span>`);
  }
  const app = s.app || {};
  if (app.loggedInEmail) {
    const same = app.matchesCurrent;
    pills.push(`<span class="pill ${same ? 'ok' : 'warn'}"><i class="dot"></i>应用登录 <b>${esc(app.loggedInEmail)}</b>${same ? '' : ' · 与当前账号不一致'}</span>`);
  }
  return pills.join('');
}

export function kpisHtml(s) {
  const t = s.totals || {};
  const accounts = s.accounts || [];
  const stackColors = ['#22d3ee', '#7c5cff', '#a78bfa', '#34d399', '#fbbf24'];
  const total = accounts.reduce((sum, a) => sum + (a.h7 ? a.h7.remaining : 0), 0) || 1;
  const stack = accounts.map((a, i) => {
    const w = a.h7 ? (a.h7.remaining / total) * 100 : 0;
    return `<span style="width:${w}%;background:${stackColors[i % stackColors.length]}" title="${esc(a.email || '账号 ' + a.n)} · 剩 ${a.h7 ? a.h7.remaining : 0}%"></span>`;
  }).join('');
  const legend = accounts.map((a, i) => `<i><em style="background:${stackColors[i % stackColors.length]}"></em>${esc((a.email || '账号' + a.n).split('@')[0])} ${a.h7 ? a.h7.remaining + '%' : '—'}</i>`).join('');

  const cur = s.current;
  const h5 = cur && cur.h5 ? cur.h5.remaining : null;
  const drain = Number(t.drainPerHour) || 0;

  return [
    `<div class="kpi">
      <div class="kpi-label">本周总剩余</div>
      <div class="kpi-value">${Math.round(t.weekRemaining || 0)}<small>%</small></div>
      <div class="kpi-sub">按单账号周额度折算 · 共 ${accounts.length} 个账号</div>
      <div class="stackbar">${stack}</div>
      <div class="stack-legend">${legend}</div>
    </div>`,
    `<div class="kpi">
      <div class="kpi-label">预计还能撑</div>
      <div class="kpi-value">${esc(fmtHours(t.hoursLeft))}</div>
      <div class="kpi-sub">当前 ${drain.toFixed(2)}%/h${t.withinBudget ? ' · <span style="color:var(--green)">在预算内</span>' : ' · <span style="color:var(--amber)">超出预算线</span>'} · 见底约 <b>${t.darkAt ? fmtClock(t.darkAt) : '—'}</b></div>
      <div class="kpi-sub">预算线 1.5%/h（36%/天）→ 可撑到 <b>${t.budgetDarkAt ? fmtClock(t.budgetDarkAt) : '—'}</b></div>
    </div>`,
    `<div class="kpi">
      <div class="kpi-label">当前 5 小时窗口</div>
      <div class="kpi-value">${h5 == null ? '—' : h5 + '<small>%</small>'}</div>
      <div class="kpi-sub">${cur ? esc(cur.email || ('账号 ' + cur.n)) : '无可用账号'}${cur && cur.h5 ? ' · ' + esc(countdown(cur.h5.resetAt)) : ''}</div>
    </div>`,
    `<div class="kpi">
      <div class="kpi-label">路由</div>
      <div class="kpi-value">${s.router && s.router.running ? '在线' : '离线'}</div>
      <div class="kpi-sub">请求 <b>${s.router ? s.router.requests : 0}</b> · 轮转 <b>${s.router ? s.router.rotations : 0}</b>${routerErrBadge(s.router)}</div>
    </div>`,
  ].join('');
}
