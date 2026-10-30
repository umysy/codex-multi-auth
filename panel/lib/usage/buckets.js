'use strict';
/**
 * 用量聚合的纯函数层：桶（token 计数）、按天序列、视图组装、每个账号的周窗口小结。
 *
 * 这一层不读文件、不跑 CLI，只吃“已经解析好的事件”；可以在 Node 里直接单测
 * （panel/test/usage-units.test.js）。
 *
 * 以前这里还有“每 1% 周额度约多少 token”的换算：它把缓存输入也算进去，同一账号不同窗口
 * 能差出好几倍（10-29 实测离散系数 0.93），数字没有参考价值，已删除。
 */
const DAY_MS = 86400000;

function zero() { return { input: 0, cached: 0, output: 0, reasoning: 0, tokens: 0, events: 0 }; }

function add(dst, src) {
  dst.input += src.input;
  dst.cached += src.cached;
  dst.output += src.output;
  dst.reasoning += src.reasoning;
  dst.tokens += src.tokens;
  dst.events += src.events;
}

/** 本地日期键（YYYY-MM-DD）；面板按本地时区展示，不要改成 UTC。 */
function dayKey(ts) {
  const d = new Date(ts);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function newRec(key, label) {
  return {
    key, label,
    total: zero(), days: new Map(), hours: new Array(24).fill(0),
    roles: new Map(), models: new Map(), projects: new Map(), sessions: new Map(),
  };
}

function bump(map, key, field, tokens, events) {
  const cur = map.get(key) || { [field]: key, tokens: 0, events: 0 };
  cur.tokens += tokens;
  if (events) cur.events += events;
  map.set(key, cur);
}

/**
 * 把一个用量事件计入桶。ctx: {dayStartMs, role?, model, project, threadId?}
 * role / threadId 只有会话文件才有（账本没有），缺省时不计角色与会话。
 */
function tally(rec, e, ctx) {
  const u = e.u;
  add(rec.total, u);
  const dk = dayKey(e.ts);
  const d = rec.days.get(dk) || zero();
  add(d, u);
  rec.days.set(dk, d);
  if (e.ts >= ctx.dayStartMs) rec.hours[new Date(e.ts).getHours()] += u.tokens;
  if (ctx.role) bump(rec.roles, ctx.role, 'role', u.tokens, 1);
  bump(rec.models, ctx.model || '未知', 'model', u.tokens, 1);
  bump(rec.projects, ctx.project || '未知', 'project', u.tokens, 1);
  if (ctx.threadId) bump(rec.sessions, ctx.threadId, 'id', u.tokens, 0);
}

/** 按天序列（补零），从 rangeDays 天前到今天。 */
function series(map, dayStartMs, rangeDays) {
  const out = [];
  for (let i = rangeDays - 1; i >= 0; i--) {
    const key = dayKey(dayStartMs - i * DAY_MS);
    const d = map.get(key) || zero();
    out.push({ date: key, input: d.input, cached: d.cached, output: d.output, reasoning: d.reasoning, tokens: d.tokens, events: d.events });
  }
  return out;
}

function sessionTop(rec, threads, limit) {
  const arr = [];
  rec.sessions.forEach((v, id) => {
    const m = threads.get(id) || {};
    arr.push({
      id, tokens: v.tokens,
      title: String(m.title || '').slice(0, 80),
      project: m.project || '',
      model: m.model || '',
      updatedAt: m.updatedAt || 0,
    });
  });
  return arr.sort((a, b) => b.tokens - a.tokens).slice(0, limit);
}

/** 视图（/api/usage 的顶层与 accounts[] 每一项同形）。 */
function view(rec, ctx) {
  const days = series(rec.days, ctx.dayStartMs, ctx.rangeDays);
  return {
    key: rec.key,
    label: rec.label,
    totals: rec.total,
    today: days[days.length - 1] || zero(),
    days,
    hours: rec.hours,
    cacheHitRate: rec.total.input ? rec.total.cached / rec.total.input : 0,
    byRole: [...rec.roles.values()].sort((a, b) => b.tokens - a.tokens),
    byModel: [...rec.models.values()].sort((a, b) => b.tokens - a.tokens),
    byProject: [...rec.projects.values()].sort((a, b) => b.tokens - a.tokens).slice(0, 10),
    topSessions: ctx.threads ? sessionTop(rec, ctx.threads, 12) : [],
  };
}

/**
 * 某个账号当前周窗口的小结：窗口起止、已用百分比、窗口开始以来这个账号消耗的 token。
 * events 是账本事件（已按账号过滤）；窗口起点 = 重置时刻 - 7 天。
 */
function windowSummary(acct, weekly, events, weekMs) {
  const resetAt = weekly && Number(weekly.resetAtMs) > 0 ? Number(weekly.resetAtMs) : null;
  const startAt = resetAt ? resetAt - weekMs : null;
  const used = weekly && Number.isFinite(Number(weekly.usedPercent)) ? Number(weekly.usedPercent) : null;
  const sum = zero();
  if (startAt) for (const e of events) if (e.ts >= startAt) add(sum, e.u);
  return {
    key: acct.key, label: acct.email, startAt, resetAt, usedPercent: used,
    tokens: sum.tokens, input: sum.input, cached: sum.cached, output: sum.output, events: sum.events,
  };
}

module.exports = { DAY_MS, zero, add, dayKey, newRec, bump, tally, series, sessionTop, view, windowSummary };
