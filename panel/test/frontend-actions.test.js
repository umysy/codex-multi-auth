'use strict';
// actions.mjs 的请求/错误分支单测：用注入的假 api / 假 UI，覆盖真实交互会走到的每条路径。
// 这些模块本身不碰 DOM（查询与 toast 都是注入的），所以能在 Node 里完整跑。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUBLIC = path.join(__dirname, '..', 'public');
let modPromise = null;
function load() {
  if (!modPromise) modPromise = import(pathToFileURL(path.join(PUBLIC, 'modules', 'actions.mjs')).href);
  return modPromise;
}

function harness(extra = {}) {
  const h = {
    busy: false,
    toasts: [],
    calls: [],
    refreshes: 0,
    manualRefreshes: 0,
    confirmResult: true,
    confirm: null,
    promptResult: null,
    apiResult: { ok: true, message: '操作完成' },
    apiError: null,
    scheduled: [],
    elements: null,
  };
  h.api = async (url, opts) => {
    h.calls.push({ url, method: opts && opts.method, body: opts && opts.body });
    if (h.apiError) throw new Error(h.apiError);
    return h.apiResult;
  };
  h.deps = {
    api: h.api,
    query: (sel) => (h.elements ? h.elements[sel] : null),
    toast: (msg, kind) => h.toasts.push({ msg, kind }),
    setBusy: (v) => { h.busy = v; },
    isBusy: () => h.busy,
    confirmModal: async (title, text) => { h.confirm = { title, text }; return h.confirmResult; },
    promptModal: async (title, text, value) => { h.prompt = { title, text, value }; return h.promptResult; },
    refresh: async () => { h.refreshes += 1; },
    refreshManual: async () => { h.manualRefreshes += 1; },
    getState: () => ({ accounts: [{ n: 2, email: 'who@example.com', note: '旧备注' }] }),
    schedule: (fn, ms) => { h.scheduled.push({ fn, ms }); },
  };
  Object.assign(h, extra);
  if (extra.deps) Object.assign(h.deps, extra.deps);
  return h;
}

async function ready(h) {
  const act = await load();
  act.initActions(h.deps);
  return act;
}

test('账号动作：确认框取消 → 不发请求、不提示、不置忙', async () => {
  const h = harness({ confirmResult: false });
  const act = await ready(h);
  assert.equal(await act.accountAction(2, 'pause'), false);
  assert.equal(h.calls.length, 0);
  assert.equal(h.toasts.length, 0);
  assert.equal(h.busy, false);
  assert.match(h.confirm.title, /暂停该账号/);
  assert.match(h.confirm.text, /who@example\.com/);
});

test('账号动作：成功 → POST 正确 body、toast 首行、刷新一次、busy 复位', async () => {
  const h = harness({ apiResult: { ok: true, message: '已暂停\n多余行被丢掉' } });
  const act = await ready(h);
  assert.equal(await act.accountAction(2, 'pause'), true);
  assert.deepEqual(h.calls, [{ url: '/api/account', method: 'POST', body: { n: 2, action: 'pause', value: undefined } }]);
  assert.deepEqual(h.toasts, [{ msg: '已暂停', kind: 'ok' }]);
  assert.equal(h.refreshes, 1);
  assert.equal(h.busy, false);
});

test('账号动作：后端报错仍回查状态，保留错误提示并恢复按钮', async () => {
  const h = harness({ apiError: '后端 500：CLI 超时' });
  const act = await ready(h);
  assert.equal(await act.accountAction(2, 'switch'), false);
  assert.deepEqual(h.toasts, [{ msg: '后端 500：CLI 超时', kind: 'err' }]);
  assert.equal(h.refreshes, 1);
  assert.equal(h.busy, false);
});

test('账号动作部分失败且回查也失败时，不得提示操作已完成', async () => {
  const h = harness({apiError: '部分失败：恢复原状态未确认'});
  h.deps.refresh = async () => { throw new Error('snapshot failed'); };
  const act = await ready(h);
  assert.equal(await act.accountAction(2, 'reserve'), false);
  assert.deepEqual(h.toasts, [{msg: '部分失败：恢复原状态未确认', kind: 'err'}]);
  assert.equal(h.busy, false);
});

