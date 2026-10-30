'use strict';

/**
 * policy-core.js — Codex 多账号额度策略核心（纯函数库）
 *
 * 语义基准：仓库根目录的 quota-policy.ps1
 * 本文件只做"读数据 → 出决策"的纯计算：零依赖、无 I/O、无定时器、无子进程、
 * 不改入参、不抛异常（所有异常输入都收敛成 action='ERROR'）。
 *
 * 约定（与 PowerShell 脚本一致）：
 *   - 账号下标凡是 activeIndex / quotaByIndex / pausedIdx / emergencyOnlyIndex 都是 0 基；
 *   - 配置文件里的 reserveIndex 与 state 里的 policyPaused 是 1 基（面板/ps1 原样）；
 *   - 时间一律毫秒时间戳，等待时间对外以"分钟"为单位、保留 1 位小数、可为负数。
 *
 * 已知取舍（详见交付报告）：
 *   - round1 用四舍五入（JS Math.round），.NET [math]::Round 默认是银行家舍入，仅在 x.x5 边界不同；
 *   - WAIT 心跳 >=60 分钟段用 waitMin/2 夹在 [30,60]（PS 固定 30），阈值可由 opts 覆盖；
 *   - reason 里用"切换"/"建议切换"而非 PS 的"已切换"：纯函数只出决策，执行与校验由调用方负责。
 *   - 窗口重置时刻已过（expired5/expired7）按"新窗口"处理：缓存里的 usedPercent 属于上一窗口，
 *     不能再当耗尽（否则会负分钟 WAIT / 永久暂停）；rotation 决策保持原有保守语义不变。
 */

/* ============================== 常量（可被 opts 覆盖） ============================== */

/** 两次切号之间的最小间隔（秒）。PS: $MIN_GAP_SEC */
const MIN_GAP_SEC = 600;
/** 5h 耗尽后"值得等待"的上限（分钟）。PS: $MIN_WAIT_MIN 默认 60 */
const MIN_WAIT_MIN = 60;
/** MIN_WAIT_MIN 的下限。PS: [math]::Max(5, $cfg.minWaitMin) */
const MIN_WAIT_MIN_FLOOR = 5;
/** 窗口分类：windowMinutes >= 10080（7 天）算周额度窗口 */
const WINDOW_WEEKLY_MIN_MINUTES = 10080;
/** 窗口分类：windowMinutes > 0 且 <= 360 算 5h 短窗口 */
const WINDOW_SHORT_MIN_MINUTES = 1;
const WINDOW_SHORT_MAX_MINUTES = 360;
/**
 * 5h 剩余百分点 <= 该值即视为耗尽：提前切号，避免 Codex 先吃到 429 再弹额度不足。
 * PS: $PreemptPct = 5，exh5 = (100 - usedPercent) -le 5
 */
const SHORT_PREEMPT_REMAINING_PERCENT = 5;
/**
 * 7d 使用率 >= 该值即视为耗尽：提前 3%，避免白等 5 分钟。
 * PS: exh7 = usedPercent -ge 97
 */
const WEEKLY_PREEMPT_USED_PERCENT = 97;

/** 运行时已经明确判定"不可用"的原因（额度快照可能还没更新） */
const HARD_RUNTIME_REASONS = Object.freeze(['rate-limited', 'quota-exhausted']);
/**
 * 运行时临时冷却（网络/服务端抖动）：请求级瞬时失败，等 5 分钟额度缓存刷新就是 503 空窗，
 * 所以同样必须立刻算"不可用"，让决策当轮就切走。
 */
const COOLDOWN_RUNTIME_PREFIX = 'cooling-down';
const MODEL_CAPACITY_RUNTIME_RE = /model[\s_-]*capacity|capacity[\s_-]*(?:exhausted|insufficient|unavailable)/i;
const AUTH_RUNTIME_RE = /(?:auth|unauthori[sz]ed|token)[\s_-]*(?:invalid|expired|revoked|failed)|invalid[\s_-]*token/i;

function isHardRuntimeReason(reason) {
  if (reason === null || reason === undefined) return false;
  const r = String(reason).trim().toLowerCase();
  return HARD_RUNTIME_REASONS.indexOf(r) >= 0 || r.indexOf(COOLDOWN_RUNTIME_PREFIX) === 0 || MODEL_CAPACITY_RUNTIME_RE.test(r) || AUTH_RUNTIME_RE.test(r);
}

/**
 * 瞬时原因（网络冷却、模型容量）：几十秒内就会自己过去，运行时也会自己绕开。
 * 只在刚出现时可信，过了 TRANSIENT_RUNTIME_TRUST_MS 就不再据此换号，也不能绕过切换护栏。
 *
 * 为什么需要"首次看到"时间：runtime-observability.json 的 updatedAt 被诊断探测每几秒刷新一次，
 * 而 accountSkipReasons 只在池耗尽时整体写入、只有该账号再次成功才清掉。被避开的账号拿不到成功，
 * 旧原因就一直挂着却"永远新鲜"——策略每 5 分钟据此再换一次号（2026-10-27 13:37 起的日志）。
 */
const TRANSIENT_RUNTIME_TRUST_MS = 4 * 60000;

function isTransientRuntimeReason(reason) {
  if (reason === null || reason === undefined) return false;
  const r = String(reason).trim().toLowerCase();
  return r.indexOf(COOLDOWN_RUNTIME_PREFIX) === 0 || MODEL_CAPACITY_RUNTIME_RE.test(r);
}
/** 默认储备号（1 基），PS: reserveIndex 默认 1 */
const DEFAULT_RESERVE_INDEX = 1;

/**
 * WAIT 期间日志心跳阶梯（"距重置还有多久"的对数间隔）。
 * 故意按剩余时间而不是经过时间来定，离得远只留稀疏轨迹，临界区加密观察。
 * PS 的 WaitLogMinutes 是 30 / 5 / 2 的固定三档；这里 >=60 分钟段改成 waitMin/2 夹到 [30,60]。
 */
