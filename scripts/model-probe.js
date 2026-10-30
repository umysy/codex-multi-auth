#!/usr/bin/env node
'use strict';

/**
 * model-probe — 探测 Codex 请求「实际被哪个模型服务」。
 *
 * 它走的是 Codex 客户端同一条链路（config.toml 里的 provider → 本地 router 53742），
 * 把上游真正回给客户端的东西打印出来，用来区分：
 *   1. 上游回显的模型名（response.created / response.completed 的 model 字段）；
 *   2. 上游的限额与程序头（x-codex-plan-type、x-codex-active-limit、
 *      x-codex-safety-buffering-*、x-codex-*-used-percent）；
 *   3. 实际用量细节（reasoning_tokens、cache 命中、总 token）；
 *   4. 端到端延迟。
 *
 * 注意：ChatGPT 后端可以在不改模型名的前提下做服务端侧的质量/安全降级，
 * 那些只能在行为层面看，无法从这里直接证明。
 *
 * 用法：
 *   node scripts/model-probe.js
 *   node scripts/model-probe.js --model gpt-5.6-sol --effort high
 *   node scripts/model-probe.js --repeat 3 --json
 *   node scripts/model-probe.js --prompt "用一句话解释什么是快速排序"
 */

const fs = require('node:fs');
const path = require('node:path');

const HOME = process.env.USERPROFILE || require('node:os').homedir();
const CODEX_HOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const MULTI_AUTH = path.join(CODEX_HOME, 'multi-auth');
const BIND_FILE = path.join(MULTI_AUTH, 'app-bind', 'runtime-rotation-app-bind.json');
const CONFIG_TOML = path.join(CODEX_HOME, 'config.toml');

function parseArgs(argv) {
  const out = { model: null, effort: null, prompt: null, repeat: 1, json: false, timeoutMs: 180000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    if (arg === '--model') out.model = next();
    else if (arg === '--effort') out.effort = next();
    else if (arg === '--prompt') out.prompt = next();
    else if (arg === '--repeat') out.repeat = Math.max(1, Number(next()) || 1);
    else if (arg === '--timeout') out.timeoutMs = Math.max(1000, Number(next()) || out.timeoutMs);
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0]);
      process.exit(0);
    } else {
      console.error(`未知参数：${arg}`);
      process.exit(2);
    }
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function configValue(text, key) {
  const re = new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, 'm');
  const m = re.exec(text || '');
  return m ? m[1] : null;
}

function resolveTarget() {
  const bind = readJson(BIND_FILE);
  let configText = '';
  try {
    configText = fs.readFileSync(CONFIG_TOML, 'utf8');
  } catch {
    configText = '';
  }
  const port = bind && Number.isInteger(bind.port) ? bind.port : 53742;
  const base = (bind && typeof bind.baseUrl === 'string' && bind.baseUrl) || `http://127.0.0.1:${port}`;
  const apiKey = (bind && bind.clientApiKey) || configValue(configText, 'experimental_bearer_token');
  const configModel = configValue(configText, 'model');
  const provider = configValue(configText, 'model_provider');
  const effort = configValue(configText, 'model_reasoning_effort');
  return { base, apiKey, configModel, provider, effort, bindFile: BIND_FILE, configFile: CONFIG_TOML };
}

const HEADERS_OF_INTEREST = [
  'x-codex-plan-type',
  'x-codex-active-limit',
  'x-codex-safety-buffering-enabled',
  'x-codex-safety-buffering-faster-model',
  'x-codex-primary-used-percent',
  'x-codex-primary-window-minutes',
  'x-codex-secondary-used-percent',
  'x-codex-secondary-window-minutes',
  'x-codex-credits-has-credits',
  'x-models-etag',
  'x-oai-request-id',
];

function parseSse(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      events.push(JSON.parse(payload));
    } catch {
      /* 半行/心跳 */
    }
  }
  return events;
}

function pick(events) {
  const created = events.find((e) => e && e.type === 'response.created');
  const completed = events.find((e) => e && e.type === 'response.completed');
  const failed = events.find((e) => e && (e.type === 'response.failed' || e.type === 'error'));
  const boundary = events.filter((e) => e && e.type === 'response.reasoning_summary_part.added').length;
  const eventTypes = events.reduce((acc, event) => {
    const type = event && event.type ? event.type : 'unknown';
    acc[type] = (acc[type] || 0) + 1;
    return acc;
  }, {});
  const completedResponse = completed && completed.response ? completed.response : null;
  const createdResponse = created && created.response ? created.response : null;
  return {
    createdModel: createdResponse ? createdResponse.model : null,
    completedModel: completedResponse ? completedResponse.model : null,
    accessPrograms: (completedResponse || createdResponse || {}).access_programs || null,
    usage: (completedResponse || {}).usage || null,
    status: (completedResponse || {}).status || null,
    incomplete: (completedResponse || {}).incomplete_details || null,
    failure: failed ? (failed.response && failed.response.error) || failed.error || failed : null,
    reasoningEvents: boundary,
    eventTypes,
  };
}

