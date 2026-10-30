'use strict';
/**
 * 用量模块的路径默认值。
 *
 * 只做“算默认路径”，不做 I/O；测试可以通过 deps.sessionsRoot / deps.stateDb 覆盖。
 * 真正的部署位置仍由 lib/paths.js 决定（CODEX_HOME 只有一个来源）。
 */
const path = require('path');
const { CODEX_HOME, DATA } = require('../paths');

const SESSIONS_ROOT = path.join(CODEX_HOME, 'sessions');
const STATE_DB = path.join(CODEX_HOME, 'state_5.sqlite');
const LEDGER_DIR = path.join(DATA, 'usage'); // 路由账本（每个请求实际用的账号）
const TTL = 180000; // 3 分钟；面板侧另有 60s 的读模型 TTL

module.exports = { CODEX_HOME, SESSIONS_ROOT, STATE_DB, LEDGER_DIR, TTL };
