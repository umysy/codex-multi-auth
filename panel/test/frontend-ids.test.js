'use strict';
// 前端 id 闸门自身的单测：证明它真的能抓到"改了 id 没改 JS"这一类错误。
const test = require('node:test');
const assert = require('node:assert/strict');
const { analyze } = require('../../scripts/check-frontend-ids.js');

test('遗漏：JS 引用了 HTML 里不存在的 id → 报错', () => {
  const r = analyze({
    html: '<div id="accounts"></div>',
    js: "$('#accounts'); $('#accounts-card');",
    css: '',
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /#accounts-card/);
});

test('动态注入：id 只出现在 app.js 的模板字符串里 → 不报错', () => {
  const r = analyze({
    html: '<div id="modal"></div>',
    js: "modal.innerHTML = '<button id=\"m-ok\">确定</button>'; $('#m-ok').onclick = () => {};",
    css: '',
  });
  assert.deepEqual(r.errors, []);
});

test('重复 id：index.html 里同一个 id 出现两次 → 报错', () => {
  const r = analyze({
    html: '<div id="toasts"></div><div id="toasts"></div>',
    js: "$('#toasts');",
    css: '',
  });
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0], /重复/);
});

test('提示不阻断：HTML 死 id / CSS 死选择器只进 warnings', () => {
  const r = analyze({
    html: '<div id="topbar-status"></div><div id="old-widget"></div>',
    js: "$('#topbar-status');",
    css: '#gone-widget { color: #fff; }',
  });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some((w) => w.includes('old-widget')));
  assert.ok(r.warnings.some((w) => w.includes('gone-widget')));
  // #fff 是颜色，不能被当成 id 选择器
  assert.ok(!r.warnings.some((w) => w.includes('#fff')));
});
