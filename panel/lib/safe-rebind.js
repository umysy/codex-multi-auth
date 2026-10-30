'use strict';
/**
 * 面板「重新绑定桌面版」：把 Codex config.toml 里指向本机路由的几行改回 app-bind 的值。
 *
 * 事故复盘（10-29）：按钮原来直接跑 `codex-multi-auth rotation bind-app --native`，它会
 *   - 把 `[model_providers.codex-multi-auth-runtime-proxy]` 整段删掉，顶层换成
 *     `model_provider = "openai"` 的原生模式块（本机用的是带 token 的自定义 provider）；
 *   - 用 CLI 自带模板重写启动项 cmd，丢掉代理和超时环境变量（路由下次重启就连不上上游）；
 *   - 自己停/起路由，而不是走 keeper；中途崩溃时配置停在半改状态。
 *
 * 这里只认 app-bind 状态这个唯一可信来源，只改四行的值，其余一个字节都不碰：
 *   顶层 model_provider、顶层 openai_base_url、provider 段的 base_url 与 experimental_bearer_token。
 * 缺任何一行、有 CLI 原生模式块、或改动会超出这四行 → 拒绝并给出中文说明，绝不插入或猜测。
 * 不写 app-bind、不写启动项、不起停路由、不生成新 key。
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { readJson } = require('./fs-json');
const { appendPolicyLine } = require('./events');
const { PROVIDER, isListening, backupConfig } = require('./binding-guard');

const NATIVE_BLOCK = '# codex-multi-auth native provider begin';
const VALUE_LINE = /^(\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*)("(?:[^"\\]|\\.)*"|'[^']*')(.*)$/;
const TABLE_LINE = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/;

function refuse(code, message) { return { ok: false, code, message }; }

/** 纯函数：app-bind 状态 → 期望的本机路由地址；字段不合格返回 null。 */
function expectedTarget(bind) {
  const port = Number(bind && bind.port);
  const key = bind && bind.clientApiKey;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof key !== 'string' || !/^[0-9a-f]{32,}$/i.test(key)) return null;
  return { port, baseUrl: 'http://127.0.0.1:' + port, key };
}

/**
 * 纯函数：算出重新绑定后的 config 文本。
 * 返回 { ok:true, changed, next, fields } 或 { ok:false, code, message }。
 * fields 只含字段名，从不含值。
 */
function planRebind(configText, bind) {
  const target = expectedTarget(bind);
  if (!target) return refuse('REBIND_NO_BIND', '路由绑定状态不完整（端口或密钥缺失），无法确定该绑到哪里。请先在「路由」页确认路由正常运行。');
  const text = String(configText || '');
  if (text.indexOf(NATIVE_BLOCK) >= 0) {
    return refuse('REBIND_NATIVE_BLOCK', 'Codex 配置处在 CLI 的原生模式（旧的 bind-app --native 写的）。自动修复可能覆盖你的设置，请从 config.toml.bak-* 或 versions 目录里的备份手动恢复。');
  }
  const eol = text.indexOf('\r\n') >= 0 ? '\r\n' : '\n';
  const lines = text.split(eol);
  const wanted = {
    'root.model_provider': '"' + PROVIDER + '"',
    'root.openai_base_url': '"' + target.baseUrl + '"',
    'provider.base_url': '"' + target.baseUrl + '"',
    'provider.experimental_bearer_token': '"' + target.key + '"',
  };
  const optional = new Set(['root.openai_base_url']);
  const found = {};
  const next = lines.slice();
  let table = 'root';
  let providerSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const header = TABLE_LINE.exec(lines[i]);
    if (header) {
      table = header[1] === 'model_providers.' + PROVIDER ? 'provider' : 'other';
      if (table === 'provider') {
        if (providerSeen) return refuse('REBIND_DUPLICATE', 'Codex 配置里有两个本机路由 provider 段，需要手动整理后再重新绑定。');
        providerSeen = true;
      }
      continue;
    }
    if (table === 'other') continue;
    const m = VALUE_LINE.exec(lines[i]);
    if (!m) continue;
    const slot = table + '.' + m[2];
    if (!Object.prototype.hasOwnProperty.call(wanted, slot)) continue;
    if (found[slot] !== undefined) return refuse('REBIND_DUPLICATE', 'Codex 配置里 ' + m[2] + ' 出现了两次，需要手动整理后再重新绑定。');
    found[slot] = i;
    next[i] = m[1] + wanted[slot] + m[4];
  }
  if (!providerSeen) {
    return refuse('REBIND_NO_PROVIDER', 'Codex 配置里没有本机路由的 provider 段（[model_providers.' + PROVIDER + ']），说明配置被别的工具整段改掉了。自动补写可能覆盖你的设置，请从 config.toml.bak-* 或 versions 目录里的备份手动恢复。');
  }
  const missing = Object.keys(wanted).filter((s) => found[s] === undefined && !optional.has(s));
  if (missing.length) {
    return refuse('REBIND_MISSING_LINE', 'Codex 配置缺少 ' + missing.map((s) => s.split('.')[1]).join('、') + '，不能只改值完成绑定。请从备份手动恢复。');
  }
  const changedIdx = [];
  for (let i = 0; i < lines.length; i++) if (lines[i] !== next[i]) changedIdx.push(i);
  const managedIdx = new Set(Object.values(found));
  if (changedIdx.some((i) => !managedIdx.has(i))) return refuse('REBIND_SCOPE', '内部检查失败：改动超出了路由相关的几行，已放弃。');
  const fields = Object.keys(found).filter((s) => lines[found[s]] !== next[found[s]]).map((s) => s.split('.')[1]);
  return { ok: true, changed: changedIdx.length > 0, next: next.join(eol), fields, port: target.port };
}