const HEARTBEAT = Object.freeze({
  divisor: 2,       // 间隔 = waitMin / divisor（对数/折半采样，与 quota-policy.ps1 的 WaitLogMinutes 一致）
  clampMin: 2,      // 最短 2 分钟（临界区）
  clampMax: 60,     // 最长 60 分钟
});

const MS_PER_MIN = 60000;

/** decide() 可能返回的 action 全集 */
const ACTIONS = Object.freeze(['OK', 'WAIT', 'SWITCH', 'GUARD', 'DEAD', 'WARN', 'DISABLED', 'SKIP', 'ERROR']);

/** decide() 的默认策略参数（等价 panel-config.json 的默认值 + PS 常量） */
const DEFAULTS = Object.freeze({
  autoSwitch: true,
  minWaitMin: MIN_WAIT_MIN,
  minGapSec: MIN_GAP_SEC,
  reserveIndex: DEFAULT_RESERVE_INDEX,
  dryRun: false,
});

/* ================================== 小工具 ================================== */

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function asObj(v) {
  return isObj(v) ? v : {};
}

/** 任意输入 → 有限数字；字符串数字照收；其余（null/undefined/'abc'/NaN/Infinity）→ null */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 任意输入 → 整数（截断）；不可解析 → null */
function int(v) {
  const n = num(v);
  return n === null ? null : Math.trunc(n);
}

/**
 * 运行时硬阻塞：运行时已判 rate-limited / quota-exhausted / cooling-down:* 的账号。
 * 额度快照可能还是几分钟前的旧值，但运行时已经不会再路由到它，
 * 所以决策必须把它当成"不可用"，否则只能干等缓存刷新（空窗期就是 503）。
 */
function toRuntimeMap(src) {
  const out = new Map();
  const put = (k, v) => {
    const i = int(k);
    const r = typeof v === 'string' ? v.trim().toLowerCase() : '';
    if (i !== null && i >= 0 && r) out.set(i, r);
  };
  if (!src) return out;
  if (src instanceof Map) {
    for (const [k, v] of src) put(k, v);
    return out;
  }
  if (Array.isArray(src)) {
    src.forEach((v, i) => put(i, v));
    return out;
  }
  if (typeof src === 'object') {
    for (const k of Object.keys(src)) put(k, src[k]);
  }
  return out;
}

/** 保留 1 位小数 */
function round1(v) {
  return Math.round(v * 10) / 10;
}

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/** 依次取第一个可解析为数字的候选值，全失败则用 fallback */
function firstNum(fallback, ...vals) {
  for (const v of vals) {
    const n = num(v);
    if (n !== null) return n;
  }
  return fallback;
}

/** PS: Fmt $i → "账号N"（1 基，无空格） */
function fmtIndex(i) {
  const n = int(i);
  return n === null ? '账号?' : '账号' + (n + 1);
}

/** 本地时间 MM-dd HH:mm，对应 PS (Get-Date).AddMinutes(...).ToString("MM-dd HH:mm") */
function formatWhen(ms) {
  const t = num(ms);
  if (t === null) return '未知时间';
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return '未知时间';
  const p2 = (n) => String(n).padStart(2, '0');
  return p2(d.getMonth() + 1) + '-' + p2(d.getDate()) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
}

/** 窗口分类阈值：opts.window.{...} 或扁平 opts.{...} 覆盖 */
function windowOpts(opts) {
  const o = asObj(opts);
  const w = asObj(o.window);
  return {
    weeklyMinMinutes: firstNum(WINDOW_WEEKLY_MIN_MINUTES, w.weeklyMinMinutes, o.weeklyMinMinutes),
    shortMinMinutes: firstNum(WINDOW_SHORT_MIN_MINUTES, w.shortMinMinutes, o.shortMinMinutes),
    shortMaxMinutes: firstNum(WINDOW_SHORT_MAX_MINUTES, w.shortMaxMinutes, o.shortMaxMinutes),
  };
}

/** 心跳阶梯：opts.heartbeat.{...} 或扁平 opts.{...} 覆盖 */
function heartbeatOpts(opts) {
  const o = asObj(opts);
  const h = asObj(o.heartbeat);
  return {
    divisor: firstNum(HEARTBEAT.divisor, h.divisor, o.divisor),
    clampMin: firstNum(HEARTBEAT.clampMin, h.clampMin, o.clampMin),
    clampMax: firstNum(HEARTBEAT.clampMax, h.clampMax, o.clampMax),
  };
}

/** 策略参数：复刻 PS 读 panel-config.json 的规则（非正数回落默认，minWaitMin 下限 5） */
function policyOpts(opts) {
  const o = asObj(opts);
  const rawWait = num(o.minWaitMin);
  const rawReserve = num(o.reserveIndex);
  const minGap = num(o.minGapSec);
  return {
    // PS: [bool]$raw.autoSwitch —— 只有明确的 false 才关闭
    autoSwitch: o.autoSwitch !== false,
    // PS: if ([int]$raw.minWaitMin -gt 0) {...} else 用默认 60；再 Max(5, ...)
    minWaitMin: Math.max(MIN_WAIT_MIN_FLOOR, Math.trunc(rawWait !== null && rawWait > 0 ? rawWait : MIN_WAIT_MIN)),
    minGapSec: Math.max(0, minGap === null ? MIN_GAP_SEC : minGap),
    // PS: $RESERVE = Max(0, reserveIndex - 1)
    reserveIndex: Math.max(1, Math.trunc(rawReserve !== null && rawReserve > 0 ? rawReserve : DEFAULT_RESERVE_INDEX)),
    dryRun: o.dryRun === true,
  };
}

/** quotaByIndex：Map / 数组 / 数字键对象 → Map<number, quota> */
function toIndexMap(src) {
  const out = new Map();
  if (!src) return out;
  if (src instanceof Map) {
    for (const [k, v] of src) {
      const i = int(k);
      if (i !== null && i >= 0 && v) out.set(i, v);
    }
    return out;
  }
  if (Array.isArray(src)) {
    src.forEach((v, i) => { if (v) out.set(i, v); });
    return out;
  }
  if (typeof src === 'object') {
    for (const k of Object.keys(src)) {
      const i = int(k);
      if (i !== null && i >= 0 && src[k]) out.set(i, src[k]);
    }
  }
  return out;
}

