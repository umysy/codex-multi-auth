'use strict';
/**
 * 日志与用量读取：策略日志、面板事件、路由器日志、ensure-router 告警。
 * 只读文件，不写任何东西。
 */
const path = require('path');
const { execFileSync } = require('child_process');
const paths = require('./paths');
const { readTail } = require('./fs-json');
const usageLib = require('../usage.js');
const { redact } = require('./errors');

function getUsage(rangeDays, force) {
  return usageLib.get(rangeDays, force, { execFileSync, nodeExe: paths.NODE_EXE, cli: paths.CLI });
}

function readLogs(limit = 60) {
  const entries = [];
  const policyText = readTail(paths.POLICY_LOG);
  for (const raw of policyText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.*)$/);
    if (m) {
      const kind = (m[2].match(/^[A-Z_]+/) || ['INFO'])[0];
      entries.push({ at: m[1], msg: redact(m[2]), kind, src: 'policy' });
    }
  }
  const eventsText = readTail(paths.EVENTS_LOG, 8000);
  for (const raw of eventsText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.*)$/);
    if (m) entries.push({ at: m[1], msg: redact(m[2]), kind: (m[2].match(/^[A-Z_]+/) || ['INFO'])[0], src: 'panel' });
  }
  const routerText = readTail(paths.ROUTER_LOG, 8000);
  for (const raw of routerText.split(/\r?\n/)) {
    const line = raw.replace(/\u0000/g, '').trim();
    if (!line || line.length > 400) continue;
    const m = line.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})/);
    if (m) entries.push({ at: m[1] + ' ' + m[2], msg: redact(line), kind: 'ROUTER', src: 'router' });
  }
  entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return entries.slice(0, limit);
}

function readServiceAlerts() {
  const alerts = [];
  const ensure = readTail(path.join(paths.DATA, 'ensure-router.log'), 4000).split(/\r?\n/).filter(Boolean).pop();
  if (ensure) alerts.push(ensure.trim());
  return alerts;
}

module.exports = { getUsage, readLogs, readServiceAlerts };
