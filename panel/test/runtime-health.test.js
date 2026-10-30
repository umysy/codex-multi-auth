'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { classifyReason, summarizeRuntime } = require('../lib/runtime-health');

test('runtime reason classification separates quota, capacity, auth and network', () => {
  assert.equal(classifyReason('quota-exhausted'), 'quota');
  assert.equal(classifyReason('model capacity insufficient'), 'capacity');
  assert.equal(classifyReason('token-expired'), 'auth');
  assert.equal(classifyReason('cooling-down:network-error'), 'network');
  assert.equal(classifyReason('model-not-supported'), 'model');
});

test('runtime summary detects a fresh global incident without exposing account data', () => {
  const now = 1800000000000;
  const s = summarizeRuntime({ updatedAt: now - 1000, accountSkipReasons: { 0: 'model-capacity', 1: 'model capacity insufficient', 2: 'model-capacity' } }, now);
  assert.equal(s.fresh, true);
  assert.equal(s.global, 'capacity');
  assert.deepEqual(s.reasons, ['model capacity insufficient', 'model-capacity']);
  assert.deepEqual(Object.keys(s.accounts[0]).sort(), ['class', 'index', 'reason']);
});

test('stale runtime observations never become a current global incident', () => {
  const now = 1800000000000;
  const s = summarizeRuntime({ updatedAt: now - 120001, accountSkipReasons: { 0: 'rate-limited', 1: 'rate-limited' } }, now);
  assert.equal(s.fresh, false);
  assert.equal(s.global, null);
});
