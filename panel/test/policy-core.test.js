'use strict';

/**
 * policy-core.test.js — 策略核心纯函数的单元测试
 * 运行：node --test panel/test/
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const core = require('../policy-core.js');
const FIX = require('./fixtures.json');

const NOW = FIX.nowMs;
const RESERVE = FIX.policy.reserveIndex;

/* --------------------------------- 夹具工具 -------------------------------- */

/** fixtures 里的 resetInMin 偏移 → 绝对 resetAtMs（保证用例与真实时钟无关） */
function hydrate(quota) {
  const q = JSON.parse(JSON.stringify(quota));
  for (const key of ['primary', 'secondary']) {
    const w = q[key];
    if (!w || typeof w !== 'object') continue;
    if (typeof w.resetInMin === 'number') {
      w.resetAtMs = Math.round(NOW + w.resetInMin * 60000);
      delete w.resetInMin;
    }
  }
  return q;
}

/** 取某个账号的 quota（带上 index，可选 mutate 现场改造） */
function quotaOf(name, mutate) {
  const fx = FIX.accounts[name];
  if (!fx) throw new Error('unknown fixture: ' + name);
  const q = hydrate(fx.quota);
  q.index = fx.index;
  if (typeof mutate === 'function') mutate(q);
  return q;
}

/** 全量 quotaByIndex；overrides 里给 undefined 表示该账号没有额度数据 */
function quotaMap(overrides) {
  const over = overrides || {};
  const m = new Map();
  for (const [name, fx] of Object.entries(FIX.accounts)) {
    const q = Object.prototype.hasOwnProperty.call(over, name) ? over[name] : quotaOf(name);
    if (q) m.set(fx.index, q);
  }
  return m;
}

/** decide 的基线入参：默认"reserve 在用、一切正常" */
function input(over) {
  return Object.assign({
    nowMs: NOW,
    activeIndex: FIX.accounts.reserve.index,
    accountCount: 3,
    quotaByIndex: quotaMap(),
    reserveIndex: RESERVE,
    minWaitMin: FIX.policy.minWaitMin,
    minGapSec: FIX.policy.minGapSec,
    autoSwitch: true,
    dryRun: false,
    lastSwitchAtMs: 0,
    lastStatus: '',
    lastWaitKey: '',
    lastWaitLogAtMs: 0,
    pausedIdx: [],
    policyPaused: [],
  }, over || {});
}

/* ================================ 1. 窗口分类 ================================ */

test('classifyWindows：储备号只有 7d 窗口 → short=null, weekly=primary', () => {
  const q = quotaOf('gmail');
  const win = core.classifyWindows(q);
  assert.equal(win.short, null, '储备号没有 5h 窗口');
  assert.ok(win.weekly, '应有周额度窗口');
  assert.equal(win.weekly.windowMinutes, 10080);
  assert.equal(win.weekly.usedPercent, 0);
});

test('classifyWindows：5h + 7d 双窗口按 windowMinutes 分开（qq 300/10080）', () => {
  const q = quotaOf('qq');
  const win = core.classifyWindows(q);
  assert.equal(win.short.windowMinutes, 300);
  assert.equal(win.short.usedPercent, 100);
  assert.equal(win.weekly.windowMinutes, 10080);
  assert.equal(win.weekly.usedPercent, 16);
});

