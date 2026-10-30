'use strict';
/**
 * 业务动作：账号操作、策略保存、路由操作、手动刷新。
 * 所有外部依赖通过 initActions() 注入：
 *   - api / query：与后端、DOM 的边界（测试里换成假实现，就能在 Node 里跑完全部请求与错误分支）
 *   - toast / setBusy / isBusy / confirmModal / promptModal：界面反馈
 *   - refresh / refreshManual / getState：读状态与刷新（由 app.mjs 提供，避免循环 import）
 *   - schedule：定时器（login 后延迟刷新），测试注入假实现即可断言"4 秒后刷新"
 */
import { $, api as defaultApi } from './api.mjs';
import { collectRotation } from './rotation-editor.mjs';
import {
  toast as defaultToast,
  setBusy as defaultSetBusy,
  isBusy as defaultIsBusy,
  confirmModal as defaultConfirm,
  promptModal as defaultPrompt,
} from './dom.mjs';

const deps = {
  api: defaultApi,
  query: $,
  toast: defaultToast,
  setBusy: defaultSetBusy,
  isBusy: defaultIsBusy,
  confirmModal: defaultConfirm,
  promptModal: defaultPrompt,
  schedule: (fn, ms) => setTimeout(fn, ms),
  applyPolicy: () => {},
};

let refresh = async () => {};        // 静默刷新（动作用，失败不重复提示）
let refreshManual = null;            // 手动刷新（失败要在页脚/弹窗里提示）
let getState = () => null;
async function refreshAfterAction() {
  try { await refresh(); }
  catch { deps.toast('操作已完成，状态暂未更新，请稍后刷新', 'err'); }
}

export function initActions(overrides = {}) {
  if ('refresh' in overrides) refresh = overrides.refresh || (async () => {});
  if ('refreshManual' in overrides) refreshManual = overrides.refreshManual || null;
  if ('getState' in overrides) getState = overrides.getState || (() => null);
  for (const key of ['api', 'query', 'toast', 'setBusy', 'isBusy', 'confirmModal', 'promptModal', 'schedule', 'applyPolicy']) {
    if (key in overrides && typeof overrides[key] === 'function') deps[key] = overrides[key];
  }
  return deps;
}

const ACTION_LABELS = { switch: '切到此账号', pause: '暂停该账号', unpause: '恢复该账号', reserve: '设为储备号', unreserve: '恢复为日常号', unpin: '解除固定', note: '保存备注' };

export function actionPrompt(action, n) {
  const state = getState() || {};
  const acc = (state.accounts || []).find((a) => a.n === n);
  const who = acc ? (acc.email || ('账号 ' + n)) : ('账号 ' + n);
  if (action === 'switch') return `把运行中的请求切到 ${who}？正在跑的任务可能中断。`;
  if (action === 'pause') return `暂停 ${who}，之后轮转不会再选它。`;
  if (action === 'reserve') return `把 ${who} 设为储备号：暂停日常轮转，只在其他账号全部耗尽时启用。`;
  if (action === 'unpause') return `恢复 ${who} 参与日常轮转。`;
  if (action === 'unreserve') return `把 ${who} 恢复为日常号并重新启用。`;
  if (action === 'unpin') return `解除 ${who} 的固定，恢复自动轮转。被固定的账号一旦限流，请求会直接 503。`;
  return '';
}

async function accountActionImpl(n, action, value) {
  const ok = action === 'note' ? true : await deps.confirmModal(ACTION_LABELS[action] || action, actionPrompt(action, n), true);
  if (!ok) return false;
  deps.setBusy(true);
  try {
    const data = await deps.api('/api/account', { method: 'POST', body: { n, action, value } });
    deps.toast(((data && data.message) || '操作完成').split('\n')[0], 'ok');
    await refreshAfterAction();
    return true;
  } catch (err) {
    deps.toast(err.message, 'err');
    // An interrupted two-step action may have changed state before failing.
    try { await refresh(); } catch { /* Preserve the original operation error. */ }
    return false;
  }
  finally { deps.setBusy(false); }
}

