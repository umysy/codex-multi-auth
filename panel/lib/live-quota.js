'use strict';
/**
 * 实时额度：路由把每个真实请求响应头里的额度写进 live-quota.json（CLI 补丁 v4）。
 *
 * quota-cache.json 只在 `limits --refresh` 时更新，而每次 refresh 都会给每个账号发一条
 * 真实的 "quota ping" 请求（约 5k token）——所以只有用户点「刷新额度」才探测。
 * 面板取两者里更新的那份：在用的账号几秒内就能看到变化，其它账号停在上次手动刷新的数字。
 */

function mergeWindow(base, live) {
  if (!live || typeof live.usedPercent !== 'number') return base || null;
  const out = Object.assign({}, base || {});
  for (const k of ['usedPercent', 'windowMinutes', 'resetAtMs']) if (live[k] !== undefined && live[k] !== null) out[k] = live[k];
  return out;
}

/**
 * 纯函数：探测快照 + 实时快照 → 面板该显示的额度。
 * 实时快照更新时才覆盖；只覆盖它带了的字段（窗口长度缺失时沿用探测快照的）。
 */
function freshestQuota(probed, live) {
  const base = probed && typeof probed === 'object' ? probed : {};
  if (!live || typeof live !== 'object' || !(Number(live.updatedAt) > (Number(base.updatedAt) || 0))) {
    return Object.keys(base).length ? Object.assign({}, base, { source: 'probe' }) : base;
  }
  return Object.assign({}, base, {
    updatedAt: Number(live.updatedAt),
    status: typeof live.status === 'number' ? live.status : base.status,
    planType: live.planType || base.planType,
    primary: mergeWindow(base.primary, live.primary),
    secondary: mergeWindow(base.secondary, live.secondary),
    source: 'live',
  });
}

module.exports = { freshestQuota };
