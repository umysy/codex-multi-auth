'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { decideWithPolicy } = require('../lib/policy-decision');
const { validateRotation } = require('../lib/rotation-policy');
const { planRotation } = require('../lib/rotation-policy');
const key = n => 'sha256:' + String(n).repeat(64);
const now = 1800000000000;
const quota = (short, weekly = 20) => ({ primary: { usedPercent: short, windowMinutes: 300, resetAtMs: now + 10 * 60000 }, secondary: { usedPercent: weekly, windowMinutes: 10080, resetAtMs: now + 86400000 } });
function input(over = {}) {
  return { nowMs: now, activeIndex: 0, accountCount: 3, autoSwitch: true, lastSwitchAtMs: now - 700000,
    rotation: { mode: 'daily-reserve', daily: [key(1), key(2)], reserve: [key(3)], waitBeforeSwitchMin: 0 },
    policyByIndex: { 0: { accountKey: key(1) }, 1: { accountKey: key(2) }, 2: { accountKey: key(3), emergencyOnly: true } },
    quotaByIndex: { 0: quota(100), 1: quota(0), 2: quota(0) }, ...over };
}
test('daily exhaustion switches immediately despite short reset wait and recent switch', () => {
  const d = decideWithPolicy(input()); assert.equal(d.targetIndex, 1); assert.equal(d.action, 'SWITCH'); assert.equal(d.details.targetIsReserve, false);
});
test('healthy current daily stays at 99%, unless configured to preempt', () => {
  const a = input({ quotaByIndex: { 0: quota(99), 1: quota(0), 2: quota(0) } });
  assert.equal(decideWithPolicy(a).action, 'OK'); a.rotation.shortUsedPercent = 95; assert.equal(decideWithPolicy(a).action, 'SWITCH');
});
test('both daily exhausted selects reserve; recovery immediately returns to daily', () => {
  assert.equal(decideWithPolicy(input({ quotaByIndex: { 0: quota(100), 1: quota(100), 2: quota(0) } })).targetIndex, 2);
  const d = decideWithPolicy(input({ activeIndex: 2 })); assert.equal(d.targetIndex, 1); assert.equal(d.details.reserveBack, true);
});
test('no healthy account never switches to an exhausted or unknown account', () => {
  const d = decideWithPolicy(input({ quotaByIndex: { 0: quota(100), 1: {}, 2: quota(100) } })); assert.equal(d.action, 'DEAD');
});
test('weekly exhaustion excludes a daily even when its 5h recovered', () => {
  assert.equal(decideWithPolicy(input({ quotaByIndex: { 0: quota(100), 1: quota(0, 100), 2: quota(0) } })).targetIndex, 2);
});
test('cooldown, manual pause, drained are excluded, policy-owned pauses can recover', () => {
  for (const field of ['paused', 'drained']) {
    const a = input(); a.policyByIndex[1][field] = true; assert.equal(decideWithPolicy(a).targetIndex, 2);
  }
  assert.equal(decideWithPolicy(input({ runtimeBlocked: { 1: 'cooling-down:network-error' } })).targetIndex, 2);
  const a = input({ policyPaused: [2] }); a.policyByIndex[1].paused = true; assert.equal(decideWithPolicy(a).targetIndex, 1);
});
test('reordered accounts resolve stable keys and missing accounts fail closed', () => {
  const a = input({ activeIndex: 1 }); [a.policyByIndex[0], a.policyByIndex[1]] = [a.policyByIndex[1], a.policyByIndex[0]];
  a.quotaByIndex = { 0: quota(0), 1: quota(100), 2: quota(0) }; assert.equal(decideWithPolicy(a).targetIndex, 0);
  delete a.policyByIndex[0]; assert.equal(decideWithPolicy(a).code, 'ACCOUNT_BINDING_MISSING');
});
test('manual and dry run remain read-only; invalid configs fail closed', () => {
  assert.equal(decideWithPolicy(input({ autoSwitch: false })).action, 'DISABLED');
  assert.equal(decideWithPolicy(input({ dryRun: true })).details.dryRun, true);
  assert.throws(() => validateRotation({ mode: 'daily-reserve', daily: [key(1)], reserve: [key(1)] }));
});

