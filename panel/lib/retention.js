'use strict';

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_CACHE_BYTES = 8 * 1024 * 1024;

function trimFile(file, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  try {
    const st = fs.statSync(file);
    if (st.size <= maxBytes) return false;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(maxBytes);
    fs.readSync(fd, buf, 0, maxBytes, st.size - maxBytes);
    fs.closeSync(fd);
    const tmp = file + '.retention.tmp';
    const newline = buf.indexOf(10);
    fs.writeFileSync(tmp, newline >= 0 ? buf.subarray(newline + 1) : Buffer.alloc(0));
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

function removeStaleTempFiles() {
  try {
    for (const name of fs.readdirSync(paths.DATA)) {
      if (!/^(panel-cache\.json|panel-events\.log|quota-policy\.state\.json)\.(tmp(-\d+-\d+)?|retention\.tmp)$/.test(name)) continue;
      const file = path.join(paths.DATA, name);
      const age = Date.now() - fs.statSync(file).mtimeMs;
      if (age > 60 * 60 * 1000) fs.unlinkSync(file);
    }
  } catch { /* best effort maintenance */ }
}

function cleanupRuntimeFiles(options = {}) {
  const maxLogBytes = options.maxLogBytes || DEFAULT_MAX_LOG_BYTES;
  trimFile(paths.EVENTS_LOG, maxLogBytes);
  trimFile(paths.ROUTER_LAUNCH_LOG, maxLogBytes);
  // The external router owns its own bounded log. JSON files must never be tail-truncated.
  removeStaleTempFiles();
}

module.exports = { DEFAULT_MAX_LOG_BYTES, DEFAULT_MAX_CACHE_BYTES, trimFile, cleanupRuntimeFiles };
