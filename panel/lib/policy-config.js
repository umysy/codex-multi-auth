'use strict';

/**
 * policy-config.js — 策略配置的唯一权威：字段名、默认值、钳位规则。
 *
 * 谁在用（改这里，三端一起变）：
 *   - panel/server.js       HTTP API 读写 panel-config.json（GET/POST /api/policy）
 *   - panel/lib/policy-decision.js  决策前把内存配置归一（PS1 也走这条链）
 *   - panel/public/app.js   只用 /api/policy 返回的 minMinWait/maxMinWait 渲染滑杆
 *
 * 约定：
 *   - 只做纯计算：无 I/O、无环境变量、无依赖、不抛异常（脏输入回落默认值）；
 *   - minWaitMin 单位分钟，夹在 [5, 600]；reserveIndex 是 1 基，最小 1；
 *   - panel-config.json 里可能还有别的字段（如 allowFailover），这里只认这 3 个。
 */

/** 滑杆下限（分钟）。PS: [math]::Max(5, $cfg.minWaitMin) */
const MIN_WAIT_MIN = 5;
/** 滑杆上限（分钟）。UI 与 API 的共同上限 */
const MAX_WAIT_MIN = 600;
/** 缺省等待阈值（分钟）。PS: 默认 60 */
const DEFAULT_MIN_WAIT_MIN = 60;
/** 缺省储备号（1 基） */
const DEFAULT_RESERVE_INDEX = 1;

/** 唯一默认值对象（冻结，防调用方改全局默认） */
const DEFAULT_POLICY = Object.freeze({
  autoSwitch: true,
  minWaitMin: DEFAULT_MIN_WAIT_MIN,
  reserveIndex: DEFAULT_RESERVE_INDEX,
});

function isFiniteNumber(v) {
  const n = Number(v);
  return Number.isFinite(n);
}

/** minWaitMin：非数字/非正数回落 60；四舍五入后夹在 [5,600] */
function clampMinWaitMin(v) {
  const raw = isFiniteNumber(v) && Number(v) > 0 ? Number(v) : DEFAULT_MIN_WAIT_MIN;
  return Math.min(MAX_WAIT_MIN, Math.max(MIN_WAIT_MIN, Math.round(raw)));
}

/** reserveIndex：非数字/非正数回落 1；四舍五入后最小 1（无上限，账号数由 decide 兜底） */
function clampReserveIndex(v) {
  const raw = isFiniteNumber(v) && Number(v) > 0 ? Number(v) : DEFAULT_RESERVE_INDEX;
  return Math.max(1, Math.round(raw));
}

/**
 * 任意配置对象 → 规范化的 3 字段配置（无额外字段，可直接落盘）。
 * @param {object} [raw]
 * @returns {{autoSwitch: boolean, minWaitMin: number, reserveIndex: number}}
 */
function normalizePolicy(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    autoSwitch: o.autoSwitch !== false,
    minWaitMin: clampMinWaitMin(o.minWaitMin),
    reserveIndex: clampReserveIndex(o.reserveIndex),
  };
}

/**
 * 面向 UI 的视图：规范化字段 + 滑杆边界（/api/policy 的响应形状）。
 * @param {object} [raw]
 * @returns {{autoSwitch: boolean, minWaitMin: number, reserveIndex: number,
 *            minMinWait: number, maxMinWait: number}}
 */
function policyView(raw) {
  return Object.assign(normalizePolicy(raw), {
    minMinWait: MIN_WAIT_MIN,
    maxMinWait: MAX_WAIT_MIN,
  });
}

module.exports = {
  DEFAULT_POLICY,
  normalizePolicy,
  policyView,
  clampMinWaitMin,
  clampReserveIndex,
  MIN_WAIT_MIN,
  MAX_WAIT_MIN,
  DEFAULT_MIN_WAIT_MIN,
  DEFAULT_RESERVE_INDEX,
};
