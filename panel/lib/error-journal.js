'use strict';
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { errorInfo } = require('./errors');
const { readTail } = require('./fs-json');
const { trimFile } = require('./retention');

const file = () => path.join(paths.DATA, 'panel-errors.jsonl');
// Only allowlisted non-private metadata persists. Request bodies and exception text never enter this journal.
function recordError(error, fallback = 'INTERNAL_ERROR', operationId) {
  const info = errorInfo(error, fallback);
  if (operationId) info.operationId = operationId;
  info.code = typeof info.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(info.code) ? info.code : fallback;
  const entry = { at: Date.now(), code: info.code, operationId: info.operationId, version: 1 };
  try { fs.mkdirSync(paths.DATA, { recursive: true }); trimFile(file(), 1024 * 1024); fs.appendFileSync(file(), JSON.stringify(entry) + '\n'); }
  catch { /* reporting failure must not hide the original failure */ }
  return info;
}
function recentErrors() {
  return readTail(file(), 16000).split(/\r?\n/).flatMap(line => {
    try { const x = JSON.parse(line); return [{ at: Number(x.at) || 0, code: /^[A-Z][A-Z0-9_]{0,63}$/.test(x.code) ? x.code : 'UNKNOWN_ERROR', operationId: /^[a-f0-9]{16}$/.test(x.operationId) ? x.operationId : '' }]; }
    catch { return []; }
  }).slice(-60);
}
module.exports = { recordError, recentErrors };
