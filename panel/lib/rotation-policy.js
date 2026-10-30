'use strict';

const { describeAccount, isHardRuntimeReason } = require('../policy-core');
const { classifyReason } = require('./runtime-health');

// Public configuration uses opaque accountKey values, never positional indexes.
function validateRotation(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error('rotation must be an object');
  if (r.mode !== 'daily-reserve') throw new Error('rotation.mode must be daily-reserve');
  const fields = ['mode', 'version', 'daily', 'reserve', 'dailySelection', 'accountRules', 'shortUsedPercent', 'weeklyUsedPercent', 'returnToDaily', 'waitBeforeSwitchMin', 'minGapSec'];
  if (Object.keys(r).some(k => !fields.includes(k))) throw new Error('rotation contains an unsupported field');
  if (r.version !== undefined && r.version !== 1) throw new Error('rotation.version must be 1');
  if (r.dailySelection !== undefined && !['cycle', 'priority'].includes(r.dailySelection)) throw new Error('rotation.dailySelection must be cycle or priority');
  const keys = [...(Array.isArray(r.daily) ? r.daily : []), ...(Array.isArray(r.reserve) ? r.reserve : [])];
  if (!Array.isArray(r.daily) || !r.daily.length || !Array.isArray(r.reserve)) throw new Error('rotation requires daily and reserve arrays');
  if (keys.some(k => typeof k !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(k)) || new Set(keys).size !== keys.length) throw new Error('rotation account keys must be unique sha256 keys');
  for (const key of ['shortUsedPercent', 'weeklyUsedPercent']) {
    if (r[key] !== undefined && (!Number.isFinite(r[key]) || r[key] < 1 || r[key] > 100)) throw new Error('rotation.' + key + ' must be between 1 and 100');
  }
  if (r.returnToDaily !== undefined && typeof r.returnToDaily !== 'boolean') throw new Error('rotation.returnToDaily must be boolean');
  if (r.waitBeforeSwitchMin !== undefined && (!Number.isFinite(r.waitBeforeSwitchMin) || r.waitBeforeSwitchMin < 0 || r.waitBeforeSwitchMin > 600)) throw new Error('rotation.waitBeforeSwitchMin must be between 0 and 600');
  if (r.minGapSec !== undefined && (!Number.isFinite(r.minGapSec) || r.minGapSec < 0 || r.minGapSec > 3600)) throw new Error('rotation.minGapSec must be between 0 and 3600');
  const accountRules = {};
  if (r.accountRules !== undefined) {
    if (!r.accountRules || typeof r.accountRules !== 'object' || Array.isArray(r.accountRules)) throw new Error('rotation.accountRules must be an object');
    for (const [key, rules] of Object.entries(r.accountRules)) {
      if (!keys.includes(key) || !rules || typeof rules !== 'object' || Array.isArray(rules)) throw new Error('rotation.accountRules must reference a configured account');
      const clean = {};
      for (const [name, value] of Object.entries(rules)) {
        const max = name === 'waitBeforeSwitchMin' ? 600 : 100;
        const min = name === 'waitBeforeSwitchMin' ? 0 : 1;
        if (!['shortUsedPercent', 'weeklyUsedPercent', 'waitBeforeSwitchMin'].includes(name) || !Number.isFinite(value) || value < min || value > max) throw new Error('rotation.accountRules has an invalid threshold');
        clean[name] = value;
      }
      accountRules[key] = clean;
    }
  }
  return { mode: r.mode, daily: r.daily.slice(), reserve: r.reserve.slice(), shortUsedPercent: r.shortUsedPercent ?? 100, weeklyUsedPercent: r.weeklyUsedPercent ?? 100, returnToDaily: r.returnToDaily !== false, ...(r.version !== undefined ? { version: 1 } : {}), ...(r.dailySelection !== undefined ? { dailySelection: r.dailySelection } : {}), ...(r.accountRules !== undefined ? { accountRules } : {}), ...(r.waitBeforeSwitchMin !== undefined ? { waitBeforeSwitchMin: r.waitBeforeSwitchMin } : {}), ...(r.minGapSec !== undefined ? { minGapSec: r.minGapSec } : {}) };
}