/** 0 基下标集合：数组 / Set / {下标: truthy} 对象 → Set<number> */
function toIndexSet(src) {
  const out = new Set();
  const add = (v) => {
    const i = int(v);
    if (i !== null && i >= 0) out.add(i);
  };
  if (!src) return out;
  if (src instanceof Set) {
    for (const v of src) add(v);
    return out;
  }
  if (Array.isArray(src)) {
    for (const v of src) add(v);
    return out;
  }
  if (typeof src === 'object') {
    for (const k of Object.keys(src)) if (src[k]) add(k);
  }
  return out;
}

/**
 * 账号策略表：键为 0 基下标，值保留运行时策略真正需要的字段。
 * account policy list 使用 1 基 index；决策内部统一成 0 基，避免执行层再猜。
 */
function toPolicyMap(src) {
  const out = new Map();
  if (!src) return out;
  const put = (key, value) => {
    const i = int(key);
    if (i === null || i < 0 || !isObj(value)) return;
    out.set(i, {
      paused: value.paused === true,
      emergencyOnly: value.emergencyOnly === true,
      drained: value.drained === true,
      priority: num(value.priority) === null ? 1 : num(value.priority),
      weight: num(value.weight) === null ? 1 : num(value.weight),
    });
  };
  if (Array.isArray(src)) {
    src.forEach((value, i) => put(i, value));
  } else if (src instanceof Map) {
    for (const [key, value] of src) put(key, value);
  } else if (typeof src === 'object') {
    for (const key of Object.keys(src)) put(key, src[key]);
  }
  return out;
}

/** 1 基账号号列表（去重、升序、忽略非法项） */
function toAccountNoList(src) {
  const out = [];
  const add = (v) => {
    const n = int(v);
    if (n !== null && n > 0 && !out.includes(n)) out.push(n);
  };
  if (src === null || src === undefined) return out;
  if (Array.isArray(src) || src instanceof Set) {
    for (const v of src) add(v);
  } else if (typeof src === 'object') {
    for (const k of Object.keys(src)) if (src[k]) add(k);
  } else {
    add(src);
  }
  return out.sort((a, b) => a - b);
}

/* ================================ 窗口分类 ================================ */

/**
 * 按 windowMinutes 把 primary / secondary 分成周额度窗口和 5h 短窗口。
 *
 * @param {object|null} quota            CLI `limits --json` 里的 quota 对象
 * @param {object} [opts]                覆盖 opts.window.{weeklyMinMinutes,shortMinMinutes,shortMaxMinutes}
 * @returns {{short: object|null, weekly: object|null}} 返回原窗口对象引用（PS 同样保留引用）
 */
function classifyWindows(quota, opts) {
  const out = { short: null, weekly: null };
  if (!isObj(quota)) return out;
  const w = windowOpts(opts);
  for (const cand of [quota.primary, quota.secondary]) {
    if (!isObj(cand)) continue;
    const mins = num(cand.windowMinutes);
    if (mins === null) continue;
    // PS: windowMinutes >= 10080 → weekly；>0 且 <=360 → short；两者互斥且都取第一个命中
    if (out.weekly === null && mins >= w.weeklyMinMinutes) out.weekly = cand;
    if (out.short === null && mins > 0 && mins >= w.shortMinMinutes && mins <= w.shortMaxMinutes) out.short = cand;
  }
  return out;
}

/* ================================ 账号快照 ================================ */

/** resetAtMs 离现在还有多少分钟（1 位小数，可为负）；无重置时间（含 0）→ null */
function waitMinutes(resetAtMs, nowMs) {
  const at = num(resetAtMs);
  // PS: if ($w.resetAtMs) —— 0 视为"没有重置时间"
  if (at === null || at === 0) return null;
  return round1((at - nowMs) / MS_PER_MIN);
}

/**
 * 把一份 quota 压成决策需要的快照。字段与 PS 的 Get-State 一一对应。
 *
 * @param {object|null} quota
 * @param {number} nowMs
 * @param {object} [opts]
 * @returns {{index: number|null, known: boolean, used5: number|null, used7: number|null,
 *            exh5: boolean, exh7: boolean, expired5: boolean, expired7: boolean,
 *            wait5: number|null, wait7: number|null, planType: string|null}}
 */
function describeAccount(quota, nowMs, opts) {
  const now = num(nowMs);
  const at = now === null ? 0 : now;
  const st = {
    index: isObj(quota) ? int(quota.index) : null,
    known: false,
    used5: null,
    used7: null,
    exh5: false,
    exh7: false,
    expired5: false,
    expired7: false,
    wait5: null,
    wait7: null,
    planType: null,
  };
  if (!isObj(quota)) return st;

  st.known = true; // PS: quota 存在即 known，哪怕没有任何窗口
  const plan = quota.planType;
  st.planType = plan === null || plan === undefined ? null : String(plan);

  const win = classifyWindows(quota, opts);
  if (win.short) {
    st.used5 = num(win.short.usedPercent);
    st.exh5 = st.used5 !== null && (100 - st.used5) <= SHORT_PREEMPT_REMAINING_PERCENT;
    st.wait5 = waitMinutes(win.short.resetAtMs, at);
    // 重置时刻已到（wait5 <= 0）：缓存里的 usedPercent 是上一窗口的旧值，新窗口已经开始了
    st.expired5 = st.wait5 !== null && st.wait5 <= 0;
  }
  if (win.weekly) {
    st.used7 = num(win.weekly.usedPercent);
    st.exh7 = st.used7 !== null && st.used7 >= WEEKLY_PREEMPT_USED_PERCENT;
    st.wait7 = waitMinutes(win.weekly.resetAtMs, at);
    st.expired7 = st.wait7 !== null && st.wait7 <= 0;
  }
  return st;
}