async function noteActionImpl(n) {
  const state = getState() || {};
  const acc = (state.accounts || []).find((a) => a.n === n);
  const text = await deps.promptModal('账号备注', '写一句这个账号的用途，会一直显示在卡片上。', acc ? acc.note : '');
  if (text == null) return false;
  return accountActionImpl(n, 'note', text);
}

async function savePolicyImpl() {
  const auto = deps.query('#pol-auto');
  const wait = deps.query('#pol-wait');
  const reserve = deps.query('#pol-reserve');
  if (!auto || !wait || !reserve) return false;
  deps.setBusy(true);
  try {
    const body = { autoSwitch: auto.checked, minWaitMin: Number(wait.value), reserveIndex: Number(reserve.value) };
    const rotation = collectRotation(deps.query, (getState() || {}).accounts || []);
    if (rotation !== undefined) body.rotation = rotation;
    const saved = await deps.api('/api/policy', {
      method: 'POST',
      body,
    });
    if (saved?.policy) deps.applyPolicy(saved.policy);
    deps.toast('策略已保存', 'ok');
    await refreshAfterAction();
    return true;
  } catch (err) { deps.toast(err.message, 'err'); return false; }
  finally { deps.setBusy(false); }
}

async function routerActionImpl(action) {
  if (action !== 'login') {
    const map = { restart: '重启本地路由', rebind: '重新绑定 Codex 桌面版' };
    const ok = await deps.confirmModal(map[action] || action, action === 'rebind' ? '只把 Codex config.toml 里指向本机路由的地址和密钥改回当前值（改前备份），不动账号、策略、启动项和其它设置。完成后需要完全退出并重新打开 Codex。' : '重启期间 Codex 请求会短暂失败。', true);
    if (!ok) return false;
  }
  deps.setBusy(true);
  try {
    const data = action === 'login'
      ? await deps.api('/api/login', { method: 'POST', body: {} })
      : await deps.api('/api/router', { method: 'POST', body: { action, includeState: false } });
    deps.toast((data && data.message) || '操作完成', 'ok');
    if (action === 'login') deps.schedule(() => refresh(), 4000);
    else await refreshAfterAction();
    return true;
  } catch (err) { deps.toast(err.message, 'err'); return false; }
  finally { deps.setBusy(false); }
}

/** 把 Codex 应用的登录态同步成代理当前账号（应用界面的额度横幅读的是它）。 */
async function syncAppLoginImpl() {
  if (deps.isBusy()) return false;
  deps.setBusy(true);
  try {
    const data = await deps.api('/api/app-login', { method: 'POST', body: {} });
    deps.toast((data && data.message) || '已同步应用登录', 'ok');
    await refreshAfterAction();
    return true;
  } catch (err) { deps.toast(err.message, 'err'); return false; }
  finally { deps.setBusy(false); }
}

async function doRefreshImpl() {
  if (deps.isBusy()) return false;
  deps.setBusy(true);
  try {
    await (refreshManual || refresh)();
    deps.toast('额度刷新已开始（后台进行，几秒后自动更新）', 'ok');
    return true;
  } catch { return false; /* 错误已在 loadState 里提示过 */ }
  finally { deps.setBusy(false); }
}

let actionPending = false;
async function runExclusive(operation) {
  if (actionPending || deps.isBusy()) return false;
  actionPending = true;
  try { return await operation(); }
  finally { actionPending = false; }
}
export const accountAction = (...args) => runExclusive(() => accountActionImpl(...args));
export const noteAction = (...args) => runExclusive(() => noteActionImpl(...args));
export const savePolicy = () => runExclusive(savePolicyImpl);
export const routerAction = (...args) => runExclusive(() => routerActionImpl(...args));
export const syncAppLogin = () => runExclusive(syncAppLoginImpl);
export const doRefresh = () => runExclusive(doRefreshImpl);