function quotaState(a, i, config) {
  const q = a.quotaByIndex instanceof Map ? a.quotaByIndex.get(i) : a.quotaByIndex?.[i];
  const st = describeAccount(q, a.nowMs);
  const p = a.policyByIndex?.[i] || {};
  const thresholds = { ...config, ...config.accountRules?.[p.accountKey] };
  const owned = new Set([...(a.policyPaused || []), ...(a.exhaustedPaused || [])]);
  const used = [st.used5, st.used7].filter(v => v !== null);
  st.known = st.known && used.length > 0 && used.every(v => v >= 0 && v <= 100) && !(Number(q?.status) >= 400);
  st.exh5 = st.used5 !== null && st.used5 >= thresholds.shortUsedPercent;
  st.exh7 = st.used7 !== null && st.used7 >= thresholds.weeklyUsedPercent;
  st.waitThreshold = thresholds.waitBeforeSwitchMin ?? a.minWaitMin ?? 60;
  const runtimeReason = a.runtimeBlocked instanceof Map ? a.runtimeBlocked.get(i) : a.runtimeBlocked?.[i];
  st.unavailable = isHardRuntimeReason(runtimeReason) ||
    ((p.paused || (a.pausedIdx || []).includes(i)) && !owned.has(i + 1)) || p.drained === true || p.enabled === false || p.authInvalidated === true;
  // Reserve accounts are kept out of normal selection while a daily account is usable.
  // This remains true even if a previous run left the emergency-only flag behind.
  if (p.emergencyOnly === true && !config.reserve.includes(p.accountKey)) st.unavailable = true;
  st.healthy = st.known && !st.exh5 && !st.exh7 && !st.unavailable;
  return st;
}

function planRotation(a) {
  const d = decideRotation(a);
  if (d.action === 'ERROR') return { error: d.code, pause: [], resume: [], roleChanges: [], nextExhaustedPaused: a.exhaustedPaused || [] };
  if (a.autoSwitch === false) return { pause: [], resume: [], roleChanges: [], nextExhaustedPaused: a.exhaustedPaused || [] };
  const c = validateRotation(a.rotation);
  const owned = new Set([...(a.policyPaused || []), ...(a.exhaustedPaused || [])]);
  const pause = [], resume = [], roleChanges = [];
  for (const [index, p] of Object.entries(a.policyByIndex)) {
    const i = Number(index), n = i + 1;
    const reserve = c.reserve.includes(p.accountKey);
    const wantEmergency = reserve && i !== a.activeIndex;
    if (!!p.emergencyOnly !== wantEmergency) roleChanges.push({ n, emergencyOnly: wantEmergency });
    const st = quotaState(a, i, c);
    const keepingSoftLimitedCurrent = i === a.activeIndex && ['WAIT', 'GUARD'].includes(d.action) && (st.used5 ?? 0) < 100 && (st.used7 ?? 0) < 100;
    if (st.known && (st.exh5 || st.exh7) && !keepingSoftLimitedCurrent && !p.paused && !(a.pausedIdx || []).includes(i)) pause.push(n);
    else if (st.healthy && owned.has(n)) resume.push(n);
  }
  return { pause, resume, roleChanges, nextExhaustedPaused: [...new Set([...(a.exhaustedPaused || []), ...pause])].filter(n => !resume.includes(n)) };
}

