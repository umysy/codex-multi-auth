'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const STALE_MS = 15 * 60 * 1000;

function tryAcquire(lockPath = paths.OPERATIONS_LOCK) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }), 'utf8');
    return () => {
      try { fs.closeSync(fd); } catch { /* already closed */ }
      try { fs.unlinkSync(lockPath); } catch { /* another owner cleaned it */ }
    };
  } catch (err) {
    if (err && err.code !== 'EEXIST') throw err;
    try {
      const raw = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (Number.isInteger(raw.pid) && raw.pid > 0) {
        try { process.kill(raw.pid, 0); }
        catch (e) { if (e.code === 'ESRCH') { fs.unlinkSync(lockPath); return tryAcquire(lockPath); } }
      }
    } catch { /* a live owner may have the file open */ }
    return null;
  }
}

async function withLock(work, lockPath) {
  const release = tryAcquire(lockPath);
  if (!release) return { ok: false, busy: true, code: 'ACCOUNT_OPERATION_BUSY' };
  try { return await work(); } finally { release(); }
}

module.exports = { STALE_MS, tryAcquire, withLock };
