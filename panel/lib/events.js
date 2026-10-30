'use strict';
/**
 * 面板自己写的事件日志（与策略脚本的心跳日志分开，避免两个写入者并发丢行）。
 */
const fs = require('fs');
const paths = require('./paths');
const { redact } = require('./errors');

function appendPolicyLine(kind, msg) {
  for (let i = 0; i < 3; i++) {
    try {
      const ts = new Date().toLocaleString('sv-SE').replace('T', ' ');
      fs.appendFileSync(paths.EVENTS_LOG, `${ts}  ${String(kind).replace(/[^A-Z_]/g, '')}  ${redact(msg)}\n`, 'utf8');
      return;
    } catch (e) { /* retry */ }
  }
}

module.exports = { appendPolicyLine };
