'use strict';

const CAPACITY = /model[\s_-]*capacity|capacity[\s_-]*(?:exhausted|insufficient|unavailable)/i;
const AUTH = /(?:auth|unauthori[sz]ed|token)[\s_-]*(?:invalid|expired|revoked|failed)|invalid[\s_-]*token/i;

function normalizeReason(value) { return String(value || '').trim().toLowerCase(); }

function classifyReason(value) {
  const reason = normalizeReason(value);
  if (!reason) return 'unknown';
  if (reason === 'rate-limited' || reason === 'quota-exhausted') return 'quota';
  if (CAPACITY.test(reason)) return 'capacity';
  if (AUTH.test(reason)) return 'auth';
  if (reason.startsWith('cooling-down')) return 'network';
  if (reason === 'model-not-supported') return 'model';
  return 'other';
}

function summarizeRuntime(obs, nowMs = Date.now(), ttlMs = 120000) {
  if (!obs || typeof obs !== 'object') return { present: false, fresh: false, global: null, accounts: [], reasons: [] };
  const updatedAt = Number(obs.updatedAt);
  const ageMs = Number.isFinite(updatedAt) ? nowMs - updatedAt : Infinity;
  const skips = obs.accountSkipReasons && typeof obs.accountSkipReasons === 'object' ? obs.accountSkipReasons : {};
  const accounts = Object.entries(skips).map(([index, value]) => ({ index: Number(index), reason: normalizeReason(value), class: classifyReason(value) })).filter(x => Number.isInteger(x.index) && x.reason);
  const counts = new Map();
  for (const entry of accounts) counts.set(entry.class, (counts.get(entry.class) || 0) + 1);
  const global = accounts.length > 1 && [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    present: true,
    fresh: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs,
    updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0,
    ageMs: Number.isFinite(ageMs) ? ageMs : null,
    global: Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= ttlMs && global && global[1] === accounts.length ? global[0] : null,
    accounts,
    reasons: [...new Set(accounts.map(x => x.reason))].sort(),
  };
}

module.exports = { normalizeReason, classifyReason, summarizeRuntime, CAPACITY, AUTH };