test('classifyWindows：防御 windowMinutes 为 0/字符串、null 入参、阈值可覆盖', () => {
  // 0 分钟窗口在两条规则里都不成立（PS: -gt 0）
  const zero = core.classifyWindows({ primary: { usedPercent: 0, windowMinutes: 0 }, secondary: null });
  assert.equal(zero.short, null);
  assert.equal(zero.weekly, null);
  // 字符串数字照收
  const str = core.classifyWindows({ primary: { usedPercent: '0', windowMinutes: '10080' } });
  assert.equal(str.weekly.windowMinutes, '10080');
  assert.equal(str.short, null);
  // 400 分钟既不是 5h 也不是周额度
  assert.equal(core.classifyWindows({ primary: { windowMinutes: 400 } }).short, null);
  // 阈值可由 opts 覆盖
  const wide = core.classifyWindows({ primary: { windowMinutes: 400 } }, { window: { shortMaxMinutes: 600 } });
  assert.equal(wide.short.windowMinutes, 400);
  // 非对象入参不抛异常
  assert.deepEqual(core.classifyWindows(null), { short: null, weekly: null });
  assert.deepEqual(core.classifyWindows(undefined, {}), { short: null, weekly: null });
  assert.deepEqual(core.classifyWindows('nope'), { short: null, weekly: null });
});

/* ================================ 2. 账号快照 ================================ */

test('describeAccount：储备号 gmail 只有周额度 → used5/wait5 为 null，7d 未耗尽', () => {
  const st = core.describeAccount(quotaOf('gmail'), NOW);
  assert.equal(st.known, true);
  assert.equal(st.index, 0);
  assert.equal(st.planType, 'plus');
  assert.equal(st.used5, null);
  assert.equal(st.wait5, null);
  assert.equal(st.exh5, false);
  assert.equal(st.used7, 0);
  assert.equal(st.wait7, 9934.2);
  assert.equal(st.exh7, false);
});

test('describeAccount：qq 5h 100% 判耗尽，wait5 为分钟且保留 1 位小数', () => {
  const st = core.describeAccount(quotaOf('qq'), NOW);
  assert.equal(st.used5, 100);
  assert.equal(st.exh5, true);
  assert.equal(st.wait5, 23);
  assert.equal(st.used7, 16);
  assert.equal(st.exh7, false);
  assert.equal(st.wait7, 883.5);
});

test('describeAccount：缺数据 known=false；空对象 known=true；已过重置时间的 wait 为负数', () => {
  const missing = core.describeAccount(undefined, NOW);
  assert.deepEqual(missing, {
    index: null, known: false, used5: null, used7: null,
    exh5: false, exh7: false, expired5: false, expired7: false,
    wait5: null, wait7: null, planType: null,
  });
  // PS: if (-not $quota) 才 unknown —— 空对象仍是 known
  const empty = core.describeAccount({}, NOW);
  assert.equal(empty.known, true);
  assert.equal(empty.used5, null);
  // resetAtMs 已经过去 3 分钟 → 负数
  const late = core.describeAccount(
    { primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: NOW - 180000 } },
    NOW
  );
  assert.equal(late.wait5, -3);
  assert.equal(late.exh5, true);
  assert.equal(late.expired5, true, '重置时刻已过 → 上一窗口的 100% 不算耗尽');
});

/* ================================= 3. 决策 ================================= */

test('decide：当前账号 5h/7d 都没打满 → OK，且文案带额度快照', () => {
  const r = core.decide(input());
  assert.equal(r.action, 'OK');
  assert.equal(r.targetIndex, null);
  assert.equal(r.nextLogAtMs, null);
  assert.equal(r.reason, 'OK    账号3 有额度 (5h 0% / 7d 44%)');
  assert.equal(r.details.stoppedBy, 'ok');
  assert.equal(r.details.curIndex, 2);
  assert.equal(r.details.fresh, true);
});

test('decide：5h 耗尽且距重置 23 分钟 < 60 → WAIT，不切号，心跳 11.5 分钟', () => {
  const r = core.decide(input({ activeIndex: 1 }));
  assert.equal(r.action, 'WAIT');
  assert.equal(r.targetIndex, null);
  assert.equal(r.details.waitKeyKind, 'self');
  assert.equal(r.details.waitKey, 'WAIT|1|-');
  assert.equal(r.details.hbMinutes, 11.5);
  assert.equal(r.nextLogAtMs, NOW + 11.5 * 60000);
  assert.equal(r.reason, 'LIMIT 账号2 5h 额度耗尽，距重置约 23 分钟'
    + '\nWAIT  距 5h 重置仅 23 分钟 (<60)，按策略等待，不切号');
});