function atomicWrite(file, text) {
  const tmp = file + '.rebind-tmp';
  fs.writeFileSync(tmp, text, 'utf8');
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) { /* ignore */ } throw e; }
}

/**
 * 执行重新绑定。只写 config.toml（先备份）；返回 { ok, changed, code?, message }。
 * deps 供测试注入 bindPath / configPath / listening / log。
 */
async function safeRebind(deps) {
  const d = deps || {};
  const bindFile = d.bindPath || path.join(paths.APP_BIND, 'runtime-rotation-app-bind.json');
  const cfgFile = d.configPath || path.join(paths.CODEX_HOME, 'config.toml');
  const bind = readJson(bindFile, null);
  let text;
  try { text = fs.readFileSync(cfgFile, 'utf8'); } catch (e) { return refuse('REBIND_NO_CONFIG', '找不到 Codex 配置文件：' + cfgFile); }
  const plan = planRebind(text, bind);
  if (!plan.ok) return plan;
  if (!plan.changed) return { ok: true, changed: false, message: 'Codex 配置已经指向本机路由（端口 ' + plan.port + '），无需重新绑定。' };
  const listening = d.listening === undefined ? await isListening(plan.port) : Boolean(d.listening);
  if (!listening) return refuse('REBIND_ROUTER_DOWN', '本机路由（端口 ' + plan.port + '）没有在运行。请先点「重启路由」，确认路由正常后再重新绑定。');
  const backup = backupConfig(cfgFile);
  if (!backup) return refuse('REBIND_BACKUP_FAILED', '备份 Codex 配置失败，未做任何修改。');
  // 读与写之间 Codex 可能自己改过配置：内容变了就放弃，不覆盖。
  if (fs.readFileSync(cfgFile, 'utf8') !== text) return refuse('REBIND_RACED', 'Codex 配置在检查期间被改动，未做任何修改。请稍后重试。');
  try { atomicWrite(cfgFile, plan.next); } catch (e) { return refuse('REBIND_WRITE_FAILED', '写入 Codex 配置失败，原文件未改动（备份：' + path.basename(backup) + '）。'); }
  const after = planRebind(fs.readFileSync(cfgFile, 'utf8'), bind);
  if (!after.ok || after.changed) return refuse('REBIND_VERIFY_FAILED', '写入后复查不一致，请用备份 ' + path.basename(backup) + ' 手动恢复。');
  const log = d.log || ((msg) => appendPolicyLine('REBIND', msg));
  try { log('重新绑定：Codex 配置改回本机路由端口 ' + plan.port + '（' + plan.fields.join('、') + '）'); } catch (e) { /* ignore */ }
  return {
    ok: true,
    changed: true,
    fields: plan.fields,
    message: '已把 Codex 配置改回本机路由（端口 ' + plan.port + '），只改了：' + plan.fields.join('、') +
      '。账号、策略、启动项和密钥都没动；备份：' + path.basename(backup) + '。请完全退出并重新打开 Codex 桌面版后生效。',
  };
}

module.exports = { planRebind, safeRebind, expectedTarget };
