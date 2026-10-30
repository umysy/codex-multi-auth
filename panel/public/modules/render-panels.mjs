'use strict';
/**
 * 左右下三块面板：事件时间线、策略表单、路由状态与动作、页脚。
 * 同样只做 state → HTML/文本，交互留给 app.mjs 的事件委托。
 */
import { esc, clamp, fmtTimeShort, fmtClock, fmtErrorAt } from './format.mjs';
import { rotationEditorHtml } from './rotation-editor.mjs';

export const KIND_MAP = {
  SWITCH: ['k-switch', 'SWITCH'], LIMIT: ['k-limit', 'LIMIT'], WAIT: ['k-wait', 'WAIT'],
  DEAD: ['k-dead', 'DEAD'], ERROR: ['k-error', 'ERROR'], OK: ['k-ok', 'OK'],
  GUARD: ['k-guard', 'GUARD'], DISABLED: ['k-disabled', 'DISABLED'], ROUTER: ['k-router', 'ROUTER'],
  INFO: ['', 'INFO'], PLAN: ['', 'PLAN'],
};

export function timelineHtml(state) {
  const logs = state.logs || [];
  if (!logs.length) {
    return '<div class="empty-note">还没有事件记录，策略脚本每 5 分钟运行一次。</div>';
  }
  return logs.map((e) => {
    const key = String(e.kind || '').toUpperCase();
    const [cls, text] = KIND_MAP[key] || ['', key.slice(0, 8) || 'INFO'];
    const msg = String(e.msg || '').replace(/^[A-Z_]+\s*/, '');
    return `<div class="tl-row">
      <div class="tl-time">${esc(String(e.at || '').slice(11))}</div>
      <div class="tl-kind ${cls}">${esc(text)}</div>
      <div class="tl-msg">${esc(msg)}</div>
    </div>`;
  }).join('');
}

export function policyHtml(state) {
  const p = state.policy || {};
  const accounts = state.accounts || [];
  const options = accounts.map((a) => `<option value="${a.n}" ${Number(p.reserveIndex) === a.n ? 'selected' : ''}>${esc(a.email || ('账号 ' + a.n))}</option>`).join('');
  const maxW = p.maxMinWait || 180;
  const fill = ((clamp(p.minWaitMin, 5, maxW) - 5) / (maxW - 5)) * 100;
  return `
    <div class="row">
      <div>
        <div class="row-label">自动切号</div>
        <div class="row-hint">关闭后策略脚本只记录、不执行切号</div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="pol-auto" ${p.autoSwitch ? 'checked' : ''}>
        <span class="track"><span class="knob"></span></span>
      </label>
    </div>
    <div class="row" style="display:block">
      <div class="row" style="margin-bottom:6px">
        <div class="row-label">5h 耗尽后等待阈值</div>
        <div class="row-value" id="pol-wait-val">${p.minWaitMin} 分钟</div>
      </div>
      <input type="range" id="pol-wait" min="5" max="${p.maxMinWait || 180}" step="5" value="${p.minWaitMin}" style="--fill:${fill}%" ${p.rotation ? 'disabled' : ''}>
      <div class="row-hint">距 5h 重置小于该值就等着，不切号（切号会重读上下文，很贵）</div>
    </div>
    <div class="row">
      <div>
        <div class="row-label">储备号</div>
        <div class="row-hint">只在日常号全部耗尽时启用</div>
      </div>
      <select id="pol-reserve" ${p.rotation ? 'disabled' : ''}>${options}</select>
    </div>
    <div class="row" style="justify-content:flex-end">
      <button class="btn" data-download-diagnostics>下载脱敏诊断</button>
      <button class="btn btn-primary" id="btn-save-policy">保存策略</button>
      <button class="btn" id="btn-discard-policy">放弃草稿</button>
    </div>
    ${rotationEditorHtml(state)}`;
}

export function routerHintText(state) {
  const r = state.router || {};
  return r.port ? '127.0.0.1:' + r.port : '';
}

export function routerGridHtml(state) {
  const r = state.router || {};
  const v = (val, cls = '') => `<div class="v ${cls}">${esc(val)}</div>`;
  return `
    <div class="router-grid">
      <div class="router-cell"><div class="k">状态</div>${v(r.running ? '运行中' : '未运行', r.running ? 'good' : 'bad')}</div>
      <div class="router-cell"><div class="k">端口</div>${v(r.port || '—')}</div>
      <div class="router-cell"><div class="k">总请求</div>${v(r.requests || 0)}</div>
      <div class="router-cell"><div class="k">上游请求</div>${v(r.upstream || 0)}</div>
      <div class="router-cell"><div class="k">轮转次数</div>${v(r.rotations || 0)}</div>
      <div class="router-cell"><div class="k">重试次数</div>${v(r.retries || 0)}</div>
    </div>
    ${r.lastError ? `<div class="router-note" style="color:${r.errorRecovered ? 'var(--muted,#8b96a9)' : 'var(--red)'}">最近错误${r.lastErrorAt ? '（' + fmtErrorAt(r.lastErrorAt) + '）' : ''}：${esc(routerErrorText(r.lastError))}${r.errorRecovered ? ' · 后续请求已成功，属陈旧记录（重启路由即清空）' : ''}</div>` : '<div class="router-note">最近没有错误。</div>'}
    ${r.lastAccountIndex ? `<div class="router-note">最近一次使用：账号 ${r.lastAccountIndex}</div>` : ''}`;
}

export function routerErrorText(error) {
  const value = String(error || '');
  if (value === 'upstream-transport:timeout') return '上游连接超时，所有可用账号重试后仍未返回';
  if (value.startsWith('upstream-transport:')) return `上游连接失败（${value.slice('upstream-transport:'.length)}），已尝试其他可用账号`;
  if (value === 'fetch failed') return '上游连接失败，已尝试其他可用账号';
  if (value.startsWith('model-capacity-midstream:')) return `模型容量不足（${value.slice('model-capacity-midstream:'.length)}，输出中途），已断开让 Codex 自动重试`;
  if (value.startsWith('model-capacity:')) return `模型容量不足（${value.slice('model-capacity:'.length)}），已自动换账号/等待后重试`;
  return value;
}

export function routerActionsHtml() {
  return `
    <button class="btn" data-router="restart">重启路由</button>
    <button class="btn" data-router="rebind">重新绑定</button>
    <button class="btn" data-app-login-sync>同步应用登录</button>
    <button class="btn btn-primary" data-router="login">添加账号</button>`;
}

export function footerText(state, lastLoadedAt) {
  const at = lastLoadedAt ? fmtTimeShort(lastLoadedAt) : '—';
  const t = state.totals || {};
  const alert = (state.alerts || [])[0];
  return `读取于 ${at} · 每周预算线 ${(36).toFixed(0)}%/天 · 预计耗尽 ${t.darkAt ? fmtClock(t.darkAt) : '—'}${alert ? ' · ' + alert : ''}`;
}

export function footerErrorText(msg) {
  return '读取失败：' + msg;
}