test('decide：WAIT 日志按心跳节流去重（同 key 且未到点 → fresh=false）', () => {
  const base = input({ activeIndex: 1, lastStatus: 'WAIT', lastWaitKey: 'WAIT|1|-' });
  const notYet = core.decide(Object.assign({}, base, { lastWaitLogAtMs: NOW - 60000 }));
  assert.equal(notYet.action, 'WAIT');
  assert.equal(notYet.details.fresh, false, '11.5 分钟间隔未到，不重复写日志');
  const due = core.decide(Object.assign({}, base, { lastWaitLogAtMs: NOW - 12 * 60000 }));
  assert.equal(due.details.fresh, true, '超过间隔应重新写日志');
  const changedKey = core.decide(Object.assign({}, base, { lastStatus: 'OK', lastWaitLogAtMs: NOW - 1000 }));
  assert.equal(changedKey.details.fresh, true, '状态变化立即写');
});

test('decide：wait 为负数（窗口重置时刻已过）→ 视为新窗口，不再负分钟 WAIT，账号按可用处理', () => {
  const q = quotaOf('qq', (x) => { x.primary.resetAtMs = NOW - 3 * 60000; });
  const r = core.decide(input({ activeIndex: 1, quotaByIndex: quotaMap({ qq: q }) }));
  assert.equal(r.action, 'OK', '缓存里的 100% 属于已重置的上一窗口，不应让策略空等');
  assert.equal(r.details.cur.wait5, -3);
  assert.equal(r.details.cur.expired5, true);
  assert.equal(r.reason, 'OK    账号2 有额度 (5h 已重置 / 7d 16%)');
});

test('decide：日常号 5h 窗口已重置 → 储备号在用也立刻回切（不再死等负分钟）', () => {
  const q = quotaOf('qq', (x) => { x.primary.resetAtMs = NOW - 10 * 60000; });
  const r = core.decide(input({ activeIndex: 0, quotaByIndex: quotaMap({ qq: q }) }));
  assert.equal(r.action, 'SWITCH');
  assert.equal(r.targetIndex, 1);
  assert.equal(r.details.reserveBack, true);
  assert.equal(r.details.why, '储备号在用，账号2 已恢复（5h 已重置 / 7d 16%）');
});

test('decide：5h 窗口已重置但周额度真的耗尽 → 仍不当可用（周窗口未重置）', () => {
  const q = quotaOf('qq', (x) => {
    x.primary.resetAtMs = NOW - 10 * 60000;
    x.secondary.usedPercent = 100;
  });
  const r = core.decide(input({ activeIndex: 1, quotaByIndex: quotaMap({ qq: q }) }));
  assert.equal(r.action, 'SWITCH');
  assert.equal(r.targetIndex, 2);
  assert.equal(r.details.why, '7d 周额度耗尽');
});

test('decide：5h 耗尽且 wait5=163.5 >= 60 → SWITCH 到有余量的日常号', () => {
  const q = quotaOf('qq', (x) => { x.primary.resetAtMs = NOW + 163.5 * 60000; });
  const r = core.decide(input({ activeIndex: 1, quotaByIndex: quotaMap({ qq: q }) }));
  assert.equal(r.action, 'SWITCH');
  assert.equal(r.targetIndex, 2);
  assert.equal(r.details.targetIsReserve, false);
  assert.equal(r.details.why, '5h 耗尽且距重置 163.5 分钟 >= 60');
  assert.equal(r.reason, 'LIMIT 账号2 5h 额度耗尽，距重置约 163.5 分钟'
    + '\nSWITCH 切换 2 -> 3（5h 耗尽且距重置 163.5 分钟 >= 60）');
});

