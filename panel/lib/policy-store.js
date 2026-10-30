'use strict';
/**
 * 策略配置与策略脚本运行状态的读写。
 *
 * 配置语义唯一权威在 lib/policy-config.js；本模块只负责“读写那个文件”。
 */
const paths = require('./paths');
const { readJson, readJsonResult, writeJson } = require('./fs-json');
const { AppError } = require('./errors');
const { DEFAULT_POLICY, normalizePolicy, policyView } = require('./policy-config');
const { validateRotation } = require('./rotation-policy');

/** quota-policy.ps1 最近一次运行状态：用于 UI 暴露“自动切号是否还在工作”。 */
function readSchedule() {
  const s = readJson(paths.SCHEDULE_FILE, null);
  if (!s || typeof s !== 'object') return null;
  return {
    lastStatus: typeof s.lastStatus === 'string' ? s.lastStatus : '',
    runId: typeof s.runId === 'string' && /^[a-f0-9]{16}$/.test(s.runId) ? s.runId : null,
    errorCode: typeof s.errorCode === 'string' && /^[A-Z_]{1,64}$/.test(s.errorCode) ? s.errorCode : null,
    lastStatusAtMs: Number(s.lastStatusAtMs) || 0,
    lastSwitchAtMs: Number(s.lastSwitchAtMs) || 0,
    from: Number(s.from) || 0,
    to: Number(s.to) || 0,
    policyPaused: Array.isArray(s.policyPaused) ? s.policyPaused.map(Number).filter(Number.isFinite) : [],
    lastRunAtMs: Number(s.lastRunAtMs) || 0,
    tickCount: Number(s.tickCount) || 0,
    nextLogAtMs: Number(s.nextLogAtMs) || 0,
    lastWaitKey: typeof s.lastWaitKey === 'string' ? s.lastWaitKey : '',
  };
}

function loadPolicy() {
  const result = readJsonResult(paths.CONFIG);
  if (!result.exists) { writeJson(paths.CONFIG, DEFAULT_POLICY); return policyView(DEFAULT_POLICY); }
  if (!result.ok || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) {
    throw new AppError('POLICY_CONFIG_INVALID', '策略配置无法解析，已停止读取以保护现有设置', { status: 500, cause: result.error });
  }
  const cfg = result.value;
  let rotation;
  if (cfg.rotation) {
    try { rotation = validateRotation(cfg.rotation); }
    catch (cause) { throw new AppError('ROTATION_CONFIG_INVALID', '自定义规则无法读取，已停止执行，请检查规则版本、绑定及阈值', { status: 500, cause }); }
  }
  return Object.assign(policyView(cfg), rotation ? { rotation } : {});
}

function savePolicy(next) {
  // 只归一化 UI 认识的三项；文件里其它字段（如策略脚本用的 allowFailover）原样保留，
  // 否则"在面板上点一次保存"会静默抹掉脚本侧的配置。
  const currentResult = readJsonResult(paths.CONFIG);
  if (currentResult.exists && (!currentResult.ok || !currentResult.value || typeof currentResult.value !== 'object' || Array.isArray(currentResult.value))) {
    throw new AppError('POLICY_CONFIG_INVALID', '策略配置损坏，拒绝覆盖原文件', { status: 409, cause: currentResult.error });
  }
  const base = currentResult.value || {};
  const policy = normalizePolicy({ ...base, ...next });
  if (Object.prototype.hasOwnProperty.call(next, 'rotation')) {
    try { base.rotation = next.rotation === null ? null : validateRotation(next.rotation); }
    catch { throw new AppError('ROTATION_CONFIG_INVALID', '轮换配置无效：请检查账号绑定、重复账号及阈值', { status: 400 }); }
  }
  writeJson(paths.CONFIG, Object.assign({}, base, policy));
  return Object.assign(policy, base.rotation ? { rotation: base.rotation } : {});
}

module.exports = { readSchedule, loadPolicy, savePolicy };
