'use strict';
/**
 * 额度耗尽账号的暂停/恢复计划（panel/policy-core.js planExhaustionPauses）。
 *
 * 背景：运行时会按"缓存额度"把 5h 已满的号当成可用，请求派过去 → 上游 429 →
 * Codex 界面直接显示"额度用完，等到 X 点重置"，其它账号明明有额度却在闲着。
 * 所以策略每轮要把耗尽的日常号暂停、窗口重置后再恢复。
 *
 * 运行：node --test panel/test/policy-pauses.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { planExhaustionPauses } = require('../policy-core');

const NOW = 1700000000000;
const HOUR = 3600000;

/** 造一个窗口；used=null 表示该账号没有这个窗口 */
function win(used, windowMinutes, resetInHours) {
  if (used === null) return null;
  return { usedPercent: used, windowMinutes, resetAtMs: NOW + (resetInHours || 1) * HOUR };
}

/** 造 quota；daily5=5h 已用百分比，weekly=7d 已用百分比 */
function quota(daily5, weekly, planType) {
  return {
    planType: planType || 'plus',
    primary: win(daily5, 300, 2),
    secondary: win(weekly, 10080, 120),
  };
}

function input(quotas, extra) {
  const quotaByIndex = {};
  quotas.forEach((q, i) => { quotaByIndex[String(i)] = q; });
  return Object.assign({ nowMs: NOW, accountCount: quotas.length, quotaByIndex }, extra || {});
}

test('5h 耗尽 + 未暂停 → 暂停；储备号不参与', () => {
  const plan = planExhaustionPauses(
    input([quota(0, 0), quota(40, 20), quota(100, 30)], { reserveIndex: 1 })
  );
  assert.deepStrictEqual(plan.pause, [3], '只有日常号 3 耗尽');
  assert.deepStrictEqual(plan.resume, []);
  assert.deepStrictEqual(plan.nextExhaustedPaused, [3]);
});

test('储备号即使耗尽也不暂停（由 decide 的储备号分支负责）', () => {
  const plan = planExhaustionPauses(
    input([quota(100, 100), quota(10, 5)], { reserveIndex: 1 })
  );
  assert.deepStrictEqual(plan.pause, []);
  assert.deepStrictEqual(plan.nextExhaustedPaused, []);
});

test('周额度耗尽（≥97%）同样暂停', () => {
  const plan = planExhaustionPauses(
    input([quota(0, 0), quota(10, 98)], { reserveIndex: 1 })
  );
  assert.deepStrictEqual(plan.pause, [2]);
});

test('已在暂停列表里的账号不重复暂停', () => {
  const plan = planExhaustionPauses(
    input([quota(0, 0), quota(100, 30)], { reserveIndex: 1, pausedIdx: [1] })
  );
  assert.deepStrictEqual(plan.pause, []);
  assert.deepStrictEqual(plan.nextExhaustedPaused, []);
});

test('本策略暂停过、额度已恢复 → 恢复并从跟踪列表移除', () => {
  const plan = planExhaustionPauses(
    input([quota(0, 0), quota(5, 10)], { reserveIndex: 1, pausedIdx: [1], exhaustedPaused: [2] })
  );
  assert.deepStrictEqual(plan.resume, [2]);
  assert.deepStrictEqual(plan.pause, []);
  assert.deepStrictEqual(plan.nextExhaustedPaused, []);
});

test('本策略暂停过、仍耗尽 → 不重复调用 pause，继续跟踪', () => {
  const plan = planExhaustionPauses(
    input([quota(0, 0), quota(100, 30)], { reserveIndex: 1, pausedIdx: [1], exhaustedPaused: [2] })
  );
  assert.deepStrictEqual(plan.pause, []);
  assert.deepStrictEqual(plan.resume, []);
  assert.deepStrictEqual(plan.nextExhaustedPaused, [2]);
});

test('跟踪中的账号暂时没有额度数据 → 不恢复，继续跟踪', () => {
  const plan = planExhaustionPauses(
    input([quota(0, 0), null], { reserveIndex: 1, pausedIdx: [1], exhaustedPaused: [2] })
  );
  assert.deepStrictEqual(plan.resume, []);
  assert.deepStrictEqual(plan.nextExhaustedPaused, [2]);
});