test('decide：7d 周额度耗尽 → SWITCH，why 用周额度文案', () => {
  const q = quotaOf('qq', (x) => { x.secondary.usedPercent = 100; });
  const r = core.decide(input({ activeIndex: 1, quotaByIndex: quotaMap({ qq: q }) }));
  assert.equal(r.action, 'SWITCH');
  assert.equal(r.targetIndex, 2);
  assert.equal(r.details.cur.exh7, true);
  assert.equal(r.details.why, '7d 周额度耗尽');
  assert.ok(r.reason.startsWith('LIMIT 账号2 7d 周额度耗尽，距重置约 883.5 分钟（约 14.7 小时）'), r.reason);
  assert.ok(r.reason.includes('SWITCH 切换 2 -> 3（7d 周额度耗尽）'), r.reason);
});

test('decide：储备号在用且日常号已恢复 → SWITCH 回切日常号', () => {
  const r = core.decide(input({ activeIndex: 0 }));
  assert.equal(r.action, 'SWITCH');
  assert.equal(r.targetIndex, 2, 'qq 5h 打满，跳过；reserve 可用');
  assert.equal(r.details.reserveBack, true);
  assert.equal(r.details.why, '储备号在用，账号3 已恢复（5h 0% / 7d 44%）');
  assert.equal(r.reason, 'SWITCH 储备号用毕，切回 账号3（储备号在用，账号3 已恢复（5h 0% / 7d 44%））');
});

test('decide：储备号回切被 600 秒护栏拦住 → GUARD', () => {
  const r = core.decide(input({ activeIndex: 0, lastSwitchAtMs: NOW - 300000 }));
  assert.equal(r.action, 'GUARD');
  assert.equal(r.targetIndex, 2);
  assert.equal(r.details.guardScope, 'reserveBack');
  assert.equal(r.details.blocked, true);
  assert.equal(r.reason, 'GUARD 储备号在用，账号3 已恢复，但距上次切换不足 600 秒');
});

test('decide：选定目标后距上次切换不足 600 秒 → GUARD（DEAD 判定之后）', () => {
  const q = quotaOf('qq', (x) => { x.primary.resetAtMs = NOW + 163.5 * 60000; });
  const r = core.decide(input({
    activeIndex: 1,
    quotaByIndex: quotaMap({ qq: q }),
    lastSwitchAtMs: NOW - 120000,
  }));
  assert.equal(r.action, 'GUARD');
  assert.equal(r.targetIndex, 2, '被护栏拦住的目标仍可见');
  assert.equal(r.details.guardScope, 'switch');
  assert.equal(r.details.why, undefined, 'GUARD 不产出 why');
  assert.ok(r.reason.endsWith('GUARD 距上次切换不足 600 秒，跳过本次切换'), r.reason);
});

test('decide：全部账号 7d 耗尽 → DEAD，并给出最早恢复账号与时间', () => {
  const map = quotaMap({
    gmail: quotaOf('gmail', (x) => { x.primary.usedPercent = 100; }),
    qq: quotaOf('qq', (x) => { x.secondary.usedPercent = 100; }),
    reserve: quotaOf('reserve', (x) => { x.secondary.usedPercent = 100; }),
  });
  const r = core.decide(input({ quotaByIndex: map }));
  assert.equal(r.action, 'DEAD');
  assert.equal(r.targetIndex, null);
  assert.equal(r.details.earliestIndex, 1, 'qq 的 wait7=883.5 最早');
  assert.equal(r.details.earliestWait7, 883.5);
  assert.equal(r.details.earliestAtMs, NOW + 883.5 * 60000);
  assert.ok(r.reason.includes('最早恢复：账号2'), r.reason);
});