/* ============================ 有效窗口耗尽判断 ============================ */

/**
 * 窗口是否"真的耗尽"。exh5/exh7 是缓存快照的瞬时判断；当窗口重置时刻已过（expired5/expired7）时，
 * 快照里的 100% 说的是上一窗口，运行时下一轮请求就会拿到新窗口的额度。决策与暂停计划用这里的
 * 有效判断，避免"重置已过还永远 WAIT / 永远暂停"。
 */
function shortExhausted(st) {
  return isObj(st) && st.exh5 === true && st.expired5 !== true;
}
function weeklyExhausted(st) {
  return isObj(st) && st.exh7 === true && st.expired7 !== true;
}
function anyExhausted(st) {
  return shortExhausted(st) || weeklyExhausted(st);
}

/* ================================ 心跳间隔 ================================ */

/**
 * WAIT 期间的日志心跳间隔（分钟）。null 入参 → null。
 * waitMin >= 60 → waitMin/2 夹在 [30,60]；10..59 → 5；< 10（含负数）→ 2。
 *
 * @param {number|string|null} waitMin 距重置还有多少分钟
 * @param {object} [opts]              覆盖 opts.heartbeat.{...}
 * @returns {number|null}
 */
function heartbeatMinutes(waitMin, opts) {
  const w = num(waitMin);
  if (w === null) return null;
  const hb = heartbeatOpts(opts);
  const v = clamp(w / hb.divisor, hb.clampMin, hb.clampMax);
  return Math.round(v * 10) / 10;
}

/**
 * 下一次该写 WAIT 日志的绝对毫秒时间戳。waitMin 不可解析 → null。
 *
 * @param {number} nowMs
 * @param {number|string|null} waitMin
 * @param {object} [opts]
 * @returns {number|null}
 */
function nextHeartbeatMs(nowMs, waitMin, opts) {
  const now = num(nowMs);
  const mins = heartbeatMinutes(waitMin, opts);
  if (now === null || mins === null) return null;
  return Math.round(now + mins * MS_PER_MIN);
}

/* ================================ 日志去重键 ================================ */

/**
 * 稳定的日志去重键：action + 当前账号 + 目标账号。同一个键重复出现即视为噪声。
 * 缺省下标用 '-'，status 统一大写（非法值 → 'UNKNOWN'）。
 *
 * @param {string} status
 * @param {number|null} curIndex    0 基
 * @param {number|null} targetIndex 0 基
 * @returns {string}
 */
function noiseKey(status, curIndex, targetIndex) {
  const s = typeof status === 'string' && status.trim() !== '' ? status.trim().toUpperCase() : 'UNKNOWN';
  const a = int(curIndex);
  const b = int(targetIndex);
  return s + '|' + (a === null ? '-' : String(a)) + '|' + (b === null ? '-' : String(b));
}

/* ======================= 额度耗尽账号的暂停 / 恢复计划 ======================= */

/**
 * 日常号额度耗尽 → 暂停；额度窗口重置（或换新窗口）→ 恢复。储备号不参与
 * （窗口重置时刻已过 expired* 视为新窗口开始，不再算"耗尽"，会走 resume）。
 * （储备号由 decide 的储备号分支负责）。
 *
 * 为什么需要：运行时按"缓存额度"判断可用性，会把 5h 已用满的号当成可用派单；
 * 上游返回 429 后 Codex 界面直接显示"额度用完，等 X 点重置"——其它账号明明有额度。
 * 暂停掉耗尽账号后，运行时不会再选它，池子里的健康号才真正顶上。
 *
 * @param {object} input
 * @param {number} input.nowMs                       当前时间（纯函数必须显式传入）
 * @param {number} [input.accountCount]              status --json 的 accountCount
 * @param {Map|Array|object} [input.quotaByIndex]    0 基下标 → quota
 * @param {number} [input.reserveIndex]              1 基储备号（默认 1，不参与）
 * @param {Set|Array|object} [input.pausedIdx]       0 基"当前已被暂停"（含用户手动暂停）
 * @param {number[]} [input.exhaustedPaused]         1 基"上一轮由本策略暂停"的账号
 * @returns {{pause: number[], resume: number[], nextExhaustedPaused: number[]}}
 */
function planExhaustionPauses(input) {
  const a = asObj(input);
  const nowMs = num(a.nowMs);
  const quotaByIndex = toIndexMap(a.quotaByIndex !== undefined ? a.quotaByIndex : a.quotas);
  const rawCount = a.accountCount === undefined || a.accountCount === null ? quotaByIndex.size : int(a.accountCount);
  const declared = rawCount === null ? 0 : rawCount;
  const count = quotaByIndex.size > declared ? quotaByIndex.size : declared;

  let reserve0 = policyOpts(a).reserveIndex - 1;
  if (reserve0 < 0) reserve0 = 0;

  const pausedIdx = toIndexSet(a.pausedIdx !== undefined ? a.pausedIdx : a.paused);
  const tracked = new Set(toAccountNoList(a.exhaustedPaused));

  const out = { pause: [], resume: [], nextExhaustedPaused: [] };
  const keepTracked = () => Array.from(tracked)
    .filter((n) => n >= 1 && n <= count && n - 1 !== reserve0)
    .sort((x, y) => x - y);
  if (nowMs === null || count <= 0) {
    out.nextExhaustedPaused = keepTracked();
    return out;
  }

  const pauseSet = new Set();
  const resumeSet = new Set();
  for (let i = 0; i < count; i++) {
    if (i === reserve0) continue;
    const n = i + 1;
    const st = describeAccount(quotaByIndex.get(i), nowMs, a);
    if (!st.known) continue; // 没数据就不动：宁可不暂停，也不误伤
    if (anyExhausted(st)) {
      // 耗尽：还没暂停就暂停（也覆盖"用户手动解除过"的情况，避免又被派单）
      if (!pausedIdx.has(i)) pauseSet.add(n);
    } else if (tracked.has(n)) {
      // 有额度了（含"窗口重置时刻已过"）→ 本策略之前暂停的账号恢复
      resumeSet.add(n);
    }
  }

  out.pause = Array.from(pauseSet).sort((x, y) => x - y);
  out.resume = Array.from(resumeSet).sort((x, y) => x - y);

  const next = new Set();
  for (const n of keepTracked()) if (!resumeSet.has(n)) next.add(n);
  for (const n of pauseSet) next.add(n);
  out.nextExhaustedPaused = Array.from(next).sort((x, y) => x - y);
  return out;
}