test('configured short reset wait takes priority but never hides runtime block or weekly exhaustion', () => {
  const a = input(); a.rotation.waitBeforeSwitchMin = 60;
  assert.equal(decideWithPolicy(a).action, 'WAIT');
  a.runtimeBlocked = { 0: 'rate-limited' }; assert.equal(decideWithPolicy(a).action, 'SWITCH');
  delete a.runtimeBlocked; a.quotaByIndex[0] = quota(100, 100); assert.equal(decideWithPolicy(a).action, 'SWITCH');
});
test('wait for a soon-recovering daily before reserve, but never invent recovery from past reset timestamp', () => {
  const a = input(); a.rotation.waitBeforeSwitchMin = 60;
  a.quotaByIndex[0] = quota(100, 100); a.quotaByIndex[1] = quota(100);
  assert.equal(decideWithPolicy(a).action, 'WAIT');
  a.quotaByIndex[1].primary.resetAtMs = now - 1; assert.equal(decideWithPolicy(a).targetIndex, 2);
});
test('failed per-account quota queries never qualify as recovered', () => {
  for (const status of [401, 429, 500]) {
    const a = input(); a.quotaByIndex[1].status = status; assert.equal(decideWithPolicy(a).targetIndex, 2);
  }
});
test('runtime plan enforces reserve roles and excludes exhausted accounts, preserving manual pauses', () => {
  const a = input(); a.policyByIndex[2].emergencyOnly = false; a.policyByIndex[1].paused = true;
  const p = planRotation(a); assert.deepEqual(p.pause, [1]); assert.deepEqual(p.resume, []);
  assert.deepEqual(p.roleChanges, [{ n: 3, emergencyOnly: true }]);
  const off = planRotation(input({ autoSwitch: false })); assert.deepEqual(off.pause, []); assert.deepEqual(off.roleChanges, []);
});

test('custom rotation keeps the switch guard and hard runtime blocks override it', () => {
  const a = input({ lastSwitchAtMs: now - 1000 });
  assert.equal(decideWithPolicy(a).action, 'GUARD');
  a.runtimeBlocked = { 0: 'rate-limited' };
  assert.equal(decideWithPolicy(a).action, 'SWITCH');
});

test('an unavailable reserve waits for a daily reset instead of declaring DEAD', () => {
  const a = input({ activeIndex: 2, lastSwitchAtMs: now - 700000 });
  a.rotation.waitBeforeSwitchMin = 60;
  a.quotaByIndex = { 0: quota(100), 1: quota(100), 2: quota(100) };
  a.quotaByIndex[1].primary.resetAtMs = now + 20 * 60000;
  a.runtimeBlocked = { 2: 'rate-limited' };
  assert.equal(decideWithPolicy(a).action, 'WAIT');
  assert.equal(decideWithPolicy(a).code, 'WAIT_SHORT_RESET');
});

test('all accounts sharing one runtime failure become a global incident instead of switch storm', () => {
  const a = input({ quotaByIndex: { 0: quota(0), 1: quota(0), 2: quota(0) }, runtimeBlocked: { 0: 'model-capacity', 1: 'model-capacity', 2: 'model-capacity' } });
  const d = decideWithPolicy(a);
  assert.equal(d.action, 'DEAD');
  assert.equal(d.code, 'GLOBAL_RUNTIME_INCIDENT');
  assert.equal(d.details.globalIncident, 'capacity');
});

test('two blocked daily accounts do not hide a usable reserve as global failure', () => {
  const a = input({ quotaByIndex: { 0: quota(0), 1: quota(0), 2: quota(0) }, runtimeBlocked: { 0: 'model-capacity', 1: 'model-capacity' } });
  const d = decideWithPolicy(a);
  assert.equal(d.action, 'SWITCH');
  assert.equal(d.targetIndex, 2);
  assert.equal(d.code, 'ROTATE_ACCOUNT');
});

test('runtimeBlocked Map and JSON object have the same decision semantics', () => {
  const objectInput = input({ runtimeBlocked: { 0: 'model-capacity' } });
  const mapInput = input({ runtimeBlocked: new Map([[0, 'model-capacity']]) });
  assert.deepEqual(decideWithPolicy(mapInput).action, decideWithPolicy(objectInput).action);
  assert.deepEqual(decideWithPolicy(mapInput).targetIndex, decideWithPolicy(objectInput).targetIndex);
});