test('decide：全部账号 7d 耗尽但没有重置时间 → DEAD 且说明无法确定恢复时间', () => {
  // 注意 gmail 的周额度窗口在 primary，qq/reserve 在 secondary —— 按 windowMinutes 找，不按槽位
  const strip = (x) => {
    for (const key of ['primary', 'secondary']) {
      const w = x[key];
      if (!w || !(Number(w.windowMinutes) >= 10080)) continue;
      w.usedPercent = 100;
      delete w.resetAtMs;
    }
  };
  const map = quotaMap({
    gmail: quotaOf('gmail', strip),
    qq: quotaOf('qq', strip),
    reserve: quotaOf('reserve', strip),
  });
  const r = core.decide(input({ quotaByIndex: map }));
  assert.equal(r.action, 'DEAD');
  assert.equal(r.details.earliestIndex, null);
  assert.ok(r.reason.includes('无法确定恢复时间'), r.reason);
});

test('decide：autoSwitch=false → DISABLED，但仍给出应切目标与原因', () => {
  const q = quotaOf('qq', (x) => { x.primary.resetAtMs = NOW + 163.5 * 60000; });
  const r = core.decide(input({ activeIndex: 1, quotaByIndex: quotaMap({ qq: q }), autoSwitch: false }));
  assert.equal(r.action, 'DISABLED');
  assert.equal(r.targetIndex, 2);
  assert.ok(r.reason.includes('按规则应切换 2 -> 3（5h 耗尽且距重置 163.5 分钟 >= 60），已跳过'), r.reason);
});

test('decide：dryRun=true → action 仍是 SWITCH，但 details.dryRun 标记干跑且文案为 DRYRUN', () => {
  const q = quotaOf('qq', (x) => { x.primary.resetAtMs = NOW + 163.5 * 60000; });
  const r = core.decide(input({ activeIndex: 1, quotaByIndex: quotaMap({ qq: q }), dryRun: true }));
  assert.equal(r.action, 'SWITCH');
  assert.equal(r.details.dryRun, true);
  assert.equal(r.targetIndex, 2);
  assert.ok(r.reason.includes('DRYRUN 将切换 2 -> 3'), r.reason);
});

test('decide：日常号都不可用时启用储备号，why 带备注', () => {
  const exhaust5h = (x) => { x.primary.usedPercent = 100; x.primary.resetAtMs = NOW + 163.5 * 60000; };
  const map = quotaMap({
    qq: quotaOf('qq', exhaust5h),
    reserve: quotaOf('reserve', exhaust5h),
  });
  const r = core.decide(input({ activeIndex: 1, quotaByIndex: map }));
  assert.equal(r.action, 'SWITCH');
  assert.equal(r.targetIndex, 0, '储备号 gmail');
  assert.equal(r.details.targetIsReserve, true);
  assert.equal(r.details.why, '5h 耗尽且距重置 163.5 分钟 >= 60；日常号均不可用，启用储备号');
  assert.ok(r.reason.includes('SWITCH 切换 2 -> 1'), r.reason);
});

test('decide：日常号有周额度但 5h 仅需等 12 分钟 → WAIT(cand)，不动用储备号', () => {
  const q = quotaOf('qq', (x) => { x.primary.resetAtMs = NOW + 163.5 * 60000; });
  const near = quotaOf('reserve', (x) => {
    x.primary.usedPercent = 100;
    x.primary.resetAtMs = NOW + 12 * 60000;
  });
  const r = core.decide(input({
    activeIndex: 1,
    quotaByIndex: quotaMap({ qq: q, reserve: near }),
  }));
  assert.equal(r.action, 'WAIT');
  assert.equal(r.targetIndex, null);
  assert.equal(r.details.waitKeyKind, 'cand');
  assert.equal(r.details.candIndex, 2);
  assert.equal(r.details.waitKey, 'WAIT|1|2');
  assert.equal(r.nextLogAtMs, NOW + 6 * 60000);
  assert.ok(r.reason.includes('WAIT  账号3 有周额度但 5h 打满，仅需等 12 分钟 (<60)'), r.reason);
});

