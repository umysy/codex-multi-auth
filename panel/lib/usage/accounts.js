'use strict';
/**
 * 账号清单：序号、邮箱、额度快照，以及路由正在用 / 策略首选的账号。
 *
 * 两个入口：
 * - `parseStatusJson(raw)`：纯函数，吃 `codex-multi-auth status --json` 的文本；
 * - `loadAccounts(deps)`：跑一次 CLI 再解析，失败时返回空清单（不影响 token 统计）。
 *
 * 周窗口的判定与 lib/dashboard.js 的 pickWindows 同一口径（weekly = 窗口 >= 10080 分钟）。
 */
const WEEK_MS = 7 * 86400000;

/** 从额度快照里取周窗口；没有时返回 null。 */
function weeklyWindow(quota) {
  const wins = quota ? [quota.primary, quota.secondary].filter(Boolean) : [];
  return wins.find((w) => Number(w.windowMinutes || 0) >= 10080) || null;
}

/**
 * @param {string} raw `status --json` 的原始输出
 * @returns {{list: Array<{key:string,index:number,email:string,quota:object}>, activeIndex:number, inUseIndex:number}}
 */
function parseStatusJson(raw) {
  const j = JSON.parse(raw);
  const list = [];
  for (const a of (j.accounts || [])) {
    const label = String(a.label || '');
    const em = label.match(/([\w.+-]+@[\w.-]+\.[A-Za-z]{2,})/);
    const index = Number.isInteger(a.index) ? a.index : list.length;
    list.push({ key: 'a' + index, index, email: em ? em[1] : label, quota: a.quota || null });
  }
  return {
    list,
    activeIndex: Number.isInteger(j.activeIndex) ? j.activeIndex : -1,
    inUseIndex: Number.isInteger(j.runtimeInUseIndex) ? j.runtimeInUseIndex : -1,
  };
}

/**
 * @param {{execFileSync: Function, nodeExe: string, cli: string}} deps
 */
function loadAccounts(deps) {
  try {
    const raw = deps.execFileSync(deps.nodeExe, [deps.cli, 'status', '--json'], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    return parseStatusJson(raw.slice(raw.indexOf('{')));
  } catch (e) {
    return { list: [], activeIndex: -1, inUseIndex: -1 };
  }
}

module.exports = { WEEK_MS, weeklyWindow, parseStatusJson, loadAccounts };
