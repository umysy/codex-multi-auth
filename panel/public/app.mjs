'use strict';
/**
 * 前端装配层：读状态、渲染、事件委托、轮询。
 * 页面结构在 index.html，样式在 style.css，纯渲染在 modules/render-*.mjs，
 * 网络在 modules/api.mjs，动作在 modules/actions.mjs —— 这里只负责把它们接起来。
 */
import { api } from './modules/api.mjs';
import { els, isBusy, toast, syncBusyButtons } from './modules/dom.mjs';
import { countdown } from './modules/format.mjs';
import { statusPillsHtml, kpisHtml } from './modules/render-overview.mjs';
import { accountsHtml } from './modules/render-accounts.mjs';
import {
  timelineHtml, policyHtml, routerHintText, routerGridHtml, routerActionsHtml,
  footerText, footerErrorText,
} from './modules/render-panels.mjs';
import { initActions, accountAction, noteAction, savePolicy, routerAction, doRefresh, syncAppLogin } from './modules/actions.mjs';
import { moveRule, toggleRotation } from './modules/rotation-editor.mjs';

let state = null;
let lastLoadedAt = 0;
let policyDirty = false;
let stateLoading = false;
let lastPollAt = 0;
document.addEventListener('input', e => { if (els.policy?.contains(e.target)) policyDirty = true; });
document.addEventListener('change', e => {
  if (els.policy?.contains(e.target)) policyDirty = true;
  if (e.target.id === 'rotation-enabled') toggleRotation(selector => document.querySelector(selector));
});

function applyState(next) {
  state = next;
  lastLoadedAt = Date.now();
  render();
  return state;
}

async function loadState(force = false, { silent = false } = {}) {
  if (!force && stateLoading) return state;
  stateLoading = true;
  try {
    const data = await api('/api/state' + (force ? '?force=1' : ''));
    return applyState(data.state);
  } catch (err) {
    if (!silent) toast('读取状态失败：' + err.message, 'err');
    if (els.foot) els.foot.textContent = footerErrorText(err.message);
    throw err;
  } finally { stateLoading = false; }
}

function render() {
  if (!state) return;
  els.status.innerHTML = statusPillsHtml(state);
  els.kpis.innerHTML = kpisHtml(state);
  els.accounts.innerHTML = accountsHtml(state);
  els.timeline.innerHTML = timelineHtml(state);
  if (!policyDirty) els.policy.innerHTML = policyHtml(state);
  els.routerHint.textContent = routerHintText(state);
  els.router.innerHTML = routerGridHtml(state);
  els.routerActions.innerHTML = routerActionsHtml(state);
  els.foot.textContent = footerText(state, lastLoadedAt);
  syncBusyButtons();
}

/** 手动刷新额度：后端把 7 秒的上游查询放到后台，这里拿到“当前 + refreshing”。 */
async function refreshQuota() {
  const data = await api('/api/refresh', { method: 'POST' });
  return applyState(data.state);
}

initActions({
  refresh: () => loadState(true, { silent: true }),
  refreshManual: () => refreshQuota(),
  getState: () => state,
  applyPolicy: policy => {
    if (state) state = { ...state, policy: { ...state.policy, ...policy, rotation: policy.rotation || null } };
  },
});

/* 事件委托：卡片按钮与路由按钮都是动态注入的，只能挂在 document 上 */
document.addEventListener('click', (e) => {
  const moveButton = e.target.closest('[data-rule-move]');
  if (moveButton) { if (!isBusy() && moveRule(moveButton)) policyDirty = true; return; }
  if (e.target.closest('#btn-discard-policy')) {
    if (!isBusy() && (!policyDirty || window.confirm('放弃未保存的策略草稿？'))) { policyDirty = false; render(); }
    return;
  }
  if (e.target.closest('[data-download-diagnostics]')) {
    api('/api/diagnostics').then(data => {
      const href = URL.createObjectURL(new Blob([JSON.stringify(data.diagnostics, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a'); link.href = href; link.download = 'codex-quota-diagnostics.json'; link.click();
      setTimeout(() => URL.revokeObjectURL(href), 1000);
    }).catch(err => toast(err.message, 'err'));
    return;
  }
  const actBtn = e.target.closest('[data-act]');
  if (actBtn) {
    const n = Number(actBtn.dataset.n);
    const action = actBtn.dataset.act;
    if (state?.policy?.rotation && ['reserve', 'unreserve'].includes(action)) {
      els.policy.scrollIntoView({ behavior: 'smooth' });
      toast('请在自定义账户规则中修改角色并保存策略', 'ok'); return;
    }
    if (action === 'note') noteAction(n);
    else accountAction(n, action);
    return;
  }
  const routerBtn = e.target.closest('[data-router]');
  if (routerBtn) { routerAction(routerBtn.dataset.router); return; }
  if (e.target.closest('[data-app-login-sync]')) { syncAppLogin(); return; }
  if (e.target.closest('#btn-save-policy')) savePolicy().then(ok => { if (ok) { policyDirty = false; render(); } });
  if (e.target.closest('#btn-refresh')) doRefresh();
});

els.auto && els.auto.addEventListener('change', () => { if (els.auto.checked) loadState(false, { silent: true }); });

/* 额度环下方的倒计时每秒刷新（只改文本，不重建 DOM） */
setInterval(() => {
  document.querySelectorAll('[data-reset]').forEach((node) => {
    const ts = Number(node.dataset.reset);
    if (!ts) return;
    node.textContent = countdown(ts);
  });
}, 1000);

/* 后台额度刷新期间每秒读取一次本地快照，完成后恢复 15 秒轮询。 */
setInterval(() => {
  if (!els.auto || !els.auto.checked) return;
  if (document.visibilityState !== 'visible') return;
  if (isBusy()) return;
  const interval = state?.meta?.refreshing ? 1000 : 15000;
  if (Date.now() - lastPollAt < interval) return;
  lastPollAt = Date.now();
  loadState(false, { silent: true }).catch(() => {});
}, 1000);

/* boot */
loadState(true).catch(() => {});