async function probeOnce(target, options) {
  const model = options.model || target.configModel || 'gpt-6.1-sol';
  const body = {
    model,
    input: [
      {
        role: 'user',
        content: [{ type: 'input_text', text: options.prompt || '回答两个字：收到' }],
      },
    ],
    stream: true,
    store: false,
  };
  if (options.effort) body.reasoning = { effort: options.effort };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const startedAt = Date.now();
  let res;
  try {
    res = await fetch(`${target.base.replace(/\/$/, '')}/responses`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${target.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        'User-Agent': 'codex-multi-auth-model-probe',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    const elapsedMs = Date.now() - startedAt;
    const headers = {};
    for (const name of HEADERS_OF_INTEREST) {
      const value = res.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const parsed = parseSse(text);
    return {
      requestedModel: model,
      requestedEffort: options.effort || target.effort || null,
      httpStatus: res.status,
      elapsedMs,
      headers,
      ...pick(parsed),
      rawError: res.ok ? null : text.slice(0, 400),
    };
  } catch (error) {
    return {
      requestedModel: model,
      requestedEffort: options.effort || target.effort || null,
      httpStatus: null,
      elapsedMs: Date.now() - startedAt,
      error: error && error.name === 'AbortError' ? `timeout after ${options.timeoutMs}ms` : String(error && error.message ? error.message : error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function compactUsage(usage) {
  if (!usage) return null;
  const details = usage.output_tokens_details || {};
  const inputDetails = usage.input_tokens_details || {};
  return {
    input: usage.input_tokens ?? null,
    output: usage.output_tokens ?? null,
    reasoning: details.reasoning_tokens ?? null,
    cached: inputDetails.cached_tokens ?? null,
    total: usage.total_tokens ?? null,
  };
}

function verdict(result) {
  if (result.httpStatus !== 200) {
    return result.failure
      ? `失败：${JSON.stringify(result.failure).slice(0, 200)}`
      : `HTTP ${result.httpStatus}${result.rawError ? ` · ${result.rawError.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`;
  }
  if (result.failure) {
    const message = (result.failure && result.failure.message) || JSON.stringify(result.failure);
    const code = (result.failure && result.failure.code) || '';
    return `⚠ 上游失败${code ? ` (${code})` : ''}：${String(message).slice(0, 160)}`;
  }
  const served = result.completedModel || result.createdModel;
  if (served && served !== result.requestedModel) {
    return `⚠ 实际服务模型 ${served} ≠ 请求的 ${result.requestedModel}`;
  }
  return `服务模型 ${served || '(未回显)'} = 请求模型`;
}

function printHuman(target, results) {
  console.log(`链路：${target.base}/responses（provider=${target.provider || '?'}）`);
  console.log(`config.toml model=${target.configModel || '(未设置)'} effort=${target.effort || '(未设置)'}`);
  const headerKeys = [...new Set(results.flatMap((r) => Object.keys(r.headers || {})))];
  for (const [index, result] of results.entries()) {
    console.log('');
    console.log(`#${index + 1} 请求模型=${result.requestedModel}${result.requestedEffort ? ` effort=${result.requestedEffort}` : ''} → HTTP ${result.httpStatus} · ${result.elapsedMs}ms`);
    console.log(`    ${verdict(result)}`);
    console.log(`    usage: ${JSON.stringify(compactUsage(result.usage))}`);
    if (result.accessPrograms) console.log(`    access_programs: ${JSON.stringify(result.accessPrograms)}`);
    for (const key of headerKeys) {
      if (result.headers && result.headers[key] !== undefined) {
        console.log(`    ${key}: ${result.headers[key]}`);
      }
    }
    if (result.reasoningEvents) console.log(`    推理摘要事件数: ${result.reasoningEvents}`);
    if (!result.usage) console.log(`    事件类型: ${JSON.stringify(result.eventTypes || {})}`);
  }
  const servedSet = [...new Set(results.map((r) => r.completedModel || r.createdModel).filter(Boolean))];
  const failures = results.filter((r) => r.failure || r.httpStatus !== 200);
  const reasoning = results
    .map((r) => (r.usage && r.usage.output_tokens_details ? r.usage.output_tokens_details.reasoning_tokens : null))
    .filter((v) => v !== null && v !== undefined);
  console.log('');
  console.log(`小结：请求 ${results[0] ? results[0].requestedModel : '?'}，上游回显 ${servedSet.length ? servedSet.join(', ') : '(无)'}`);
  if (reasoning.length) {
    console.log(`    reasoning_tokens: ${reasoning.join(' / ')}（同一 prompt 突然变 0 或明显变小，才可能意味着推理强度被下调）`);
  }
  if (failures.length) {
    console.log(`    失败 ${failures.length}/${results.length} 次：上游过载/容量，属服务端状态，不是账号额度问题`);
  }
  const buffering = results.find((r) => r.headers && r.headers['x-codex-safety-buffering-enabled']);
  if (buffering) {
    console.log(`    safety buffering: enabled=${buffering.headers['x-codex-safety-buffering-enabled']}，降级模型=${buffering.headers['x-codex-safety-buffering-faster-model'] || '(无)'}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const target = resolveTarget();
  if (!target.apiKey) {
    console.error(`读不到 clientApiKey：${target.bindFile}`);
    process.exit(2);
  }
  const results = [];
  for (let i = 0; i < options.repeat; i += 1) {
    results.push(await probeOnce(target, options));
  }
  if (options.json) {
    console.log(JSON.stringify({ target: { base: target.base, provider: target.provider, configModel: target.configModel, effort: target.effort }, results }, null, 2));
  } else {
    printHuman(target, results);
  }
  const failed = results.some((r) => r.httpStatus !== 200);
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
