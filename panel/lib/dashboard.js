'use strict';
/**
 * 面板“状态快照”的读模型：把 CLI 输出 + 状态文件拼成前端要的 JSON。
 *
 * 缓存策略：60 秒 TTL；过期时先返回旧快照并后台重建（stale-while-revalidate）；
 * force=true 时复用正在跑的构建，避免“排队 + 再跑一遍 CLI”。
 */
const paths = require('./paths');
const { extractJson, readJson } = require('./fs-json');
const fs = require('fs');
const { runCli } = require('./cli');
const { cache, FAST_TTL, invalidate } = require('./state-cache');
const { readSchedule, loadPolicy } = require('./policy-store');
const { readRouter } = require('./router-control');
const { readLogs, readServiceAlerts } = require('./usage-logs');
const { describeAppLogin, readProxyAccounts } = require('./proxy-accounts');
const { freshestQuota } = require('./live-quota');
const { summarizeRuntime } = require('./runtime-health');

// 额度快照超过这个时长没有更新就视为“陈旧”：上游探测失败时 CLI 会静默保留旧快照，
// 面板必须能区分“当前用量”与“很久以前的用量”，否则会出现“0% 剩余（已重置）”这类自相矛盾的显示。
const STALE_QUOTA_MS = 30 * 60 * 1000;
let refreshQueued = false;

function pickWindows(quota, now = Date.now()) {
  const primary = quota && quota.primary ? quota.primary : null;
  const secondary = quota && quota.secondary ? quota.secondary : null;
  let weekly = null, short = null;
  for (const w of [primary, secondary]) {
    if (!w || !w.windowMinutes) continue;
    if (w.windowMinutes >= 10080 && !weekly) weekly = w;
    else if (w.windowMinutes > 0 && w.windowMinutes <= 360 && !short) short = w;
  }
  const toObj = (w) => {
    if (!w) return null;
    const resetAt = w.resetAtMs || null;
    return {
      remaining: Math.max(0, Math.min(100, Math.round(100 - Number(w.usedPercent)))),
      resetAt,
      // 窗口重置时刻已过：快照里的 usedPercent 属于上一个窗口，不能再当作当前用量显示。
      expired: resetAt !== null && resetAt <= now,
    };
  };
  return { h5: toObj(short), h7: toObj(weekly) };
}

function paceFor(win) {
  if (!win || !win.resetAt) return 0;
  const used = 100 - win.remaining;
  const start = win.resetAt - 7 * 86400000;
  const elapsedH = (Date.now() - start) / 3600000;
  if (elapsedH < 1 || used <= 0) return 0;
  return Math.round((used / elapsedH) * 100) / 100;
}