/* ============================ 4. 异常与防御性输入 ============================ */

test('decide：账号池为空 → ERROR 账号池为空', () => {
  const r = core.decide(input({ accountCount: 0, quotaByIndex: {} }));
  assert.equal(r.action, 'ERROR');
  assert.equal(r.reason, 'ERROR 账号池为空');
  assert.equal(r.targetIndex, null);
  assert.equal(r.details.stoppedBy, 'error');
});

test('decide：activeIndex 越界/字符串数字 → ERROR activeIndex 异常', () => {
  const over = core.decide(input({ activeIndex: 5 }));
  assert.equal(over.action, 'ERROR');
  assert.equal(over.reason, 'ERROR activeIndex 异常: 5（账号数 3）');
  const str = core.decide(input({ activeIndex: '5' }));
  assert.equal(str.action, 'ERROR');
  assert.equal(str.reason, 'ERROR activeIndex 异常: 5（账号数 3）');
  const neg = core.decide(input({ activeIndex: -1 }));
  assert.equal(neg.reason, 'ERROR activeIndex 异常: -1（账号数 3）');
});

test('decide：当前账号没有额度数据 → SKIP（账号池正常）', () => {
  const map = quotaMap({ reserve: undefined });
  const r = core.decide(input({ quotaByIndex: map }));
  assert.equal(r.action, 'SKIP');
  assert.equal(r.reason, 'SKIP  账号3 无额度数据');
  assert.equal(r.details.stoppedBy, 'skip');
});

test('decide：日常号全部被手动暂停 → WARN（且先于 SKIP 判定）', () => {
  const r = core.decide(input({ pausedIdx: [1, 2] }));
  assert.equal(r.action, 'WARN');
  assert.equal(r.details.stoppedBy, 'warn');
  assert.equal(r.reason, 'WARN  日常号池为空（暂停中：2,3）；当前只会在储备号上运行，请检查 account pause 状态');
  // 当前账号完全没有额度数据，仍应先报 WARN（PS 的顺序）
  const warnFirst = core.decide(input({ pausedIdx: [1, 2], quotaByIndex: quotaMap({ reserve: undefined }) }));
  assert.equal(warnFirst.action, 'WARN');
});

test('decide：轮转自动暂停只算冷却（policyPaused 命中 → 仍算日常号）', () => {
  const r = core.decide(input({
    activeIndex: 1,
    pausedIdx: [1, 2],
    policyPaused: [2],
  }));
  assert.deepEqual(r.details.daily, [1], '账号2 是自动暂停的冷却，不该永久排除');
  assert.deepEqual(r.details.policyPaused, [2]);
  assert.equal(r.action, 'WAIT', 'qq 自身 5h 快恢复，回到 WAIT 分支');
});

test('decide：drained 账号永不成为目标，priority/weight 决定候选顺序', () => {
  const q = (used) => hydrate({
    primary: { usedPercent: used, windowMinutes: 300, resetInMin: 120 },
    secondary: { usedPercent: 10, windowMinutes: 10080, resetInMin: 5000 },
  });
  const d = core.decide(input({
    activeIndex: 1,
    quotaByIndex: new Map([[0, q(100)], [1, q(100)], [2, q(0)]]),
    policyByIndex: {
      0: { emergencyOnly: true },
      1: { priority: 9, weight: 1 },
      2: { priority: 1, weight: 1, drained: true },
    },
    emergencyOnlyIndexes: [0],
  }));
  assert.equal(d.action, 'DEAD', '唯一可用号被 drained 后不能被切入');
});