/* ================================== 决策 ================================== */

/** 统一结果构造：字段永远齐全，且可 JSON 序列化 */
function decision(action, reason, targetIndex, nextLogAtMs, details) {
  const t = int(targetIndex);
  const at = num(nextLogAtMs);
  return {
    action,
    reason: reason === null || reason === undefined ? '' : String(reason),
    targetIndex: t,
    nextLogAtMs: at === null ? null : Math.round(at),
    details: asObj(details),
  };
}

/** 额度文案。PS: FmtUsage —— 无 5h 窗口显示"无 5h"，无 7d 数据 PS 会留空 */
function fmtUsage(st) {
  const h5 = st.used5 === null
    ? '无 5h'
    : (st.expired5 === true && st.exh5 === true ? '5h 已重置' : '5h ' + st.used5 + '%');
  // 过期窗口的 usedPercent 是上一窗口旧值，不要显示成"有额度 (7d 100%)"
  if (st.expired7 === true && st.exh7 === true) return '(' + h5 + ' / 7d 已重置)';
  const h7 = st.used7 === null ? '' : st.used7;
  return '(' + h5 + ' / 7d ' + h7 + '%)';
}

/** 储备号回切文案里的额度摘要（全角括号内用），过期窗口同样显示"已重置" */
function fmtWhyUsage(st) {
  const h5 = st.used5 === null ? '无 5h'
    : (st.expired5 === true && st.exh5 === true ? '5h 已重置' : '5h ' + st.used5 + '%');
  const h7 = st.used7 === null ? ''
    : (st.expired7 === true && st.exh7 === true ? '7d 已重置' : '7d ' + st.used7 + '%');
  return h5 + ' / ' + h7;
}

/**
 * 核心决策。分支顺序严格照抄 quota-policy.ps1 的 Finish 顺序：
 *   ERROR(池空/activeIndex 异常) → WARN(日常号池空) → SKIP(当前账号无额度)
 *   → 储备号回切(GUARD/SWITCH) → OK
 *   → 自身 5h 将恢复 WAIT → 找日常号 SWITCH / 候选 WAIT → 储备号 SWITCH
 *   → DEAD → GUARD(600s) → DISABLED → DRYRUN(SWITCH+dryRun) → SWITCH
 *
 * @param {object} input
 * @param {number} input.nowMs              当前时间（纯函数必须显式传入，缺失 → ERROR）
 * @param {number} [input.activeIndex]       0 基当前账号；缺省按 PS 的 [int]$null = 0
 * @param {number} [input.accountCount]      status --json 的 accountCount
 * @param {Map|Array|object} [input.quotaByIndex]  0 基下标 → quota
 * @param {number} [input.emergencyOnlyIndex]      0 基；替代 reserveIndex 的储备号
 * @param {number} [input.reserveIndex]      1 基储备号（默认 1）
 * @param {Set|Array|object} [input.pausedIdx]     0 基"被暂停"的账号
 * @param {number[]} [input.policyPaused]    1 基"上一轮自动暂停"的账号（只算冷却）
 * @param {boolean} [input.autoSwitch]       仅 false 关闭自动切号
 * @param {number} [input.minWaitMin]        5h 等待上限（分钟，<5 抬到 5）
 * @param {number} [input.minGapSec]         切号护栏（秒，默认 600）
 * @param {boolean} [input.dryRun]           true → SWITCH 但 details.dryRun=true
 * @param {number} [input.lastSwitchAtMs]    上次成功切号时间
 * @param {string} [input.lastStatus]        上次 action（用于日志去重）
 * @param {string} [input.lastWaitKey]       上次 WAIT 去重键
 * @param {number} [input.lastWaitLogAtMs]   上次 WAIT 日志时间
 * @returns {{action: string, reason: string, targetIndex: number|null,
 *            nextLogAtMs: number|null, details: object}}
 */