test('per-account quota thresholds affect both selection and pause reconciliation', () => {
  const a = input({ quotaByIndex: { 0: quota(85), 1: quota(0), 2: quota(0) } });
  a.rotation.accountRules = { [key(1)]: { shortUsedPercent: 80 } };
  assert.equal(decideWithPolicy(a).targetIndex, 1);
  assert.deepEqual(planRotation(a).pause, [1]);
  a.quotaByIndex[0] = quota(20, 85);
  a.rotation.accountRules[key(1)] = { weeklyUsedPercent: 80 };
  assert.equal(decideWithPolicy(a).targetIndex, 1);
  assert.deepEqual(planRotation(a).pause, [1]);
});

test('per-account wait overrides inherited wait and respects the exact boundary', () => {
  const a = input(); a.rotation.waitBeforeSwitchMin = 60;
  a.rotation.accountRules = { [key(1)]: { waitBeforeSwitchMin: 0 } };
  assert.equal(decideWithPolicy(a).action, 'SWITCH');
  a.rotation.accountRules[key(1)].waitBeforeSwitchMin = 10;
  assert.equal(decideWithPolicy(a).action, 'SWITCH');
  a.rotation.accountRules[key(1)].waitBeforeSwitchMin = 11;
  assert.equal(decideWithPolicy(a).action, 'WAIT');
  a.runtimeBlocked = { 0: 'rate-limited' };
  assert.equal(decideWithPolicy(a).action, 'SWITCH');
});

test('waiting or switch guard never pauses a current account that still has quota below 100%', () => {
  const a = input({ quotaByIndex: { 0: quota(85), 1: quota(0), 2: quota(0) } });
  a.rotation.shortUsedPercent = 80; a.rotation.waitBeforeSwitchMin = 60;
  assert.equal(decideWithPolicy(a).action, 'WAIT'); assert.deepEqual(planRotation(a).pause, []);
  a.rotation.waitBeforeSwitchMin = 0; a.lastSwitchAtMs = now - 1000;
  assert.equal(decideWithPolicy(a).action, 'GUARD'); assert.deepEqual(planRotation(a).pause, []);
  a.quotaByIndex[0] = quota(100);
  assert.deepEqual(planRotation(a).pause, [1]);
});

test('cycle and priority order select distinct healthy candidates without preempting a healthy daily', () => {
  const a = input({ accountCount: 4, activeIndex: 1 });
  a.rotation.daily = [key(1), key(2), key(3)]; a.rotation.reserve = [key(4)];
  a.policyByIndex = { 0: { accountKey: key(1) }, 1: { accountKey: key(2) }, 2: { accountKey: key(3) }, 3: { accountKey: key(4) } };
  a.quotaByIndex = { 0: quota(0), 1: quota(100), 2: quota(0), 3: quota(0) };
  assert.equal(decideWithPolicy(a).targetIndex, 2);
  a.rotation.dailySelection = 'priority';
  assert.equal(decideWithPolicy(a).targetIndex, 0);
  a.quotaByIndex[1] = quota(0);
  assert.equal(decideWithPolicy(a).action, 'OK');
});

test('multiple reserves use configured order, and optional return respects reserve health', () => {
  const a = input(); a.rotation.daily = [key(1)]; a.rotation.reserve = [key(3), key(2)];
  assert.equal(decideWithPolicy(a).targetIndex, 2);
  a.activeIndex = 2; a.quotaByIndex[0] = quota(0); a.rotation.returnToDaily = false;
  assert.equal(decideWithPolicy(a).action, 'OK');
  a.quotaByIndex[2] = quota(100);
  assert.equal(decideWithPolicy(a).targetIndex, 0);
});

test('new rule fields are validated and cloned without leaking or dropping unsupported rules', () => {
  const a = input().rotation;
  for (const extra of [{ version: 2 }, { dailySelection: 'random' }, { accountRules: [] }, { accountRules: { [key(4)]: {} } }, { accountRules: { [key(1)]: { shortUsedPercent: 0 } } }, { accountRules: { [key(1)]: { waitBeforeSwitchMin: 601 } } }, { accountRules: { [key(1)]: { unknown: 1 } } }, { unknown: true }]) {
    assert.throws(() => validateRotation({ ...a, ...extra }));
  }
  const rules = { [key(1)]: { shortUsedPercent: 90, waitBeforeSwitchMin: 0 } };
  const result = validateRotation({ ...a, version: 1, dailySelection: 'priority', accountRules: rules });
  rules[key(1)].shortUsedPercent = 10;
  assert.equal(result.accountRules[key(1)].shortUsedPercent, 90);
});
