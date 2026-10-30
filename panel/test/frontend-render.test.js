'use strict';
// 前端纯函数（格式化 + 渲染）的行为测试。
// 这些模块是不碰 DOM 的 .mjs，Node 直接 import 就能测，不需要浏览器或 jsdom。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUBLIC = path.join(__dirname, '..', 'public');
const cache = new Map();
function load(rel) {
  if (!cache.has(rel)) cache.set(rel, import(pathToFileURL(path.join(PUBLIC, rel)).href));
  return cache.get(rel);
}

const NOW = 1800000000000;

test('format.esc 转义 HTML 特殊字符', async () => {
  const { esc } = await load('modules/format.mjs');
  assert.equal(esc('<script>alert("x")</script>'), '&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  assert.equal(esc(null), '');
  assert.equal(esc(0), '0');
});

test('format.countdown 支持注入 now，边界语义不变', async () => {
  const { countdown } = await load('modules/format.mjs');
  assert.equal(countdown(0, NOW), '无窗口');
  assert.equal(countdown(NOW - 1000, NOW), '已重置');
  assert.equal(countdown(NOW + 90 * 1000, NOW), '1 分钟后重置');  // 90 秒四舍五入后按分钟展示
  assert.equal(countdown(NOW + 2 * 3600 * 1000, NOW), '2 小时 0 分后重置');
});

test('format.fmtHours / fmtDuration 单位换算', async () => {
  const { fmtHours, fmtDuration } = await load('modules/format.mjs');
  assert.equal(fmtHours(0), '0');
  assert.equal(fmtHours(-3), '0');
  assert.equal(fmtHours(12), '12.0 小时');
  assert.equal(fmtHours(48), '2.0 天');
  assert.equal(fmtDuration(45 * 1000), '45 秒');
  assert.equal(fmtDuration(3 * 3600 * 1000), '3 小时 0 分');
});

test('总览：状态 pills 渲染路由/账号/策略与错误', async () => {
  const { statusPillsHtml } = await load('modules/render-overview.mjs');
  const html = statusPillsHtml({
    router: { running: true, pid: 4242 },
    current: { n: 1, email: 'acct@example.com' },
    selection: { available: 2, total: 3 },
    policy: { autoSwitch: true, minWaitMin: 60 },
    errors: ['上游异常'],
  });
  assert.match(html, /路由 运行中 · PID 4242/);
  assert.match(html, /当前使用 <b>acct@example\.com<\/b>/);
  assert.match(html, /可用账号 <b>2\/3<\/b>/);
  assert.match(html, /自动切号 开 · 阈值 60 分/);
  assert.match(html, /上游异常/);
});

test('总览：KPI 卡片包含周剩余与预算信息', async () => {
  const { kpisHtml } = await load('modules/render-overview.mjs');
  const html = kpisHtml({
    accounts: [{ n: 1, email: 'a@example.com', h7: { remaining: 80 }, h5: { remaining: 40 } }],
    current: { n: 1, email: 'a@example.com', h5: { remaining: 40 } },
    totals: { weekRemaining: 125.4, hoursLeft: 30, drainPerHour: 5.5, withinBudget: true, darkAt: NOW, budgetDarkAt: NOW },
    router: { running: true, requests: 7, rotations: 2 },
  });
  assert.match(html, />125<small>%/);
  assert.match(html, /1\.3 天/);
  assert.match(html, /在预算内/);
  assert.match(html, /请求 <b>7<\/b> · 轮转 <b>2<\/b>/);
});

test('总览：路由错误恢复后显示"已恢复"而不是红字故障', async () => {
  const { routerErrBadge } = await load('modules/render-overview.mjs');
  assert.equal(routerErrBadge(null), '');
  assert.match(routerErrBadge({ lastError: 'x', errorRecovered: true }), /已恢复/);
  assert.match(routerErrBadge({ lastError: 'x', errorRecovered: false }), /有错误/);
});

test('账号区：空状态、储备号按钮、当前号不给切换按钮', async () => {
  const { accountsHtml, roleChip } = await load('modules/render-accounts.mjs');
  assert.match(accountsHtml({ accounts: [] }), /没有读到账号/);
  assert.equal(roleChip({ role: 'reserve' }), '<span class="chip reserve">储备号</span>');

  const html = accountsHtml({
    accounts: [
      { n: 1, email: 'r@example.com', role: 'reserve', paused: true, emergencyOnly: true },
      { n: 2, email: 'c@example.com', role: 'daily', current: true, paused: false, h5: { remaining: 60, resetAt: NOW }, h7: { remaining: 90, resetAt: NOW } },
    ],
  });
  assert.match(html, /data-act="unreserve" data-n="1"/);
  assert.match(html, /使用中/);
  assert.match(html, /data-act="pause" data-n="2"/);
  assert.doesNotMatch(html, /data-act="switch" data-n="2"/);
});

test('账号区：窗口已重置仍显示百分比（灰色环），陈旧快照有提示', async () => {
  const { accountsHtml, ringSvg } = await load('modules/render-accounts.mjs');
  const expired = ringSvg({ remaining: 0, resetAt: NOW, expired: true });
  assert.match(expired, />0%</);
  assert.match(expired, /stroke="#9aa0a6"/);
  assert.match(ringSvg({ remaining: 60, resetAt: NOW }), />60%</);

  const html = accountsHtml({
    accounts: [{ n: 3, email: 'c@example.com', role: 'daily', paused: false, quotaStale: true, h5: { remaining: 0, resetAt: NOW - 3600000, expired: true } }],
  });
  assert.match(html, /额度快照较旧/);
});

test('面板：时间线把 kind 映射成样式类，空状态有提示', async () => {
  const { timelineHtml } = await load('modules/render-panels.mjs');
  assert.match(timelineHtml({ logs: [] }), /还没有事件记录/);
  const html = timelineHtml({ logs: [{ at: '2026-10-25 10:00:00', kind: 'SWITCH', msg: 'SWITCH 已切换 1 -> 2' }] });
  assert.match(html, /tl-kind k-switch/);
  assert.match(html, /已切换 1 -&gt; 2/);
});

test('面板：策略表单带回填值与滑块位置', async () => {
  const { policyHtml } = await load('modules/render-panels.mjs');
  const html = policyHtml({
    policy: { autoSwitch: false, minWaitMin: 90, reserveIndex: 2, maxMinWait: 180 },
    accounts: [{ n: 1, email: 'a@example.com' }, { n: 2, email: 'b@example.com' }],
  });
  assert.doesNotMatch(html, /id="pol-auto" checked/);
  assert.match(html, /id="pol-wait"[^>]*value="90"/);
  assert.match(html, /--fill:48\.\d+%/);          // (90-5)/(180-5)
  assert.match(html, /<option value="2" selected>/);
});

test('面板：路由状态与动作按钮', async () => {
  const { routerGridHtml, routerActionsHtml, routerHintText } = await load('modules/render-panels.mjs');
  const html = routerGridHtml({ router: { running: true, port: 8766, lastError: 'boom', errorRecovered: true } });
  assert.match(html, /运行中/);
  assert.match(html, /最近错误/);
  assert.match(html, /陈旧记录/);
  assert.match(routerActionsHtml(), /data-router="restart"/);
  assert.match(routerActionsHtml(), /data-router="login"/);
  assert.equal(routerHintText({ router: { port: 8766 } }), '127.0.0.1:8766');
  assert.equal(routerHintText({ router: {} }), '');
});

test('面板：路由错误码翻成人话（传输失败 / 模型容量）', async () => {
  const { routerErrorText } = await load('modules/render-panels.mjs');
  assert.match(routerErrorText('upstream-transport:timeout'), /上游连接超时/);
  assert.match(routerErrorText('model-capacity:server_is_overloaded'), /模型容量不足（server_is_overloaded）.*换账号/);
  assert.match(routerErrorText('model-capacity-midstream:slow_down'), /输出中途.*自动重试/);
  assert.equal(routerErrorText('something else'), 'something else');
});

test('面板：页脚文本', async () => {
  const { footerText, footerErrorText } = await load('modules/render-panels.mjs');
  assert.match(footerText({ totals: { darkAt: NOW }, alerts: ['预算告警'] }, NOW), /读取于 .* · 每周预算线 36%\/天 · 预计耗尽/);
  assert.match(footerText({ totals: {}, alerts: ['预算告警'] }, 0), /预算告警/);
  assert.equal(footerErrorText('X'), '读取失败：X');
});

test('动作：确认文案里带出账号邮箱（依赖注入的 current state）', async () => {
  const { initActions, actionPrompt } = await load('modules/actions.mjs');
  initActions({ getState: () => ({ accounts: [{ n: 2, email: 'who@example.com' }] }) });
  assert.match(actionPrompt('switch', 2), /who@example\.com/);
  assert.match(actionPrompt('pause', 9), /账号 9/);
  assert.equal(actionPrompt('note', 2), '');
});

test('账号区：固定中的账号显示「已固定」与「解除固定」按钮', async () => {
  const { accountsHtml } = await load('modules/render-accounts.mjs');
  const base = (selection) =>
    accountsHtml({
      selection,
      accounts: [{ n: 2, email: 'p@example.com', role: 'daily', current: true, paused: false, h5: null, h7: null }],
    });
  const pinned = base({ pinned: 2 });
  assert.match(pinned, /已固定/);
  assert.match(pinned, /data-act="unpin" data-n="2"/);
  assert.match(pinned, /解除固定/);
  assert.doesNotMatch(base({ pinned: null }), /data-act="unpin"/);
  assert.doesNotMatch(base({}), /已固定/);
});

test('认证失效账号显示重新登录入口', async () => {
  const { accountsHtml } = await load('modules/render-accounts.mjs');
  const html = accountsHtml({ accounts: [{ n: 1, email: 'expired@example.com', role: 'daily', paused: false, authRequired: true }] });
  assert.match(html, /data-router="login"/);
  assert.match(html, /重新登录/);
});
