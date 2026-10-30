'use strict';
/**
 * 面板上的账号操作 -> CLI 命令映射。
 *
 * 单个动作一次调度：所有会改变状态的操作统一在这里“执行 + 立即失效缓存”，
 * 避免 handler 里到处写 invalidate()。
 *
 * 账号操作都是一次写入目标状态（pause/unpause/note），天然幂等；CLI 极少数情况下
 * 会静默卡到超时（例如被外部进程/杀软阻塞在文件锁上）。这里在超时后短暂延迟
 * 重试一次，把这类瞬时故障挡掉；两次仍失败时把真实原因带回面板，而不是只显示
 * 固定的“账号操作失败”。
 */
const { runCli } = require('./cli');
const { invalidate } = require('./state-cache');
const { withLock } = require('./operation-lock');
const { extractJson } = require('./fs-json');
const { loadPolicy } = require('./policy-store');

const ACCOUNT_TIMEOUT_MS = positiveEnv('PANEL_ACCOUNT_ACTION_TIMEOUT_MS', 25000);
const RETRY_DELAY_MS = positiveEnv('PANEL_ACCOUNT_ACTION_RETRY_DELAY_MS', 1500);

function positiveEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const SIMPLE = {
  pause: (n) => ['account', 'pause', String(n)],
  unpause: (n) => ['account', 'unpause', String(n)],
  reserve: (n) => ['account', 'emergency-only', String(n), 'on'],
  unreserve: (n) => ['account', 'emergency-only', String(n), 'off'],
  switch: (n) => ['switch', String(n)],
  unpin: () => ['unpin'],
};

/** 跑一次账号操作 CLI；仅对 CLI_TIMEOUT 重试一次。 */
async function runActionCli(args, retryTimeout = true) {
  const first = await runCli(args, ACCOUNT_TIMEOUT_MS);
  if (!retryTimeout || first.ok || first.code !== 'CLI_TIMEOUT') return first;
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
  const second = await runCli(args, ACCOUNT_TIMEOUT_MS);
  if (second.ok) return second;
  return {
    ok: false,
    code: 'CLI_TIMEOUT',
    out: second.out,
    safeOut: second.safeOut,
    operationId: second.operationId,
    error: 'CLI 超时（' + ACCOUNT_TIMEOUT_MS + 'ms）且重试一次仍超时：' + (second.error || ''),
  };
}

async function runAccountAction(n, action, value) {
  return withLock(async () => {
    if (action === 'note') {
      const text = String(value || '').slice(0, 200);
      const r = await runActionCli(['account', 'note', String(n), text]);
      invalidate();
      return r;
    }
    if (action === 'reserve' || action === 'unreserve') {
      if (loadPolicy().rotation) return { ok: false, code: 'CUSTOM_ROLE_RULE_REQUIRED', error: '自定义轮换已启用，请在账户规则中修改角色并保存策略' };
      const snapshot = await runCli(['account', 'policy', 'list', '--json'], ACCOUNT_TIMEOUT_MS);
      const policies = snapshot.ok ? extractJson(snapshot.out) : null;
      const original = policies?.accounts?.find(p => Number(p.index) === Number(n));
      if (!original || typeof original.emergencyOnly !== 'boolean' || typeof original.paused !== 'boolean') {
        return { ok: false, code: 'ACCOUNT_POLICY_READ_FAILED', error: '无法确认账号原有角色和暂停状态，未执行变更' };
      }
      try {
        const first = await runActionCli(action === 'reserve' ? SIMPLE.reserve(n) : SIMPLE.unreserve(n), false);
        if (!first.ok) return first;
        const second = await runActionCli(action === 'reserve' ? ['account', 'pause', String(n)] : ['account', 'unpause', String(n)]);
        if (!second.ok) {
          const role = await runActionCli(['account', 'emergency-only', String(n), original.emergencyOnly ? 'on' : 'off'], false);
          const pause = await runActionCli(['account', original.paused ? 'pause' : 'unpause', String(n)], false);
          const verified = await runCli(['account', 'policy', 'list', '--json'], ACCOUNT_TIMEOUT_MS);
          const current = verified.ok ? extractJson(verified.out)?.accounts?.find(p => Number(p.index) === Number(n)) : null;
          const restored = role.ok && pause.ok && current?.emergencyOnly === original.emergencyOnly && current?.paused === original.paused;
          return { ok: false, code: restored ? 'ACCOUNT_ACTION_ROLLED_BACK' : 'ACCOUNT_ACTION_PARTIAL',
            error: restored ? '配套暂停状态更新失败，已回写原有角色和暂停状态' : '账号变更未完整完成，恢复原状态也未确认；请刷新检查角色和暂停状态',
            operationId: second.operationId };
        }
        return first;
      } finally { invalidate(); }
    }
    const build = SIMPLE[action];
    if (!build) return { ok: false, code: 'UNKNOWN_ACCOUNT_ACTION', error: '未知操作: ' + action };
    const r = await runActionCli(build(n), action === 'pause' || action === 'unpause');
    invalidate();
    return r;
  });
}

module.exports = { runAccountAction };