function decide(input) {
  const a = asObj(input);
  const cfg = policyOpts(a);

  const nowMs = num(a.nowMs);
  if (nowMs === null) {
    return decision('ERROR', 'ERROR 缺少 nowMs（decide 是纯函数，必须显式传入当前时间）', null, null, {
      stoppedBy: 'error',
      autoSwitch: cfg.autoSwitch,
      minWaitMin: cfg.minWaitMin,
      minGapSec: cfg.minGapSec,
    });
  }

  /* ---- 账号池 / 下标 ---------------------------------------------------- */
  const quotaByIndex = toIndexMap(a.quotaByIndex !== undefined ? a.quotaByIndex : a.quotas);
  const quotaCount = quotaByIndex.size;
  const rawCount = a.accountCount === undefined || a.accountCount === null ? quotaCount : int(a.accountCount);
  const declared = rawCount === null ? quotaCount : rawCount;
  if (declared <= 0) {
    return decision('ERROR', 'ERROR 账号池为空', null, null, {
      stoppedBy: 'error',
      accountCount: declared,
    });
  }
  const accountCount = quotaCount > declared ? quotaCount : declared; // PS: limCount > acctCount 时抬到 limCount

  const activeRaw = int(a.activeIndex);
  const cur = activeRaw === null ? 0 : activeRaw; // PS: [int]$null = 0
  if (cur < 0 || cur >= accountCount) {
    return decision('ERROR', 'ERROR activeIndex 异常: ' + cur + '（账号数 ' + accountCount + '）', null, null, {
      stoppedBy: 'error',
      accountCount,
      curIndex: cur,
      curNo: cur + 1,
    });
  }

  /* ---- 储备号 / 日常号池 ------------------------------------------------ */
  let reserve0 = cfg.reserveIndex - 1;
  if (reserve0 < 0) reserve0 = 0;
  const emergency0 = int(a.emergencyOnlyIndex);
  if (emergency0 !== null && emergency0 >= 0 && emergency0 !== reserve0) reserve0 = emergency0; // PS: emergencyOnly 覆盖

  const pausedIdx = toIndexSet(a.pausedIdx !== undefined ? a.pausedIdx : a.paused);
  const policyPaused = toAccountNoList(a.policyPaused);
  const policyByIndex = toPolicyMap(a.policyByIndex !== undefined ? a.policyByIndex : a.accountPolicies);
  const emergencyIndexes = new Set();
  emergencyIndexes.add(reserve0);
  const rawEmergency = a.emergencyOnlyIndexes !== undefined ? a.emergencyOnlyIndexes : a.emergencyOnlyIndex;
  if (Array.isArray(rawEmergency) || rawEmergency instanceof Set) {
    for (const v of rawEmergency) { const i = int(v); if (i !== null && i >= 0) emergencyIndexes.add(i); }
  } else {
    const i = int(rawEmergency);
    if (i !== null && i >= 0) emergencyIndexes.add(i);
  }
  for (const [i, policy] of policyByIndex) if (policy.emergencyOnly) emergencyIndexes.add(i);
  const isDrained = (i) => policyByIndex.get(i)?.drained === true;
  const isEmergency = (i) => emergencyIndexes.has(i);
  // 轮转自动暂停只是冷却，不能当"用户手动暂停"而永久排除
  const isManualPause = (i) => (pausedIdx.has(i) || policyByIndex.get(i)?.paused === true) && !policyPaused.includes(i + 1);
  const pausedPolicyAlive = policyPaused.filter((no) => pausedIdx.has(no - 1));

  const daily = [];
  for (let i = 0; i < accountCount; i++) {
    if (isEmergency(i) || isDrained(i)) continue;
    if (!isManualPause(i)) daily.push(i);
  }
  daily.sort((a, b) => {
    const pa = policyByIndex.get(a) || {};
    const pb = policyByIndex.get(b) || {};
    return (Number(pa.priority ?? 1) - Number(pb.priority ?? 1))
      || (Number(pb.weight ?? 1) - Number(pa.weight ?? 1))
      || (a - b);
  });
  const reserveCandidates = Array.from(emergencyIndexes)
    .filter((i) => i >= 0 && i < accountCount)
    .sort((a, b) => a - b);
  const pausedDaily = [];
  for (let i = 0; i < accountCount; i++) {
    if (!isEmergency(i) && pausedIdx.has(i)) pausedDaily.push(i + 1);
  }

  // 运行时硬阻塞（429 / 额度打满）：额度缓存可能滞后，这类账号必须立刻算"不可用"。
  // 输入形状：{0:'rate-limited', 2:'quota-exhausted'} / Map / 数组
  const runtimeBlocked = toRuntimeMap(a.runtimeBlocked !== undefined ? a.runtimeBlocked : a.runtimeBroken);
  // runtimeSeen：键 "下标|原因" → 首次看到的时间（调用方持久化后下一轮传回）。只保留本轮仍存在的原因，
  // 原因消失后再出现就重新算"刚出现"。
  const seenBefore = asObj(a.runtimeSeen);
  const runtimeSeen = {};
  for (const [i, r] of Array.from(runtimeBlocked)) {
    if (!isHardRuntimeReason(r)) continue;
    const key = i + '|' + r;
    const prev = num(seenBefore[key]);
    const first = prev !== null && prev <= nowMs ? prev : nowMs;
    runtimeSeen[key] = first;
    if (isTransientRuntimeReason(r) && nowMs - first > TRANSIENT_RUNTIME_TRUST_MS) runtimeBlocked.delete(i);
  }

  const stateOf = (i) => {
    const st = describeAccount(quotaByIndex.get(i), nowMs, a);
    st.index = i; // PS: Get-State 的 index 恒为查询下标
    const policy = policyByIndex.get(i);
    if (policy?.drained) {
      st.runtimeBlocked = 'policy: drained';
      st.unavailable = true;
    }
    const rt = runtimeBlocked.get(i);
    if (isHardRuntimeReason(rt)) {
      st.runtimeBlocked = rt;
      st.unavailable = true;
    }
    return st;
  };

  const base = {
    accountCount,
    curIndex: cur,
    curNo: cur + 1,
    reserveIndex0: reserve0,
    reserveNo: reserve0 + 1,
    daily,
    pausedDaily,
    policyPaused: pausedPolicyAlive,
    autoSwitch: cfg.autoSwitch,
    minWaitMin: cfg.minWaitMin,
    minGapSec: cfg.minGapSec,
    reserveIndex: cfg.reserveIndex,
    runtimeSeen,
  };

  /* ---- WARN：日常号池空（PS 里这一步先于 SKIP） ------------------------ */
  if (daily.length === 0) {
    return decision(
      'WARN',
      'WARN  日常号池为空（暂停中：' + pausedDaily.join(',') + '）；当前只会在储备号上运行，请检查 account pause 状态',
      null,
      null,
      Object.assign({}, base, { stoppedBy: 'warn', fresh: a.lastStatus !== 'WARN' })
    );
  }

  /* ---- SKIP：当前账号没有额度数据 -------------------------------------- */
  const curSt = stateOf(cur);
  if (!curSt.known) {
    return decision('SKIP', 'SKIP  ' + fmtIndex(cur) + ' 无额度数据', null, null, Object.assign({}, base, {
      stoppedBy: 'skip',
      cur: curSt,
    }));
  }

  const detailBase = Object.assign({}, base, { cur: curSt });
  const gapMs = nowMs - (num(a.lastSwitchAtMs) === null ? 0 : num(a.lastSwitchAtMs));
  const guardMs = cfg.minGapSec * 1000;

  /* ---- 储备号在用 + 日常号已恢复 → 回切 -------------------------------- */
  if (cur === reserve0 && !weeklyExhausted(curSt)) {
    for (const i of daily) {
      const dst = stateOf(i);
      if (!dst.known || dst.unavailable || anyExhausted(dst)) continue;

      if (gapMs < guardMs) {
        return decision(
          'GUARD',
          'GUARD 储备号在用，' + fmtIndex(i) + ' 已恢复，但距上次切换不足 ' + cfg.minGapSec + ' 秒',
          i,
          null,
          Object.assign({}, detailBase, {
            stoppedBy: 'guard',
            guardScope: 'reserveBack',
            blocked: true,
            targetIndex: i,
            targetIsReserve: false,
            target: dst,
            fresh: a.lastStatus !== 'GUARD',
          })
        );
      }

      const why = '储备号在用，' + fmtIndex(i) + ' 已恢复（' + fmtWhyUsage(dst) + '）';
      return decision(
        'SWITCH',
        'SWITCH 储备号用毕，切回 ' + fmtIndex(i) + '（' + why + '）',
        i,
        null,
        Object.assign({}, detailBase, {
          stoppedBy: 'switch',
          reserveBack: true,
          dryRun: cfg.dryRun,
          targetIndex: i,
          targetIsReserve: false,
          target: dst,
          why,
        })
      );
    }
  }

  /* ---- 当前账号还有余量 → OK ------------------------------------------- */
  if (!curSt.unavailable && !anyExhausted(curSt)) {
    return decision('OK', 'OK    ' + fmtIndex(cur) + ' 有额度 ' + fmtUsage(curSt), null, null, Object.assign({}, detailBase, {
      stoppedBy: 'ok',
      fresh: a.lastStatus !== 'OK',
    }));
  }

  /* ---- LIMIT 文案 ------------------------------------------------------ */
  let limitMsg;
  if (curSt.unavailable) {
    limitMsg = 'LIMIT ' + fmtIndex(cur) + ' 运行时报告 ' + curSt.runtimeBlocked + '（额度缓存滞后，立即换号）';
  } else if (weeklyExhausted(curSt)) {
    limitMsg = curSt.wait7 === null
      // PS 在这里会拼出空值；纯函数改为显式说明，避免日志出现"距重置约  分钟"
      ? 'LIMIT ' + fmtIndex(cur) + ' 7d 周额度耗尽，重置时间未知'
      : 'LIMIT ' + fmtIndex(cur) + ' 7d 周额度耗尽，距重置约 ' + curSt.wait7 + ' 分钟（约 ' + round1(curSt.wait7 / 60) + ' 小时）';
  } else {
    limitMsg = 'LIMIT ' + fmtIndex(cur) + ' 5h 额度耗尽，距重置约 ' + curSt.wait5 + ' 分钟';
  }

  /* ---- 自身 5h 快恢复 → WAIT，不动号 ---------------------------------- */
  if (!curSt.unavailable && !weeklyExhausted(curSt) && curSt.wait5 !== null
    && curSt.wait5 > 0 && curSt.wait5 < cfg.minWaitMin) {
    const hb = heartbeatMinutes(curSt.wait5, a);
    const waitKey = noiseKey('WAIT', cur, null);
    const lastWaitLogAtMs = num(a.lastWaitLogAtMs);
    const fresh = a.lastStatus !== 'WAIT'
      || String(a.lastWaitKey || '') !== waitKey
      || lastWaitLogAtMs === null
      || (nowMs - lastWaitLogAtMs) >= hb * MS_PER_MIN;
    return decision(
      'WAIT',
      limitMsg + '\nWAIT  距 5h 重置仅 ' + curSt.wait5 + ' 分钟 (<' + cfg.minWaitMin + ')，按策略等待，不切号',
      null,
      nextHeartbeatMs(nowMs, curSt.wait5, a),
      Object.assign({}, detailBase, {
        stoppedBy: 'selfWait',
        waitKey,
        waitKeyKind: 'self',
        fresh,
        hbMinutes: hb,
        limitMsg,
      })
    );
  }

  /* ---- 选目标：日常号 → 候选等待 → 储备号 ------------------------------ */
  let target = null;
  let targetIsReserve = false;

  for (const i of daily) {
    if (i === cur) continue;
    const st = stateOf(i);
    if (st.known && !st.unavailable && !anyExhausted(st)) {
      target = st;
      break;
    }
  }

  if (target === null) {
    for (const i of daily) {
      if (i === cur) continue;
      const st = stateOf(i);
      // wait5 > 0：负数是"窗口已重置"，那种账号在目标循环里已经算可用，绝不能在这里再等
      if (!st.known || st.unavailable || weeklyExhausted(st) || st.wait5 === null
        || !(st.wait5 > 0) || !(st.wait5 < cfg.minWaitMin)) continue;

      const hb = heartbeatMinutes(st.wait5, a);
      const waitKey = noiseKey('WAIT', cur, i);
      const lastWaitLogAtMs = num(a.lastWaitLogAtMs);
      const fresh = a.lastStatus !== 'WAIT'
        || String(a.lastWaitKey || '') !== waitKey
        || lastWaitLogAtMs === null
        || (nowMs - lastWaitLogAtMs) >= hb * MS_PER_MIN;
      return decision(
        'WAIT',
        limitMsg + '\nWAIT  ' + fmtIndex(i) + ' 有周额度但 5h 打满，仅需等 ' + st.wait5 + ' 分钟 (<' + cfg.minWaitMin + ')，暂不动用储备号',
        null,
        nextHeartbeatMs(nowMs, st.wait5, a),
        Object.assign({}, detailBase, {
          stoppedBy: 'candWait',
          waitKey,
          waitKeyKind: 'cand',
          candIndex: i,
          cand: st,
          fresh,
          hbMinutes: hb,
          limitMsg,
        })
      );
    }

    for (const reserveIndex of reserveCandidates.length ? reserveCandidates : [reserve0]) {
      const reserveSt = stateOf(reserveIndex);
      if (reserveSt.known && !reserveSt.unavailable && !anyExhausted(reserveSt) && reserveIndex !== cur) {
        target = reserveSt;
        targetIsReserve = true;
        break;
      }
    }
  }

  /* ---- 都不可用 → DEAD ------------------------------------------------- */
  if (target === null) {
    let earliest = null;
    let earliestIdx = -1;
    for (const i of (reserveCandidates.length ? reserveCandidates : [reserve0]).concat(daily)) {
      const st = stateOf(i);
      // wait7 <= 0 说明周窗口已重置（不是未来恢复点），不参与"最早恢复"
      if (!st.known || st.wait7 === null || st.wait7 <= 0) continue;
      if (earliest === null || st.wait7 < earliest) {
        earliest = st.wait7;
        earliestIdx = i;
      }
    }
    if (earliestIdx >= 0) {
      const atMs = Math.round(nowMs + earliest * MS_PER_MIN);
      return decision(
        'DEAD',
        limitMsg + '\nDEAD  所有账号周额度均已耗尽；最早恢复：' + fmtIndex(earliestIdx) + ' 于 ' + formatWhen(atMs)
          + '（约 ' + round1(earliest / 60) + ' 小时后）',
        null,
        null,
        Object.assign({}, detailBase, {
          stoppedBy: 'dead',
          earliestIndex: earliestIdx,
          earliestNo: earliestIdx + 1,
          earliestWait7: earliest,
          earliestAtMs: atMs,
          limitMsg,
          fresh: a.lastStatus !== 'DEAD',
        })
      );
    }
    return decision(
      'DEAD',
      limitMsg + '\nDEAD  所有账号均不可用，且无法确定恢复时间',
      null,
      null,
      Object.assign({}, detailBase, {
        stoppedBy: 'dead',
        earliestIndex: null,
        earliestWait7: null,
        limitMsg,
        fresh: a.lastStatus !== 'DEAD',
      })
    );
  }

  /* ---- 切号护栏（PS 里 DEAD 之后才判） --------------------------------- */
  // 只有持久的阻塞（限流 / 额度 / 认证）值得绕过护栏；冷却与容量是瞬时的，绕过只会来回切号。
  const hardRuntimeBlock = curSt.unavailable && isHardRuntimeReason(curSt.runtimeBlocked)
    && !isTransientRuntimeReason(curSt.runtimeBlocked);
  if (gapMs < guardMs && !hardRuntimeBlock) {
    return decision(
      'GUARD',
      limitMsg + '\nGUARD 距上次切换不足 ' + cfg.minGapSec + ' 秒，跳过本次切换',
      target.index,
      null,
      Object.assign({}, detailBase, {
        stoppedBy: 'guard',
        guardScope: 'switch',
        blocked: true,
        targetIndex: target.index,
        targetIsReserve,
        target,
        limitMsg,
        fresh: a.lastStatus !== 'GUARD',
      })
    );
  }

  /* ---- why 文案 -------------------------------------------------------- */
  const fromNo = cur + 1;
  const toNo = target.index + 1;
  let why;
  if (weeklyExhausted(curSt)) {
    why = '7d 周额度耗尽';
  } else if (shortExhausted(curSt)) {
    why = '5h 耗尽且距重置 ' + curSt.wait5 + ' 分钟 >= ' + cfg.minWaitMin;
  } else {
    // 只可能是运行时硬阻塞，或缓存窗口已重置但快照还没刷新的临时状态
    why = curSt.unavailable ? '运行时不可用：' + curSt.runtimeBlocked : '缓存快照滞后（窗口已重置）';
  }
  if (targetIsReserve) why = why + '；日常号均不可用，启用储备号';

  /* ---- 自动切号关闭 ---------------------------------------------------- */
  if (!cfg.autoSwitch) {
    return decision(
      'DISABLED',
      limitMsg + '\nDISABLED 自动切号已关闭：按规则应切换 ' + fromNo + ' -> ' + toNo + '（' + why + '），已跳过',
      target.index,
      null,
      Object.assign({}, detailBase, {
        stoppedBy: 'disabled',
        targetIndex: target.index,
        targetIsReserve,
        target,
        why,
        limitMsg,
        fresh: a.lastStatus !== 'DISABLED',
      })
    );
  }

  /* ---- 干跑 ------------------------------------------------------------ */
  if (cfg.dryRun) {
    return decision(
      'SWITCH',
      limitMsg + '\nDRYRUN 将切换 ' + fromNo + ' -> ' + toNo + '（' + why + '）',
      target.index,
      null,
      Object.assign({}, detailBase, {
        stoppedBy: 'dryRun',
        dryRun: true,
        targetIndex: target.index,
        targetIsReserve,
        target,
        why,
        limitMsg,
      })
    );
  }

  /* ---- 真正建议切号 ---------------------------------------------------- */
  return decision(
    'SWITCH',
    limitMsg + '\nSWITCH 切换 ' + fromNo + ' -> ' + toNo + '（' + why + '）',
    target.index,
    null,
    Object.assign({}, detailBase, {
      stoppedBy: 'switch',
      dryRun: false,
      targetIndex: target.index,
      targetIsReserve,
      target,
      why,
      limitMsg,
    })
  );
}

module.exports = {
  classifyWindows,
  describeAccount,
  toPolicyMap,
  decide,
  nextHeartbeatMs,
  heartbeatMinutes,
  noiseKey,
  ACTIONS,
  DEFAULTS,
  MIN_GAP_SEC,
  MIN_WAIT_MIN,
  HEARTBEAT,
  HARD_RUNTIME_REASONS,
  COOLDOWN_RUNTIME_PREFIX,
  isHardRuntimeReason,
  isTransientRuntimeReason,
  TRANSIENT_RUNTIME_TRUST_MS,
  MODEL_CAPACITY_RUNTIME_RE,
  AUTH_RUNTIME_RE,
  planExhaustionPauses,
};
