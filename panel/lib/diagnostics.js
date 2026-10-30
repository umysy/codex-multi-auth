'use strict';

const { readJson } = require('./fs-json');
const paths = require('./paths');
const { readLogs } = require('./usage-logs');
const { readSchedule, loadPolicy } = require('./policy-store');
const { readRouter } = require('./router-control');
const { recentErrors } = require('./error-journal');
const { createHash } = require('crypto');
const { summarizeRuntime } = require('./runtime-health');

/**
 * 可分享的诊断快照：只包含版本、状态、错误码和脱敏日志，不返回账号文件、token、邮箱或绝对路径。
 */
function buildDiagnostics() {
  let policy = null;
  let policyError = null;
  try { policy = loadPolicy(); } catch (error) { policyError = { code: error.code || 'POLICY_CONFIG_INVALID', message: error.message }; }
  const obs = readJson(paths.OBSERVABILITY, null);
  const runtimeSummary = summarizeRuntime(obs);
  const router = readRouter();
  const schedule = readSchedule();
  const reasons = new Set(['rate-limited', 'quota-exhausted', 'cooling-down:network-error', 'cooling-down:server-error', 'model-not-supported', 'policy: paused', 'policy: drained']);
  const knownReason = (value) => {
    const r = String(value || '').toLowerCase();
    return reasons.has(r) || /model[\s_-]*capacity|capacity[\s_-]*(exhausted|insufficient|unavailable)|(?:auth|unauthori[sz]ed|token)[\s_-]*(invalid|expired|revoked|failed)|invalid[\s_-]*token/i.test(r) ? r : 'other';
  };
  return {
    schemaVersion: 1,
    appVersion: '2.0.0',
    nodeVersion: process.version,
    environment: process.env.CODEX_HOME ? 'custom-CODEX_HOME' : 'default-CODEX_HOME',
    config: policy ? { autoSwitch: policy.autoSwitch, minWaitMin: policy.minWaitMin, reserveIndex: policy.reserveIndex, mode: policy.rotation ? 'daily-reserve' : 'legacy', dailyCount: policy.rotation?.daily.length, reserveCount: policy.rotation?.reserve.length } : null,
    configError: policyError ? { code: 'POLICY_CONFIG_INVALID' } : null,
    schedule: schedule ? { lastRunAtMs: schedule.lastRunAtMs, tickCount: schedule.tickCount, lastStatus: /^[A-Z-]{1,24}$/.test(schedule.lastStatus) ? schedule.lastStatus : 'UNKNOWN', runId: schedule.runId, errorCode: schedule.errorCode } : null,
    router: { running: router.running === true, port: router.port, requests: router.requests, errorFingerprint: router.lastError ? createHash('sha256').update(router.lastError).digest('hex').slice(0, 12) : null },
    runtime: obs ? {
      updatedAt: Number(obs.updatedAt) || 0,
      fresh: runtimeSummary.fresh,
      ageMs: runtimeSummary.ageMs,
      globalIncident: runtimeSummary.global,
      blockedReasons: Object.values(obs.accountSkipReasons || {}).map(knownReason),
    } : null,
    logs: readLogs(80).map(e => ({ at: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(e.at) ? e.at : '', kind: /^[A-Z_]{1,20}$/.test(e.kind) ? e.kind : 'OTHER', src: e.src })),
    errors: recentErrors(),
    privacy: { redacted: true, credentialsIncluded: false, accountFilesIncluded: false },
  };
}

module.exports = { buildDiagnostics };