test('decide：多个 emergency-only 账号全部从日常池排除，并可选第一个健康储备号', () => {
  const q = (used) => hydrate({
    primary: { usedPercent: used, windowMinutes: 300, resetInMin: 120 },
    secondary: { usedPercent: 10, windowMinutes: 10080, resetInMin: 5000 },
  });
  const d = core.decide(input({
    activeIndex: 2,
    quotaByIndex: new Map([[0, q(100)], [1, q(100)], [2, q(100)], [3, q(0)]]),
    accountCount: 4,
    emergencyOnlyIndexes: [0, 3],
    policyByIndex: { 0: { emergencyOnly: true }, 3: { emergencyOnly: true } },
  }));
  assert.equal(d.action, 'SWITCH');
  assert.equal(d.targetIndex, 3);
  assert.equal(d.details.targetIsReserve, true);
});

test('decide：缺 nowMs / 非对象入参 → ERROR，绝不抛异常', () => {
  for (const bad of [undefined, null, 'x', 42, []]) {
    const r = core.decide(bad);
    assert.equal(r.action, 'ERROR');
    assert.equal(r.nextLogAtMs, null);
    assert.equal(typeof r.reason, 'string');
    assert.equal(typeof r.details, 'object');
  }
  const r = core.decide({ accountCount: 3, activeIndex: 0 });
  assert.equal(r.action, 'ERROR');
  assert.ok(r.reason.includes('缺少 nowMs'), r.reason);
});

test('decide：字符串数字入参、对象形 quotaByIndex 都能决策，且不修改入参', () => {
  const gmail = quotaOf('gmail');
  const qq = quotaOf('qq');
  const reserve = quotaOf('reserve');
  const objectMap = { 0: gmail, 1: qq, 2: reserve };
  const snapshot = JSON.stringify(objectMap);
  const r = core.decide({
    nowMs: String(NOW),
    activeIndex: '1',
    accountCount: '3',
    quotaByIndex: objectMap,
    reserveIndex: '1',
    minWaitMin: '60',
    minGapSec: '600',
    autoSwitch: true,
    lastSwitchAtMs: '0',
  });
  assert.equal(r.action, 'WAIT');
  assert.equal(r.details.curIndex, 1);
  assert.equal(JSON.stringify(objectMap), snapshot, '入参必须保持不变');
  // 数组形 quotaByIndex 同样可用
  const arr = core.decide(input({ activeIndex: 1, quotaByIndex: [gmail, qq, reserve] }));
  assert.equal(arr.action, 'WAIT');
});

/* ============================== 5. 心跳与去重键 ============================== */

test('heartbeatMinutes：对数（折半）间隔的边界（120/60/59/10/9/1/null）', () => {
  assert.equal(core.heartbeatMinutes(120), 60, '= waitMin/2，夹到上限 60');
  assert.equal(core.heartbeatMinutes(60), 30, '半程 30 分钟');
  assert.equal(core.heartbeatMinutes(59), 29.5);
  assert.equal(core.heartbeatMinutes(10), 5);
  assert.equal(core.heartbeatMinutes(9), 4.5);
  assert.equal(core.heartbeatMinutes(1), 2);
  assert.equal(core.heartbeatMinutes(0), 2);
  assert.equal(core.heartbeatMinutes(-5), 2, '重置已过仍按临界区 2 分钟');
  assert.equal(core.heartbeatMinutes(null), null);
  assert.equal(core.heartbeatMinutes(undefined), null);
  assert.equal(core.heartbeatMinutes('45'), 22.5, '字符串数字');
  assert.equal(core.heartbeatMinutes(200), 60, '上限夹紧');
  assert.equal(core.heartbeatMinutes(90, { heartbeat: { divisor: 3 } }), 30, 'opts 覆盖');
});

test('nextHeartbeatMs：返回绝对毫秒时间戳；waitMin 不可解析 → null', () => {
  assert.equal(core.nextHeartbeatMs(NOW, 120), NOW + 60 * 60000);
  assert.equal(core.nextHeartbeatMs(NOW, 23), NOW + 11.5 * 60000);
  assert.equal(core.nextHeartbeatMs(NOW, 3), NOW + 2 * 60000);
  assert.equal(core.nextHeartbeatMs(NOW, null), null);
  assert.equal(core.nextHeartbeatMs(NOW, 'abc'), null);
  assert.equal(core.nextHeartbeatMs(NOW, 23, { heartbeat: { divisor: 3 } }), NOW + 7.7 * 60000);
});

