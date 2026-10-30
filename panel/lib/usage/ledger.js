'use strict';
/**
 * 路由的用量账本（`<multi-auth>/usage/usage-ledger*.jsonl`）：每个经过本机路由的请求一行，
 * 带“实际用的哪个账号”和 token 用量。
 *
 * 按账号拆分用量只能用它：会话文件里没有账号信息，以前靠“周窗口重置时刻”猜，
 * 一个跨好几个账号的长会话会被整体算到一个号上（10-29 实测：账号 3 被算成 14.8 亿，账本里是 8.3 亿）。
 */
const fs = require('fs');
const path = require('path');

const FILE_RE = /^usage-ledger(?:\.[0-9TZ]+)?\.jsonl$/;

/** 账本里的 projectKey 是“目录名-哈希”，界面只显示目录名。 */
function projectOf(key) {
  return String(key || '').replace(/-[0-9a-f]{8,}$/i, '') || '';
}

/** 一行账本 → 统一的用量事件；不是路由请求或没有 token 的行返回 null。 */
function parseLine(line, fromMs) {
  if (!line) return null;
  let j;
  try { j = JSON.parse(line); } catch (e) { return null; }
  if (!j || j.source !== 'runtime-proxy' || !j.tokens) return null;
  const ts = Number(j.createdAt);
  if (!Number.isFinite(ts) || ts < fromMs) return null;
  const index = j.account && Number.isInteger(j.account.index) ? j.account.index : null;
  if (index === null) return null;
  const t = j.tokens;
  return {
    ts,
    index,
    model: String(j.model || ''),
    project: projectOf(j.projectKey),
    u: {
      input: Number(t.inputTokens || 0),
      cached: Number(t.cachedInputTokens || 0),
      output: Number(t.outputTokens || 0),
      reasoning: Number(t.reasoningTokens || 0),
      tokens: Number(t.totalTokens || 0),
      events: 1,
    },
  };
}

/**
 * 读出 fromMs 之后的全部账本事件（含按大小轮转出去的旧文件）。目录不存在时返回空数组。
 * @param {string} dir
 * @param {number} fromMs
 */
function loadLedger(dir, fromMs) {
  let names;
  try { names = fs.readdirSync(dir).filter((n) => FILE_RE.test(n)); } catch (e) { return []; }
  const out = [];
  for (const name of names) {
    let text;
    try { text = fs.readFileSync(path.join(dir, name), 'utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      const e = parseLine(line.trim(), fromMs);
      if (e) out.push(e);
    }
  }
  return out;
}

/** 会话事件按“输入 / 缓存输入”token 数建索引的键（输出在请求被取消时两边会不一样，不参与）。 */
function tokenKey(u) {
  return u.input + '|' + u.cached;
}

/**
 * 给一条账本请求找对应的会话事件：输入与缓存输入 token 数完全相同、时间最近、还没被别的请求占用。
 * 10-29 实测：88% 的请求、97.7% 的 token 能对上，时间差中位数 0.6 秒。
 * @param {Map<string, Array<{ts:number, used:boolean}>>} index
 * @returns {object|null} 命中的会话事件（已标记 used）
 */
function matchSession(index, e, maxLagMs) {
  const list = index.get(tokenKey(e.u));
  if (!list) return null;
  let best = null;
  let bestLag = Infinity;
  for (const c of list) {
    if (c.used) continue;
    const lag = Math.abs(c.ts - e.ts);
    if (lag < bestLag) { bestLag = lag; best = c; }
  }
  if (!best || bestLag > maxLagMs) return null;
  best.used = true;
  return best;
}

module.exports = { loadLedger, parseLine, projectOf, tokenKey, matchSession };
