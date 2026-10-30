'use strict';
/**
 * 用量统计的装配层，两个数据来源各管一块：
 * - 会话文件（~/.codex/sessions）：“全部账号”的总量、按天/小时、角色、模型、项目、会话排行。
 *   覆盖所有 Codex 请求（包括路由启用之前的），与路由账本逐日对照误差约 3%。
 * - 路由账本（<multi-auth>/usage）：按账号拆分。每行记着请求实际用的账号；会话文件没有这个信息，
 *   以前按“周窗口重置时刻”猜，跨账号的长会话会被整体算到一个号上。
 *   账本没有会话标题，所以把每条账本请求按 token 数配对回会话事件，单个账号也能拆角色和会话排行；
 *   配不上的请求按模型推角色（codex-auto-review → 自动 review），不计入会话排行。
 *
 * 依赖注入（deps）：execFileSync / nodeExe / cli（读账号清单）、loadAccounts、sessionsRoot、stateDb、
 * ledgerDir、liveQuota（实时额度，见 lib/live-quota.js）、accountIds、now。
 *
 * 只读：不写任何文件、不改账号状态。
 */
const fs = require('fs');
const usagePaths = require('./paths');
const { loadThreads, roleOf } = require('./threads');
const { loadAccounts, weeklyWindow, WEEK_MS } = require('./accounts');
const { walk, readSessionFile } = require('./sessions');
const { loadLedger, tokenKey, matchSession } = require('./ledger');

// 账本请求与会话事件配对的最大时间差。
const MATCH_LAG_MS = 30 * 60000;
const buckets = require('./buckets');
const { freshestQuota } = require('../live-quota');
const { readJson } = require('../fs-json');
const { readProxyAccounts } = require('../proxy-accounts');
const paths = require('../paths');

/**
 * @param {number} rangeDays 统计最近几天（含今天）
 * @param {object} deps 见文件头
 */
async function collect(rangeDays, deps) {
  const now = typeof deps.now === 'function' ? deps.now() : Date.now();
  const t0 = Date.now();
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();
  const cutoff = dayStartMs - (rangeDays - 1) * buckets.DAY_MS;

  const threads = loadThreads(deps.stateDb);
  const acctInfo = deps.loadAccounts ? deps.loadAccounts() : loadAccounts(deps);

  // 全部账号：会话文件
  const all = buckets.newRec('all', '全部账号');
  const byTokens = new Map();
  const files = [];
  walk(deps.sessionsRoot || usagePaths.SESSIONS_ROOT, files);
  let scannedFiles = 0;
  let scannedBytes = 0;
  for (const f of files) {
    let st;
    try { st = fs.statSync(f); } catch (e) { continue; }
    if (st.mtimeMs < cutoff) continue;
    scannedFiles++;
    scannedBytes += st.size;
    const parsed = await readSessionFile(f, { cutoff });
    const meta = threads.get(parsed.threadId) || {};
    const ctx = { dayStartMs, role: roleOf(meta.model, meta.title), model: meta.model || '', project: meta.project || '', threadId: parsed.threadId };
    for (const e of parsed.events) {
      buckets.tally(all, e, ctx);
      const key = tokenKey(e.u);
      if (!byTokens.has(key)) byTokens.set(key, []);
      byTokens.get(key).push({ ts: e.ts, ctx, used: false });
    }
  }

  // 按账号：路由账本。周窗口小结要从窗口起点算，可能早于统计范围，所以多读到 7 天前。
  const ledgerFrom = Math.min(cutoff, now - WEEK_MS);
  const ledger = loadLedger(deps.ledgerDir || usagePaths.LEDGER_DIR, ledgerFrom).sort((x, y) => x.ts - y.ts);
  const live = deps.liveQuota !== undefined ? deps.liveQuota : readJson(paths.LIVE_QUOTA, null);
  const liveById = live && live.byAccountId ? live.byAccountId : {};
  const accountIds = deps.accountIds || readProxyAccounts().accounts.map((a) => a.accountId);

  const accounts = [];
  const windows = [];
  for (const a of acctInfo.list) {
    const mine = ledger.filter((e) => e.index === a.index);
    const rec = buckets.newRec(a.key, a.email);
    let matched = 0;
    for (const e of mine) {
      if (e.ts < cutoff) continue;
      const hit = matchSession(byTokens, e, MATCH_LAG_MS);
      if (hit) matched += e.u.tokens;
      buckets.tally(rec, e, hit
        ? { dayStartMs, role: hit.ctx.role, model: e.model || hit.ctx.model, project: hit.ctx.project || e.project, threadId: hit.ctx.threadId }
        : { dayStartMs, role: /auto-review/i.test(e.model) ? '自动 review' : '未配对到会话', model: e.model, project: e.project });
    }
    const v = buckets.view(rec, { dayStartMs, rangeDays, threads });
    v.matchedShare = rec.total.tokens ? matched / rec.total.tokens : null;
    const quota = freshestQuota(a.quota || {}, liveById[accountIds[a.index]]);
    v.window = buckets.windowSummary(a, weeklyWindow(quota), mine, WEEK_MS);
    windows.push(v.window);
    accounts.push(v);
  }

  const inUse = acctInfo.inUseIndex >= 0 ? acctInfo.inUseIndex : acctInfo.activeIndex;
  const current = inUse >= 0 ? accounts.find((a) => a.key === 'a' + inUse) : null;
  const allView = buckets.view(all, { dayStartMs, rangeDays, threads });
  return Object.assign(allView, {
    now: t0,
    rangeDays,
    accounts,
    current: current ? { key: current.key, email: current.label } : null,
    windows,
    sources: { all: 'sessions', accounts: ledger.length ? 'ledger' : 'none', ledgerEvents: ledger.length },
    scan: { files: scannedFiles, mb: Math.round(scannedBytes / 1048576), ms: Date.now() - t0 },
  });
}

module.exports = { collect };
