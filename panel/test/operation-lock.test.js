'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { withLock } = require('../lib/operation-lock');

test('account operation lock rejects overlap and releases after failure', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-lock-'));
  const lock = path.join(dir, 'account.lock');
  try {
    let releaseWork;
    const first = withLock(() => new Promise((resolve) => { releaseWork = resolve; }), lock);
    await new Promise((resolve) => setImmediate(resolve));
    const busy = await withLock(async () => ({ ok: true }), lock);
    assert.equal(busy.busy, true);
    releaseWork({ ok: true });
    await first;
    assert.deepEqual(await withLock(async () => ({ ok: true }), lock), { ok: true });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
