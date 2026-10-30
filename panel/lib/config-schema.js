'use strict';
/**
 * config-schema.js — 仓库里 JSON 配置文件的共享形状描述与校验（唯一一处）。
 *
 * 背景：面板与脚本读写的配置不止一个文件，字段规则以前散落在三处：
 *   - panel-config.json：`policy-config.js` 管数值归一化（策略三项），但 `allowFailover` 没人管；
 *   - app-config.json：桌面端 `Infra.cs` 的 `AppConfig` 属性是唯一事实，示例文件靠手抄；
 *   - account-policies.json：由 codex-multi-auth 生成，面板只经 CLI 读，形状从未校验。
 *
 * 本模块把这些"形状"收成一处，供：
 *   - `scripts/check-config-examples.js` 校验仓库里的 `*.example.json`（防止示例与代码漂移）；
 *   - 单测直接断言字段规则；
 *   - 需要时给运行时读盘加一层校验（目前只有示例校验，运行时仍"脏数据回落默认值"）。
 *
 * 约定：纯函数、无 I/O、无依赖（除 policy-config 的归一化，避免第二份钳位规则）。
 */

const { normalizePolicy } = require('./policy-config');
const { validateRotation } = require('./rotation-policy');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isInteger(v, min, max) {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && (max === undefined || v <= max);
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * 校验"可选的布尔字段"：缺省可以，出现就必须是 boolean。
 */
function checkOptionalBool(errors, path, obj, key) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return;
  if (typeof obj[key] !== 'boolean') errors.push(`${path}.${key} 必须是 boolean，实际是 ${JSON.stringify(obj[key])}`);
}

/**
 * 校验"可选的整数区间字段"。
 */
function checkOptionalInt(errors, path, obj, key, min, max) {
  if (!Object.prototype.hasOwnProperty.call(obj, key)) return;
  if (!isInteger(obj[key], min, max)) {
    const range = max === undefined ? `>= ${min}` : `[${min}, ${max}]`;
    errors.push(`${path}.${key} 必须是 ${range} 的整数，实际是 ${JSON.stringify(obj[key])}`);
  }
}

// ---------------------------------------------------------------------------
// panel-config.json：策略面板配置（数值钳位规则权威仍在 policy-config.js）
// ---------------------------------------------------------------------------

/** 运行时归一化：返回可直接落盘/交给决策的 4 字段配置。 */
function normalizePanelConfig(raw) {
  const o = isPlainObject(raw) ? raw : {};
  return Object.assign(normalizePolicy(o), { allowFailover: o.allowFailover !== false });
}

function checkPanelConfig(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ['panel-config.json 顶层必须是对象'] };
  checkOptionalBool(errors, 'panel-config', value, 'autoSwitch');
  checkOptionalBool(errors, 'panel-config', value, 'allowFailover');
  checkOptionalInt(errors, 'panel-config', value, 'minWaitMin', 5, 600);
  checkOptionalInt(errors, 'panel-config', value, 'reserveIndex', 1);
  if (value.rotation !== undefined && value.rotation !== null) {
    try { validateRotation(value.rotation); } catch (error) { errors.push(error.message); }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// app-config.json：桌面端配置（字段权威 = panel/app/Infra.cs 的 AppConfig）
// ---------------------------------------------------------------------------

const DESKTOP_DEFAULTS = Object.freeze({
  NodeExe: 'node.exe',
  PanelDir: '%USERPROFILE%\\.codex\\multi-auth\\panel',
  Url: 'http://127.0.0.1:8766/',
  CliCmd: '%APPDATA%\\npm\\codex-multi-auth.cmd',
  Width: 1500,
  Height: 980,
  X: -1,
  Y: -1,
  Maximized: false,
});

function checkDesktopConfig(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ['app-config.json 顶层必须是对象'] };
  for (const key of ['NodeExe', 'PanelDir', 'Url', 'CliCmd']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (!isNonEmptyString(value[key])) errors.push(`app-config.${key} 必须是非空字符串，实际是 ${JSON.stringify(value[key])}`);
  }
  if (Object.prototype.hasOwnProperty.call(value, 'Url') && isNonEmptyString(value.Url) && !/^http:\/\/127\.0\.0\.1:\d+\/$/.test(value.Url)) {
    errors.push(`app-config.Url 必须是 http://127.0.0.1:<端口>/，实际是 ${JSON.stringify(value.Url)}`);
  }
  checkOptionalInt(errors, 'app-config', value, 'Width', 320);
  checkOptionalInt(errors, 'app-config', value, 'Height', 240);
  checkOptionalInt(errors, 'app-config', value, 'X', -1);
  checkOptionalInt(errors, 'app-config', value, 'Y', -1);
  checkOptionalBool(errors, 'app-config', value, 'Maximized');
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// account-policies.json：codex-multi-auth 的账号策略文件（面板只读经 CLI）
// ---------------------------------------------------------------------------

const POLICY_FLAGS = ['autoPrime', 'emergencyOnly', 'paused', 'drained'];

function checkAccountPolicies(value) {
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, errors: ['account-policies.json 顶层必须是对象'] };
  checkOptionalInt(errors, 'account-policies', value, 'version', 1);
  if (!Object.prototype.hasOwnProperty.call(value, 'accounts')) {
    errors.push('account-policies.accounts 缺失（应为 { "sha256:<key>": {...} }）');
    return { ok: false, errors };
  }
  if (!isPlainObject(value.accounts)) {
    errors.push('account-policies.accounts 必须是对象');
    return { ok: false, errors };
  }
  for (const [key, entry] of Object.entries(value.accounts)) {
    const at = `account-policies.accounts[${JSON.stringify(key)}]`;
    if (!isPlainObject(entry)) { errors.push(`${at} 必须是对象`); continue; }
    if (!isNonEmptyString(entry.accountKey)) errors.push(`${at}.accountKey 必须是非空字符串`);
    if (Object.prototype.hasOwnProperty.call(entry, 'tags')) {
      if (!Array.isArray(entry.tags) || entry.tags.some((t) => typeof t !== 'string')) errors.push(`${at}.tags 必须是字符串数组`);
    }
    checkOptionalInt(errors, at, entry, 'weight', 0);
    checkOptionalInt(errors, at, entry, 'priority', 0);
    checkOptionalInt(errors, at, entry, 'updatedAt', 0);
    if (Object.prototype.hasOwnProperty.call(entry, 'note') && typeof entry.note !== 'string') errors.push(`${at}.note 必须是字符串`);
    for (const flag of POLICY_FLAGS) checkOptionalBool(errors, at, entry, flag);
  }
  return { ok: errors.length === 0, errors };
}

const SCHEMAS = Object.freeze({
  panelConfig: { name: 'panel-config.json', check: checkPanelConfig, normalize: normalizePanelConfig },
  desktopConfig: { name: 'app-config.json', check: checkDesktopConfig, defaults: DESKTOP_DEFAULTS },
  accountPolicies: { name: 'account-policies.json', check: checkAccountPolicies },
});

/**
 * 按 schema 名校验任意对象。
 * @param {'panelConfig'|'desktopConfig'|'accountPolicies'} schemaName
 * @param {*} value
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateConfig(schemaName, value) {
  const schema = SCHEMAS[schemaName];
  if (!schema) return { ok: false, errors: [`未知 schema：${schemaName}`] };
  return schema.check(value);
}

module.exports = {
  SCHEMAS,
  DESKTOP_DEFAULTS,
  POLICY_FLAGS,
  validateConfig,
  normalizePanelConfig,
  checkPanelConfig,
  checkDesktopConfig,
  checkAccountPolicies,
  isPlainObject,
};
