#!/usr/bin/env node
'use strict';

/**
 * policy-cli.js — 策略决策的唯一命令行入口（quota-policy.ps1 ← this ← policy-core.decide）。
 *
 * 背景：以前 quota-policy.ps1 里有一份 120 行的分支决策，panel/policy-core.js 里又有
 * 一份等价实现，规则改动必须两处同步、两套测试，改漏一处就会"面板显示的规则"和
 * "实际执行的规则"悄悄分叉。现在 PS1 只负责取数 / 执行 / 落盘，判断全部走这里。
 *
 * 用法（PS1 用 --in/--out 文件模式，避开控制台编码问题）：
 *   node panel/policy-cli.js decide --in in.json --out out.json
 *   node panel/policy-cli.js decide            < in.json   > out.json
 *   node panel/policy-cli.js normalize-config  < cfg.json  > normalized.json
 *   node panel/policy-cli.js --help
 *
 * 输出：{ "ok": true, "decision": {...} } / { "ok": true, "policy": {...} }
 * 退出码：0 成功；2 输入/运行错误（错误也是 JSON，调用方可直接展示）。
 */

const fs = require('fs');
const path = require('path');
const { decideWithPolicy } = require('./lib/policy-decision');
const { normalizePolicy } = require('./lib/policy-config');
const { planExhaustionPauses } = require('./policy-core');
const { planRotation } = require('./lib/rotation-policy');

const USAGE = [
  'policy-cli.js — Codex 多账号额度策略决策入口',
  '',
  '  decide --in <file> --out <file>   读输入 JSON，写决策 JSON（PS1 用这个）',
  '  decide                             stdin → stdout',
  '  normalize-config [--in/--out]     归一化 panel-config.json 字段（钳位/默认值）',
  '  plan-pauses [--in/--out]          额度耗尽账号的暂停/恢复计划（quota-policy.ps1 用）',
  '',
].join('\n');

/** 解析 --in/--out；返回 {in, out}（缺省为 null = stdin/stdout） */
function parseArgs(argv) {
  const opts = { in: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') opts.in = argv[++i];
    else if (a === '--out') opts.out = argv[++i];
  }
  return opts;
}

function readInput(opts) {
  if (opts.in) return fs.readFileSync(path.resolve(opts.in), 'utf8');
  return fs.readFileSync(0, 'utf8');
}

function writeOutput(opts, obj) {
  const text = JSON.stringify(obj) + '\n';
  if (opts.out) {
    fs.writeFileSync(path.resolve(opts.out), text, 'utf8');
  } else {
    process.stdout.write(text);
  }
}

function main(argv) {
  const command = argv[0];
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (command !== 'decide' && command !== 'normalize-config' && command !== 'plan-pauses') {
    process.stdout.write(USAGE);
    return 2;
  }

  const opts = parseArgs(argv.slice(1));
  let parsed;
  try {
    const raw = readInput(opts);
    parsed = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch (e) {
    writeOutput(opts, { ok: false, error: '读取/解析输入失败: ' + (e && e.message ? e.message : e) });
    return 2;
  }

  try {
    if (command === 'decide') {
      writeOutput(opts, { ok: true, decision: decideWithPolicy(parsed) });
    } else if (command === 'plan-pauses') {
      // Custom rotation owns only switch-time pauses; legacy reconciliation must not mutate its pool.
      const plan = parsed.rotation ? planRotation(parsed) : parsed.autoSwitch === false
        ? { pause: [], resume: [], nextExhaustedPaused: parsed.exhaustedPaused || [] }
        : planExhaustionPauses(parsed);
      writeOutput(opts, { ok: true, plan });
    } else {
      writeOutput(opts, { ok: true, policy: normalizePolicy(parsed) });
    }
    return 0;
  } catch (e) {
    writeOutput(opts, { ok: false, error: '决策失败: ' + (e && e.message ? e.message : e) });
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
