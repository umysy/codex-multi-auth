'use strict';

/**
 * policy-decision.js — 决策的唯一入口：先归一配置，再交给 policy-core.decide 纯函数。
 *
 * 为什么要多这一层：
 *   - config（panel-config.json）和 decision（policy-core）各自知道一部分字段名；
 *   - 把"归一"和"判断"钉在一个函数里，调用方（HTTP /api/policy/preview、PS1 的
 *     policy-cli）就不需要重复这两步，也不会各自实现出不同版本。
 *
 * 不抛异常、不修改入参；所有脏输入都被 policy-core 收敛成 action='ERROR'。
 */

const { decide } = require('../policy-core');
const { normalizePolicy } = require('./policy-config');
const { decideRotation } = require('./rotation-policy');

/**
 * @param {object} rawInput policy-core.decide 的入参（扁平结构），可带未归一化的
 *                         autoSwitch/minWaitMin/reserveIndex
 * @returns {{action: string, reason: string, targetIndex: number|null,
 *            nextLogAtMs: number|null, details: object}}
 */
function decideWithPolicy(rawInput) {
  const raw = rawInput && typeof rawInput === 'object' ? rawInput : {};
  const merged = Object.assign({}, raw, normalizePolicy(raw));
  // dryRun 只接受明确的 true（与 policy-core 的 policyOpts 保持一致）
  if (raw.dryRun === true) merged.dryRun = true;
  return raw.rotation ? decideRotation(merged) : decide(merged);
}

module.exports = { decideWithPolicy };