test('备注：弹窗取消 → 不发请求；确认 → 走 note 动作且不再二次确认', async () => {
  const h = harness({ promptResult: null });
  const act = await ready(h);
  assert.equal(await act.noteAction(2), false);
  assert.equal(h.calls.length, 0);
  assert.match(h.prompt.value, /旧备注/);

  const h2 = harness({ promptResult: '日常号 A' });
  const act2 = await ready(h2);
  assert.equal(await act2.noteAction(2), true);
  assert.equal(h2.confirm, null, 'note 不该弹确认框');
  assert.deepEqual(h2.calls[0].body, { n: 2, action: 'note', value: '日常号 A' });
});

test('策略保存：表单不在地毯式 return；成功 → 三项数字正确、刷新、busy 复位', async () => {
  const h0 = harness();
  const act0 = await ready(h0);
  assert.equal(await act0.savePolicy(), false);
  assert.equal(h0.calls.length, 0);

  const h = harness({
    elements: {
      '#pol-auto': { checked: true },
      '#pol-wait': { value: '75' },
      '#pol-reserve': { value: '2' },
    },
  });
  const act = await ready(h);
  assert.equal(await act.savePolicy(), true);
  assert.deepEqual(h.calls, [{ url: '/api/policy', method: 'POST', body: { autoSwitch: true, minWaitMin: 75, reserveIndex: 2 } }]);
  assert.deepEqual(h.toasts, [{ msg: '策略已保存', kind: 'ok' }]);
  assert.equal(h.refreshes, 1);
  assert.equal(h.busy, false);
});

test('策略保存：失败 → toast 红字、不刷新、busy 复位', async () => {
  const h = harness({
    apiError: '保存失败',
    elements: { '#pol-auto': { checked: false }, '#pol-wait': { value: '60' }, '#pol-reserve': { value: '1' } },
  });
  const act = await ready(h);
  assert.equal(await act.savePolicy(), false);
  assert.deepEqual(h.toasts, [{ msg: '保存失败', kind: 'err' }]);
  assert.equal(h.refreshes, 0);
  assert.equal(h.busy, false);
});

test('策略保存先应用返回配置，即使后续回查失败也不丢失已保存的规则', async () => {
  const h = harness({ apiResult: { ok: true, policy: { autoSwitch: true, rotation: { mode: 'daily-reserve' } } }, elements: { '#pol-auto': { checked: true }, '#pol-wait': { value: '60' }, '#pol-reserve': { value: '1' } } });
  const events = [];
  h.deps.applyPolicy = policy => events.push(policy);
  h.deps.refresh = async () => { assert.equal(events.length, 1); throw Error('snapshot failed'); };
  const act = await ready(h);
  assert.equal(await act.savePolicy(), true);
  assert.deepEqual(events, [h.apiResult.policy]);
});

test('路由动作：restart 需要确认，取消则不发请求', async () => {
  const h = harness({ confirmResult: false });
  const act = await ready(h);
  assert.equal(await act.routerAction('restart'), false);
  assert.equal(h.calls.length, 0);
  assert.match(h.confirm.text, /重启期间/);
});

test('路由动作：login 不需要确认，POST /api/login 并 4 秒后再刷新', async () => {
  const h = harness({ apiResult: { ok: true, message: '已启动登录窗口' } });
  const act = await ready(h);
  assert.equal(await act.routerAction('login'), true);
  assert.equal(h.confirm, null);
  assert.deepEqual(h.calls, [{ url: '/api/login', method: 'POST', body: {} }]);
  assert.equal(h.refreshes, 0, 'login 后不立即刷新');
  assert.equal(h.scheduled.length, 1);
  assert.equal(h.scheduled[0].ms, 4000);
  h.scheduled[0].fn();
  assert.equal(h.refreshes, 1);
});

