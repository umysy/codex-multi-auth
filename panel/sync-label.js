'use strict';
/**
 * 让 Codex 侧栏显示的 provider 名跟随当前账号（逻辑在 lib/binding-guard.js 的 ensureProviderLabel）。
 *
 * 面板开着时由看门狗即时同步；这个入口给 quota-policy.ps1 每轮结束时调用，
 * 面板没开、由计划任务切号时也能跟上。名字没变就不写盘。
 */
const { ensureProviderLabel } = require('./lib/binding-guard');

process.stdout.write(JSON.stringify(ensureProviderLabel()) + '\n');
