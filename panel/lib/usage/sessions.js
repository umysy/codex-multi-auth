'use strict';
/**
 * 读 rollout 会话文件（`~/.codex/sessions/**\/*.jsonl`），提取 token_count 事件的时间与用量。
 *
 * 会话文件不带账号信息，这里也不再猜账号：按账号的用量来自路由账本（ledger.js）。
 * Codex 在只有额度信息更新时会重复写一条 token_count（累计用量不变），
 * 这种重复事件要跳过，否则同一次请求被算两遍（10-29 实测每天约 40 条）。
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const THREAD_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/** 递归列出目录下所有 .jsonl 文件；目录不可读时静默返回（不抛）。 */
function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
}

/** 从 token_count 事件里取这一次请求的用量（last_token_usage；旧格式只有 total 时退回 total）。 */
function usageOf(info) {
  const last = (info && (info.last_token_usage || info.total_token_usage)) || {};
  return {
    input: Number(last.input_tokens || 0),
    cached: Number(last.cached_input_tokens || 0),
    output: Number(last.output_tokens || 0),
    reasoning: Number(last.reasoning_output_tokens || 0),
    tokens: Number(last.total_tokens || 0),
    events: 1,
  };
}

/**
 * 扫描一个会话文件。
 * @param {string} file
 * @param {{cutoff:number}} ctx
 * @returns {Promise<{threadId:string, events:Array<{ts:number,u:object}>}>}
 */
async function readSessionFile(file, ctx) {
  const mm = path.basename(file).match(THREAD_RE);
  const threadId = mm ? mm[1] : '';
  const events = [];
  let prevTotal = null;
  const rl = readline.createInterface({
    input: fs.createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.indexOf('"token_count"') < 0) continue;
    let j;
    try { j = JSON.parse(line); } catch (e) { continue; }
    const info = j.payload && j.payload.info;
    if (!info) continue; // 只有额度、没有用量的事件
    const running = info.total_token_usage ? Number(info.total_token_usage.total_tokens || 0) : null;
    if (running !== null && running === prevTotal) continue; // 累计没变：重复事件
    if (running !== null) prevTotal = running;
    const ts = Date.parse(j.timestamp || '');
    if (!Number.isFinite(ts) || ts < ctx.cutoff) continue;
    events.push({ ts, u: usageOf(info) });
  }
  return { threadId, events };
}

module.exports = { THREAD_RE, walk, usageOf, readSessionFile };