function loadCache() {
  // Account labels and notes stay in memory. Discard only this application's old derived cache.
  try { fs.unlinkSync(paths.CACHE_FILE); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

async function buildState(mode = 'fast') {
  const refresh = mode === 'refresh';
  const nowMs = Date.now();
  const policy = loadPolicy();
  const tasks = [runCli(['status', '--json'], 30000), runCli(['limits', '--json'].concat(refresh ? ['--refresh'] : []), refresh ? 90000 : 20000), runCli(['account', 'policy', 'list', '--json'], 20000)];
  const [statusRes, limitsRes, policyRes] = await Promise.all(tasks);

  const status = extractJson(statusRes.out) || {};
  const limits = extractJson(limitsRes.out) || {};
  const policyList = extractJson(policyRes.out) || {};

  const byIndex = new Map();
  const statusAccounts = Array.isArray(status.accounts) ? status.accounts : [];
  for (const a of statusAccounts) byIndex.set(Number(a.index), { status: a });
  const limitsAccounts = Array.isArray(limits.accounts) ? limits.accounts : [];
  for (const a of limitsAccounts) {
    const rec = byIndex.get(Number(a.index)) || {};
    rec.limits = a;
    byIndex.set(Number(a.index), rec);
  }
  const policyAccounts = Array.isArray(policyList.accounts) ? policyList.accounts : [];
  for (const a of policyAccounts) {
    const zero = Number(a.index) - 1;
    const rec = byIndex.get(zero) || {};
    rec.policy = a;
    byIndex.set(zero, rec);
  }

  // 路由按真实请求的响应头写的实时额度（按 workspace accountId 存）；比探测快照新就用它。
  const liveRaw = readJson(paths.LIVE_QUOTA, null);
  const liveById = liveRaw && liveRaw.byAccountId && typeof liveRaw.byAccountId === 'object' ? liveRaw.byAccountId : {};
  const accountIds = readProxyAccounts().accounts.map((a) => a.accountId);
  // 路由实际在用的账号：会话亲和会让对话留在开局的账号上，不一定是策略选的“当前”账号。
  const inUseIndex = typeof status.runtimeInUseIndex === 'number' ? status.runtimeInUseIndex : null;
  const runtimeRaw = readJson(paths.OBSERVABILITY, null);
  const runtimeReasons = runtimeRaw && runtimeRaw.accountSkipReasons && typeof runtimeRaw.accountSkipReasons === 'object'
    ? runtimeRaw.accountSkipReasons : {};
  const accounts = [];
  for (const [idx, rec] of Array.from(byIndex.entries()).sort((x, y) => x[0] - y[0])) {
    const st = rec.status || {};
    const lim = rec.limits || {};
    const pol = rec.policy || {};
    const label = st.label || lim.label || `Account ${idx + 1}`;
    const emailMatch = String(label).match(/([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/);
    const quota = freshestQuota(lim.quota || st.quota || {}, liveById[accountIds[idx]]);
    const win = pickWindows(quota, nowMs);
    const quotaUpdatedAt = typeof quota.updatedAt === 'number' ? quota.updatedAt : null;
    const paused = !!pol.paused || (st.subscription && st.subscription.automaticBlock === 'paused');
    const emergencyOnly = !!pol.emergencyOnly;
    let role = 'daily';
    if (emergencyOnly) role = 'reserve';
    if (policy.rotation) role = policy.rotation.reserve.includes(pol.accountKey) ? 'reserve' : 'daily';
    if (paused && !emergencyOnly) role = 'paused';
    const runtimeReason = String(runtimeReasons[String(idx)] || '').trim().toLowerCase();
    const authRequired = /(?:auth|unauthori[sz]ed|token)[\s_-]*(?:invalid|expired|revoked|failed)|invalid[\s_-]*token/i.test(runtimeReason);
    accounts.push({
      n: idx + 1,
      accountKey: pol.accountKey || null,
      email: emailMatch ? emailMatch[1] : '',
      label,
      plan: (quota.planType || (st.subscription && st.subscription.planType) || 'unknown'),
      planLabel: (st.subscription && st.subscription.planLabel) || 'Plus',
      role, paused, emergencyOnly,
      note: pol.note || '',
      current: !!st.current || Number(status.activeIndex) === idx,
      inUse: inUseIndex === null ? (!!st.current || Number(status.activeIndex) === idx) : inUseIndex === idx,
      available: !paused,
      reason: runtimeReason || st.reason || (paused ? 'policy: paused' : ''),
      authRequired,
      quotaStatus: typeof quota.status === 'number' ? quota.status : null,
      // 额度快照的观测时间与是否陈旧：探测失败时 CLI 静默保留旧值，界面必须能看出来。
      quotaUpdatedAt,
      quotaStale: quotaUpdatedAt === null || nowMs - quotaUpdatedAt > STALE_QUOTA_MS,
      quotaSource: quota.source || null,
      drainPerHour: paceFor(win.h7),
      drainRaw: Number(st.quotaDrainPerHour) || 0,
      h5: win.h5, h7: win.h7,
      lastUsed: st.lastUsed || null,
    });
  }

  const now = nowMs;
  const weekRemaining = accounts.reduce((sum, a) => sum + (a.h7 ? a.h7.remaining : 0), 0);
  const pace = accounts.reduce((sum, a) => sum + (a.drainPerHour > 0 ? a.drainPerHour : 0), 0);
  const rate = Math.max(pace, 0.5);
  const hoursLeft = weekRemaining > 0 ? Math.min(24 * 60, weekRemaining / rate) : 0;
  const budgetRate = 1.5;
  const budgetHours = weekRemaining > 0 ? Math.min(24 * 60, weekRemaining / budgetRate) : 0;
  const current = accounts.find((a) => a.current) || accounts.find((a) => a.available) || null;

  return {
    now,
    router: readRouter(),
    app: describeAppLogin(),
    accounts,
    selection: {
      active: typeof status.activeIndex === 'number' ? status.activeIndex + 1 : null,
      runtimeInUse: typeof status.runtimeInUseIndex === 'number' ? status.runtimeInUseIndex + 1 : null,
      pinned: typeof status.pinnedAccountIndex === 'number' ? status.pinnedAccountIndex + 1 : null,
      mode: status.selectionMode || 'hybrid',
      available: accounts.filter((a) => a.available).length,
      total: accounts.length,
    },
    totals: {
      weekRemaining,
      drainPerHour: Math.round(pace * 100) / 100,
      hoursLeft: Math.round(hoursLeft * 10) / 10,
      darkAt: hoursLeft > 0 ? now + hoursLeft * 3600000 : null,
      budgetRate,
      budgetHours: Math.round(budgetHours * 10) / 10,
      budgetDarkAt: budgetHours > 0 ? now + budgetHours * 3600000 : null,
      withinBudget: pace <= budgetRate,
    },
    policy: Object.assign({}, policy, { minMinWait: 5, maxMinWait: 600 }),
    schedule: readSchedule(),
    current,
    logs: readLogs(60),
    alerts: readServiceAlerts(),
    runtime: summarizeRuntime(readJson(paths.OBSERVABILITY, null)),
    errors: [statusRes.ok ? null : 'status 读取失败', limitsRes.ok ? null : 'limits 读取失败', policyRes.ok ? null : 'policy 读取失败'].filter(Boolean),
  };
}

function withMeta(data, ageMs, mode) {
  const policy = loadPolicy();
  const accounts = policy.rotation ? (data.accounts || []).map(a => ({
    ...a, role: policy.rotation.reserve.includes(a.accountKey) ? 'reserve' : a.paused ? 'paused' : 'daily',
  })) : data.accounts;
  return Object.assign({}, data, {
    policy, accounts,
    meta: {
      fetchedAt: cache.at,
      ageMs: Math.max(0, Math.round(ageMs)),
      mode,
      cached: mode === 'cache' || mode === 'stale',
      refreshing: cache.buildingMode === 'refresh' || refreshQueued,
    },
  });
}

function startBuild(mode) {
  const generation = cache.generation;
  cache.buildingMode = mode;
  cache.building = buildState(mode)
    .then((data) => {
      cache.data = data;
      cache.at = generation === cache.generation ? Date.now() : Date.now() - FAST_TTL - 1000;
      cache.building = null;
      cache.buildingMode = null;
      if (refreshQueued) {
        refreshQueued = false;
        return startBuild('refresh');
      }
      if (generation !== cache.generation) return startBuild('fast');
      return withMeta(data, 0, mode);
    })
    .catch((err) => {
      cache.building = null;
      cache.buildingMode = null;
      if (refreshQueued) { refreshQueued = false; return startBuild('refresh'); }
      if (cache.data) return withMeta(cache.data, Date.now() - cache.at, 'stale');
      throw err;
    });
  return cache.building;
}

/**
 * 读状态。三种路径：
 * - 60s 内直接给缓存；
 * - force=true：忽略 TTL，用"快查询"重建（status / limits 缓存版 / policy list，并行约 0.5s）；
 * - 有构建在跑时复用，避免 CLI 排队；刷新型构建在跑时**不阻塞**，先返回旧数据。
 *
 * 注意：深度刷新（limits --refresh）要打上游、实测约 7–15 秒；走代理时可能更慢，\n * 超时给到 90s，只走 refreshState() 的后台路径。
 */
function getState(force = false) {
  const age = cache.data ? Date.now() - cache.at : Infinity;
  if (cache.building) {
    if (cache.data && (cache.buildingMode === 'refresh' || refreshQueued)) return Promise.resolve(withMeta(cache.data, age, 'stale'));
    return cache.building;
  }
  if (!force && cache.data && age <= FAST_TTL) return Promise.resolve(withMeta(cache.data, age, 'cache'));
  if (!force && cache.data) {
    startBuild('fast');
    return Promise.resolve(withMeta(cache.data, age, 'stale'));
  }
  return startBuild('fast');
}

/**
 * 深度刷新额度：立刻返回当前状态（meta.refreshing=true），把 7 秒的上游查询放后台。
 * 前端下一次轮询（15s）自然拿到新数据；多次点击会合并成一次构建。
 */
function refreshState() {
  if (cache.building && cache.buildingMode !== 'refresh') refreshQueued = true;
  if (!cache.building) startBuild('refresh');
  if (cache.data) return Promise.resolve(withMeta(cache.data, Date.now() - cache.at, 'cache'));
  return cache.building.then((data) => data);
}

module.exports = { pickWindows, paceFor, loadCache, buildState, getState, refreshState, invalidate, STALE_QUOTA_MS };