test('用户手动解除过暂停但账号仍耗尽 → 重新暂停（否则运行时又会派单）', () => {
  const plan = planExhaustionPauses(
    input([quota(0, 0), quota(100, 30)], { reserveIndex: 1, pausedIdx: [], exhaustedPaused: [2] })
  );
  assert.deepStrictEqual(plan.pause, [2], '耗尽且未暂停 → 必须重新暂停');
  assert.deepStrictEqual(plan.nextExhaustedPaused, [2]);
});

test('越界/储备号的跟踪项被清理', () => {
  const plan = planExhaustionPauses(
    input([quota(0, 0), quota(10, 5)], { reserveIndex: 1, exhaustedPaused: [1, 2, 99] })
  );
  assert.deepStrictEqual(plan.nextExhaustedPaused, [], '账号 1 是储备号、99 越界、账号 2 已恢复');
});

test('重置时刻已过（expired*）不再算耗尽：跟踪中的账号恢复、未跟踪的也不暂停', () => {
  const stale = (daily5, weekly) => {
    const q = quota(daily5, weekly);
    q.primary.resetAtMs = NOW - 10 * 60 * 1000; // 5h 窗口已重置
    return q;
  };
  const plan = planExhaustionPauses(input(
    [quota(0, 0), stale(100, 30), stale(100, 30)],
    { reserveIndex: 1, pausedIdx: [1, 2], exhaustedPaused: [2, 3] }
  ));
  assert.deepStrictEqual(plan.resume, [2, 3], '窗口已重置 → 恢复本策略暂停过的账号');
  assert.deepStrictEqual(plan.pause, [], '过期窗口不能再暂停');
  assert.deepStrictEqual(plan.nextExhaustedPaused, [], '恢复后不再跟踪');
});

test('周额度窗口重置（usedPercent 仍是上一窗口的 100%）同样按已恢复处理', () => {
  const q = quota(10, 100);
  q.secondary.resetAtMs = NOW - HOUR;
  const plan = planExhaustionPauses(
    input([quota(0, 0), q], { reserveIndex: 1, pausedIdx: [1], exhaustedPaused: [2] })
  );
  assert.deepStrictEqual(plan.resume, [2]);
  assert.deepStrictEqual(plan.pause, []);
});

test('窗口尚未重置（wait>0）仍按耗尽暂停，不能被过期判定放过', () => {
  const soon = quota(100, 30);
  soon.primary.resetAtMs = NOW + 12 * 60 * 1000;
  const plan = planExhaustionPauses(input([quota(0, 0), soon], { reserveIndex: 1 }));
  assert.deepStrictEqual(plan.pause, [2]);
  assert.deepStrictEqual(plan.nextExhaustedPaused, [2]);
});

test('缺 nowMs：不猜时间，只清理跟踪列表', () => {
  const plan = planExhaustionPauses(
    input([quota(100, 30), quota(0, 0)], { nowMs: undefined, reserveIndex: 1, exhaustedPaused: [2] })
  );
  assert.deepStrictEqual(plan.pause, []);
  assert.deepStrictEqual(plan.resume, []);
  assert.deepStrictEqual(plan.nextExhaustedPaused, [2]);
});

test('CLI plan-pauses：--in/--out 返回 {ok:true, plan}', () => {
  const cli = path.join(__dirname, '..', 'policy-cli.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-pauses-'));
  try {
    const inFile = path.join(dir, 'in.json');
    const outFile = path.join(dir, 'out.json');
    fs.writeFileSync(inFile, JSON.stringify(input([quota(0, 0), quota(100, 30)], { reserveIndex: 1 })), 'utf8');
    const res = spawnSync(process.execPath, [cli, 'plan-pauses', '--in', inFile, '--out', outFile], { encoding: 'utf8' });
    assert.strictEqual(res.status, 0, 'CLI 应成功：' + (res.stderr || '').trim());
    const parsed = JSON.parse(fs.readFileSync(outFile, 'utf8').replace(/^\uFEFF/, ''));
    assert.strictEqual(parsed.ok, true);
    assert.deepStrictEqual(parsed.plan.pause, [2]);
    assert.deepStrictEqual(parsed.plan.nextExhaustedPaused, [2]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