function decideRotation(a) {
  let config;
  const result = (action, code, reason, target = null, details = {}) => ({ action, code, reason, targetIndex: target, nextLogAtMs: null, details: { curIndex: a.activeIndex, dryRun: a.dryRun === true, fresh: true, ...details } });
  try { config = validateRotation(a.rotation); }
  catch { return result('ERROR', 'ROTATION_CONFIG_INVALID', 'ERROR 自定义轮换配置无效，请检查账号绑定和阈值'); }
  if (!Number.isFinite(a.nowMs) || !Number.isInteger(a.activeIndex) || a.activeIndex < 0 || a.activeIndex >= a.accountCount) return result('ERROR', 'ROTATION_INPUT_INVALID', 'ERROR 账号状态无效，未执行切换');
  const policies = a.policyByIndex || {};
  const byKey = new Map();
  for (const [index, p] of Object.entries(policies)) {
    if (!p.accountKey) continue;
    if (byKey.has(p.accountKey)) return result('ERROR', 'ACCOUNT_BINDING_AMBIGUOUS', 'ERROR 账号绑定重复，未执行切换');
    byKey.set(p.accountKey, Number(index));
  }
  const keys = [...config.daily, ...config.reserve];
  if (keys.some(k => !byKey.has(k))) return result('ERROR', 'ACCOUNT_BINDING_MISSING', 'ERROR 配置中的账号已移除或身份变化，请重新绑定');
  if (keys.length !== a.accountCount) return result('ERROR', 'ACCOUNT_POOL_CHANGED', 'ERROR 账号池已变化，请为所有账号明确配置日常或备用角色');
  const daily = config.daily.map(k => byKey.get(k));
  const reserves = config.reserve.map(k => byKey.get(k));
  const snapshot = i => quotaState(a, i, config);
  const cur = snapshot(a.activeIndex);
  const minGapSec = config.minGapSec ?? a.minGapSec ?? 600;
  const canWait = st => st.known && st.exh5 && !st.exh7 && !st.unavailable && st.wait5 > 0 && st.wait5 < st.waitThreshold;
  const currentDaily = daily.indexOf(a.activeIndex);
  const order = currentDaily < 0 || config.dailySelection === 'priority' ? daily : daily.slice(currentDaily + 1).concat(daily.slice(0, currentDaily));
  const targetDaily = order.find(i => snapshot(i).healthy);
  const returnNow = reserves.includes(a.activeIndex) && config.returnToDaily && targetDaily !== undefined;
  if (a.autoSwitch === false) return result('DISABLED', 'ROTATION_DISABLED', 'DISABLED 自动切号已关闭', null, { cur });
  if (cur.healthy && !returnNow && keys.some(k => byKey.get(k) === a.activeIndex)) return result('OK', 'ROTATION_HEALTHY', 'OK 当前账号健康，保持使用', null, { cur });
  if (!cur.known && !returnNow && !cur.unavailable) return result('SKIP', 'QUOTA_UNKNOWN', 'SKIP 当前额度未知，保留账号状态', null, { cur });
  const waiting = currentDaily >= 0 && canWait(cur) ? a.activeIndex : targetDaily === undefined ? order.find(i => canWait(snapshot(i))) : undefined;
  const waitingAllowed = currentDaily >= 0 ? !cur.unavailable : reserves.includes(a.activeIndex);
  if (waiting !== undefined && waitingAllowed) {
    const d = result('WAIT', 'WAIT_SHORT_RESET', 'WAIT 日常号距 5H 重置小于等待阈值，暂不切号', null, { cur, waitKey: 'rotation-reset-' + waiting });
    d.nextLogAtMs = a.nowMs + Math.min(5 * 60000, snapshot(waiting).wait5 * 60000);
    d.details.fresh = a.lastStatus !== 'WAIT' || a.lastWaitKey !== d.details.waitKey || a.nowMs - (a.lastWaitLogAtMs || 0) >= 5 * 60000;
    return d;
  }
  const target = targetDaily ?? reserves.find(i => i !== a.activeIndex && snapshot(i).healthy);
  if (target === undefined) {
    const runtimeValues = a.runtimeBlocked instanceof Map ? [...a.runtimeBlocked.values()] : Object.values(a.runtimeBlocked || {});
    const blocked = runtimeValues.map(classifyReason).filter(x => x !== 'unknown' && x !== 'other');
    const globalIncident = blocked.length >= a.accountCount && new Set(blocked).size === 1 ? blocked[0] : null;
    return result('DEAD', globalIncident ? 'GLOBAL_RUNTIME_INCIDENT' : 'NO_HEALTHY_ACCOUNT', globalIncident ? 'DEAD 全部账号同时报告 ' + globalIncident + ' 故障，暂停切换并等待恢复' : 'DEAD 没有确认健康的账号，等待刷新或人工处理', null, { cur, globalIncident });
  }
  const reserveBack = reserves.includes(a.activeIndex) && daily.includes(target);
  const activeRuntimeReason = a.runtimeBlocked instanceof Map ? a.runtimeBlocked.get(a.activeIndex) : a.runtimeBlocked?.[a.activeIndex];
  const hardRuntimeBlock = isHardRuntimeReason(activeRuntimeReason);
  const gapMs = a.nowMs - (Number.isFinite(a.lastSwitchAtMs) ? a.lastSwitchAtMs : 0);
  if (gapMs < minGapSec * 1000 && !hardRuntimeBlock) {
    return result('GUARD', 'SWITCH_GUARD', 'GUARD 距上次切换不足 ' + minGapSec + ' 秒，跳过本次切换', target, { cur, targetIsReserve: reserves.includes(target), reserveBack, minGapSec });
  }
  return result('SWITCH', reserveBack ? 'RETURN_TO_DAILY' : 'ROTATE_ACCOUNT', 'SWITCH ' + (a.activeIndex + 1) + ' -> ' + (target + 1), target, { cur, targetIsReserve: reserves.includes(target), reserveBack, why: reserveBack ? '日常号额度已恢复' : '当前账号不可用，按配置选择健康账号' });
}

module.exports = { validateRotation, decideRotation, planRotation };