test('noiseKey：稳定字符串，缺省下标为 "-"，status 统一大写', () => {
  assert.equal(core.noiseKey('WAIT', 1, null), 'WAIT|1|-');
  assert.equal(core.noiseKey('WAIT', 1, 2), 'WAIT|1|2');
  assert.equal(core.noiseKey('wait', '1', undefined), 'WAIT|1|-', '大小写与字符串数字归一');
  assert.equal(core.noiseKey('WAIT', 1, 2), core.noiseKey('WAIT', 1, 2), '同参必同值');
  assert.notEqual(core.noiseKey('WAIT', 1, 2), core.noiseKey('WAIT', 2, 1), '方向不同即不同键');
  assert.equal(core.noiseKey(null, null, null), 'UNKNOWN|-|-');
  assert.equal(core.noiseKey('  switch  ', '0', '3'), 'SWITCH|0|3');
});

/* ================================= 6. 契约 ================================= */

test('契约：decide 永远返回 action ∈ ACTIONS 且字段齐全（抽样跑一遍主要分支）', () => {
  const cases = [
    input(),
    input({ activeIndex: 1 }),
    input({ activeIndex: 0 }),
    input({ activeIndex: 0, lastSwitchAtMs: NOW - 1000 }),
    input({ activeIndex: 5 }),
    input({ accountCount: 0, quotaByIndex: {} }),
    input({ quotaByIndex: quotaMap({ reserve: undefined }) }),
    input({ pausedIdx: [1, 2] }),
    input({ activeIndex: 1, autoSwitch: false }),
    input({ activeIndex: 1, dryRun: true }),
    core.decide(undefined),
  ];
  for (const inputCase of cases) {
    const r = core.decide(inputCase);
    assert.ok(core.ACTIONS.includes(r.action), '未知 action: ' + r.action);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0);
    assert.ok(r.targetIndex === null || (Number.isInteger(r.targetIndex) && r.targetIndex >= 0));
    assert.ok(r.nextLogAtMs === null || Number.isFinite(r.nextLogAtMs));
    assert.equal(typeof r.details, 'object');
    assert.equal(r.details.stoppedBy !== undefined, true, 'details.stoppedBy 便于断言');
    // 结果本身必须可 JSON 序列化（要写日志）
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)));
  }
});

test('WARN 只在状态变化时才算 fresh（避免每轮刷日志）', () => {
  const input = {
    nowMs: Date.parse("2026-10-26T10:00:00Z"),
    activeIndex: 0,
    accountCount: 3,
    reserveIndex: 1,
    autoSwitch: true,
    minWaitMin: 60,
    quotaByIndex: {
      0: { primary: { usedPercent: 0, windowMinutes: 10080 } },
      1: { primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: Date.parse('2026-10-26T11:00:00Z') } },
      2: { primary: { usedPercent: 100, windowMinutes: 300, resetAtMs: Date.parse('2026-10-26T11:00:00Z') } },
    },
    // 两个日常号都被手动暂停（policyPaused 是“轮转自动暂停”的冷却标记，不能算手动暂停）
    pausedIdx: [1, 2],
    policyPaused: [],
    lastStatus: "OK",
  };
  const first = core.decide(input);
  assert.strictEqual(first.action, 'WARN');
  assert.strictEqual(first.details.fresh, true, "从 OK 变为 WARN 应写日志");

  const again = core.decide(Object.assign({}, input, { lastStatus: "WARN" }));
  assert.strictEqual(again.action, 'WARN');
  assert.strictEqual(again.details.fresh, false, "连续 WARN 不应重复写日志");
});