test('路由动作：restart 成功 → POST /api/router、立即刷新、toast 用后端消息', async () => {
  const h = harness({ apiResult: { ok: true, message: '路由已重启 · PID 9999' } });
  const act = await ready(h);
  assert.equal(await act.routerAction('restart'), true);
  assert.deepEqual(h.calls, [{ url: '/api/router', method: 'POST', body: { action: 'restart', includeState: false } }]);
  assert.deepEqual(h.toasts, [{ msg: '路由已重启 · PID 9999', kind: 'ok' }]);
  assert.equal(h.refreshes, 1);
});

test('路由动作：失败 → toast 红字、不刷新、busy 复位', async () => {
  const h = harness({ apiError: 'rebind 失败' });
  const act = await ready(h);
  assert.equal(await act.routerAction('rebind'), false);
  assert.deepEqual(h.toasts, [{ msg: 'rebind 失败', kind: 'err' }]);
  assert.equal(h.refreshes, 0);
  assert.equal(h.busy, false);
});

test('手动刷新：忙碌时直接忽略，不重复发请求', async () => {
  const h = harness();
  h.busy = true;
  const act = await ready(h);
  assert.equal(await act.doRefresh(), false);
  assert.equal(h.manualRefreshes, 0);
  assert.equal(h.toasts.length, 0);
});

test('手动刷新：成功 → 调 refreshManual、toast 成功；失败 → 不 toast 红字（loadState 已提示）', async () => {
  const h = harness();
  const act = await ready(h);
  assert.equal(await act.doRefresh(), true);
  assert.equal(h.manualRefreshes, 1);
  assert.deepEqual(h.toasts, [{ msg: '额度刷新已开始（后台进行，几秒后自动更新）', kind: 'ok' }]);
  assert.equal(h.busy, false);

  const h2 = harness();
  h2.deps.refreshManual = async () => { h2.manualRefreshes += 1; throw new Error('刷新失败'); };
  const act2 = await ready(h2);
  assert.equal(await act2.doRefresh(), false);
  assert.equal(h2.manualRefreshes, 1);
  assert.equal(h2.toasts.length, 0);
  assert.equal(h2.busy, false);
});

test('账号动作：解除固定 → 确认框带 503 风险说明、POST unpin、刷新一次', async () => {
  const h = harness({ apiResult: { ok: true, message: '已取消固定（unpin）' } });
  const act = await ready(h);
  assert.equal(await act.accountAction(2, 'unpin'), true);
  assert.deepEqual(h.calls, [
    { url: '/api/account', method: 'POST', body: { n: 2, action: 'unpin', value: undefined } },
  ]);
  assert.match(h.confirm.title, /解除固定/);
  assert.match(h.confirm.text, /503/);
  assert.deepEqual(h.toasts, [{ msg: '已取消固定（unpin）', kind: 'ok' }]);
  assert.equal(h.refreshes, 1);
});

test('账号操作进行中再次点击不会重复提交', async () => {
  const h = harness(); const act = await ready(h);
  let release; h.deps.api = () => new Promise(resolve => { release = resolve; });
  act.initActions(h.deps);
  const first = act.accountAction(2, 'pause');
  await Promise.resolve();
  assert.equal(await act.accountAction(2, 'pause'), false);
  release({ok:true}); await first;
});

test('操作成功但刷新失败仍保留操作成功结果', async () => {
  const h = harness(); h.deps.refresh = async () => { throw new Error('state query failed'); };
  const act = await ready(h);
  assert.equal(await act.accountAction(2, 'pause'), true);
  assert.equal(h.busy, false);
  assert.ok(h.toasts.some(t => t.kind === 'ok'));
  assert.ok(h.toasts.every(t => !t.msg.includes('state query failed')));
});

test('确认弹窗等待期间不会叠加第二个操作或弹窗', async () => {
  const h = harness(); const act = await ready(h);
  let confirm;
  let dialogs = 0;
  h.deps.confirmModal = () => { dialogs++; return new Promise(resolve => { confirm = resolve; }); };
  act.initActions(h.deps);
  const first = act.accountAction(2, 'pause');
  assert.equal(await act.routerAction('restart'), false);
  assert.equal(dialogs, 1);
  confirm(false);
  assert.equal(await first, false);
  assert.equal(h.calls.length, 0);
});
