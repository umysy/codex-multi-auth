'use strict';
/**
 * check-config-examples.js — 闸门：仓库里的配置文件示例必须符合 lib/config-schema.js 的形状。
 *
 * 为什么需要：README 让用户把 `*.example.json` 复制成真实配置；示例一旦和代码脱节
 * （改名、改类型、漏字段），用户复制出来的就是坏配置，而且要在运行时才炸。
 *
 * 校验对象：
 *   panel-config.example.json            → panelConfig
 *   panel/desktop/app-config.example.json → desktopConfig（并要求覆盖 AppConfig 的全部字段）
 *   account-policies.example.json        → accountPolicies
 */
const fs = require('fs');
const path = require('path');
const { validateConfig, DESKTOP_DEFAULTS } = require('../panel/lib/config-schema');

const repoRoot = path.resolve(__dirname, '..');

/** 读取 JSON（容忍 UTF-8 BOM）。 */
function readJson(rel) {
  const file = path.join(repoRoot, rel);
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { file, value: JSON.parse(text) };
}

const CASES = [
  { rel: 'panel-config.example.json', schema: 'panelConfig' },
  { rel: 'panel/desktop/app-config.example.json', schema: 'desktopConfig' },
  { rel: 'account-policies.example.json', schema: 'accountPolicies' },
];

const problems = [];
for (const c of CASES) {
  let parsed;
  try {
    parsed = readJson(c.rel);
  } catch (err) {
    problems.push(`${c.rel}: 读取/解析失败 — ${err.message}`);
    continue;
  }
  const result = validateConfig(c.schema, parsed.value);
  if (!result.ok) {
    for (const e of result.errors) problems.push(`${c.rel}: ${e}`);
  }
}

// app-config 示例必须覆盖桌面端 AppConfig 的全部字段，否则示例复制出去会少字段。
try {
  const desktop = readJson('panel/desktop/app-config.example.json').value;
  for (const key of Object.keys(DESKTOP_DEFAULTS)) {
    if (!Object.prototype.hasOwnProperty.call(desktop, key)) {
      problems.push(`panel/desktop/app-config.example.json: 缺字段 ${key}（应与 Infra.cs 的 AppConfig 对齐）`);
    }
  }
} catch {
  // 上面已记录解析失败
}

if (problems.length === 0) {
  console.log(`配置示例检查：${CASES.length} 个文件，0 个问题`);
  process.exitCode = 0;
} else {
  console.error(`配置示例检查：${CASES.length} 个文件，${problems.length} 个问题`);
  for (const p of problems) console.error('  - ' + p);
  process.exitCode = 1;
}
