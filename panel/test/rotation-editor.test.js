'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const load = () => import(pathToFileURL(path.join(__dirname, '../public/modules/rotation-editor.mjs')).href);
const key = n => 'sha256:' + String(n).repeat(64);
function form() {
  const rows = [2, 1, 3].map(n => ({ dataset: { ruleKey: key(n) }, values: { '[data-rule-role]': n === 3 ? 'reserve' : 'daily', '[data-rule-field="shortUsedPercent"]': n === 1 ? '20' : '', '[data-rule-field="weeklyUsedPercent"]': '', '[data-rule-field="waitBeforeSwitchMin"]': n === 1 ? '0' : '' }, querySelector(selector) { return { value: this.values[selector] }; } }));
  const inputs = { '#rotation-enabled': { checked: true }, '#rotation-selection': { value: 'priority' }, '#rotation-short': { value: '5' }, '#rotation-weekly': { value: '2' }, '#rotation-wait': { value: '60' }, '#rotation-gap': { value: '120' }, '#rotation-return': { checked: false }, '#rotation-accounts': { querySelectorAll: () => rows } };
  return { inputs, rows, query: s => inputs[s], accounts: [1, 2, 3].map(n => ({ accountKey: key(n) })) };
}
test('visual form collects ordered groups, numeric thresholds and only explicit account overrides', async () => {
  const { collectRotation } = await load(); const f = form(); const c = collectRotation(f.query, f.accounts);
  assert.deepEqual(c.daily, [key(2), key(1)]); assert.deepEqual(c.reserve, [key(3)]);
  assert.equal(c.shortUsedPercent, 95); assert.equal(c.weeklyUsedPercent, 98);
  assert.equal(c.dailySelection, 'priority'); assert.equal(c.returnToDaily, false);
  assert.deepEqual(c.accountRules, { [key(1)]: { shortUsedPercent: 80, waitBeforeSwitchMin: 0 } });
});
test('disabled rules explicitly clear custom configuration; an absent form does not erase it', async () => {
  const { collectRotation } = await load(); const f = form(); f.inputs['#rotation-enabled'].checked = false;
  assert.equal(collectRotation(f.query, []), null); assert.equal(collectRotation(() => null, []), undefined);
});
test('empty globals, invalid values and changed account pools cannot be saved', async () => {
  const { collectRotation } = await load(); const f = form();
  f.inputs['#rotation-gap'].value = ''; assert.throws(() => collectRotation(f.query, f.accounts), /不能为空/);
  f.inputs['#rotation-gap'].value = '120';
  f.rows[1].values['[data-rule-field="shortUsedPercent"]'] = '101'; assert.throws(() => collectRotation(f.query, f.accounts), /之间/);
  f.rows[1].values['[data-rule-field="shortUsedPercent"]'] = '';
  assert.throws(() => collectRotation(f.query, [...f.accounts, { accountKey: key(4) }]), /账户池已变化/);
  for (const row of f.rows) row.values['[data-rule-role]'] = 'reserve';
  assert.throws(() => collectRotation(f.query, f.accounts), /至少需要/);
});
test('saved rules render controls in saved order without exposing an editable JSON blob', async () => {
  const { rotationEditorHtml } = await load(); const f = form();
  const html = rotationEditorHtml({ policy: { rotation: { daily: [key(2), key(1)], reserve: [key(3)], accountRules: { [key(1)]: { shortUsedPercent: 80 } }, returnToDaily: false } }, accounts: f.accounts.map((a, i) => ({ ...a, n: i + 1, email: i === 0 ? '<img src=x>' : 'sample' })) });
  assert.ok(html.indexOf(key(2)) < html.indexOf(key(1))); assert.match(html, /value="20"/);
  assert.match(html, /&lt;img src=x&gt;/); assert.doesNotMatch(html, /<textarea|<img src=x>/);
  assert.doesNotMatch(html, /id="rotation-return"[^>]*checked/);
});

test('remaining thresholds preserve zero, upper bound, decimals and blank inheritance', async () => {
  const { collectRotation, rotationEditorHtml } = await load(); const f = form();
  f.inputs['#rotation-short'].value = '0.3'; f.inputs['#rotation-weekly'].value = '99';
  f.rows[1].values['[data-rule-field="shortUsedPercent"]'] = '0';
  const c = collectRotation(f.query, f.accounts);
  assert.equal(c.shortUsedPercent, 99.7); assert.equal(c.weeklyUsedPercent, 1);
  assert.equal(c.accountRules[key(1)].shortUsedPercent, 100);
  assert.equal(c.accountRules[key(2)], undefined);
  const html = rotationEditorHtml({ policy: { rotation: c }, accounts: f.accounts });
  assert.match(html, /id="rotation-short"[^>]*value="0.3"/);
  assert.match(html, /id="rotation-weekly"[^>]*value="99"/);
  assert.match(html, /剩余 ≤/); assert.doesNotMatch(html, /已用/);
  for (const value of ['100', '-0.1', 'NaN', '']) {
    f.inputs['#rotation-short'].value = value;
    assert.throws(() => collectRotation(f.query, f.accounts));
  }
});

test('saved remaining thresholds switch at either window boundary and retain wait rules', async () => {
  const { collectRotation } = await load(); const f = form();
  f.inputs['#rotation-wait'].value = '0'; f.inputs['#rotation-gap'].value = '0';
  const rotation = collectRotation(f.query, f.accounts);
  const { decideWithPolicy } = require('../lib/policy-decision');
  const now = 1800000000000;
  const quota = (short, weekly) => ({ primary: { usedPercent: short, windowMinutes: 300, resetAtMs: now + 600000 }, secondary: { usedPercent: weekly, windowMinutes: 10080, resetAtMs: now + 86400000 } });
  const input = { nowMs: now, activeIndex: 1, accountCount: 3, autoSwitch: true, lastSwitchAtMs: now - 700000, rotation,
    policyByIndex: { 0: { accountKey: key(1) }, 1: { accountKey: key(2) }, 2: { accountKey: key(3), emergencyOnly: true } },
    quotaByIndex: { 0: quota(0, 0), 1: quota(94.9, 97.9), 2: quota(0, 0) } };
  assert.equal(decideWithPolicy(input).action, 'OK');
  for (const [short, weekly] of [[95, 0], [0, 98], [95, 98]]) {
    input.quotaByIndex[1] = quota(short, weekly);
    const decision = decideWithPolicy(input);
    assert.equal(decision.action, 'SWITCH'); assert.equal(decision.targetIndex, 0);
  }
  input.quotaByIndex[1] = quota(95, 0); rotation.waitBeforeSwitchMin = 60;
  assert.equal(decideWithPolicy(input).action, 'WAIT');
  input.quotaByIndex[1] = quota(0, 98);
  assert.equal(decideWithPolicy(input).action, 'SWITCH');
});
