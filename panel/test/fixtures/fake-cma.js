'use strict';
// 测试专用假 codex-multi-auth CLI。
// 按 CMA_SCENARIO 指向的场景 JSON 回答查询命令，把每次调用追加到 CMA_CALLS，
// switch 时把"当前账号"写进 CMA_ACTIVE（0 基），让 Try-Switch 的校验能读到切换结果。
//
// 场景 JSON 字段：
//   activeIndex     当前账号（0 基）
//   accountCount    账号总数
//   pinnedAccountIndex  status --json 里的固定账号（null 表示未固定）
//   quota[]         每个账号的 quota（primary/secondary + usedPercent/windowMinutes/resetInMin）
//   policy[]        account policy list 的 paused / emergencyOnly
//   ignoreSwitch    true 时 switch 命令只回 ok、不更新 CMA_ACTIVE（用于模拟切换失败）
const fs = require('fs');

const scenarioPath = process.env.CMA_SCENARIO;
if (!scenarioPath) {
  process.stderr.write('CMA_SCENARIO missing\n');
  process.exit(2);
}
const sc = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const argv = process.argv.slice(2);
const cmd = argv[0];
const now = Date.now();
if (sc.failCommand && argv.join(' ') === sc.failCommand) { record(); console.error('synthetic failure'); process.exit(1); }
const activeFile = process.env.CMA_ACTIVE || '';
const pinFile = process.env.CMA_PIN || '';
// noise: true 时在 JSON 前多打一行警告（模拟真实 CLI 的提示/警告污染 stdout）
function noise() {
  if (sc.noise) console.log('[warn] config cache stale; refreshing in background');
}

function convWindow(w) {
  if (!w) return null;
  return {
    usedPercent: w.usedPercent,
    windowMinutes: w.windowMinutes,
    resetAtMs: now + Math.round((w.resetInMin || 0) * 60000),
  };
}
function convQuota(q) {
  return {
    planType: q.planType || 'plus',
    primary: convWindow(q.primary),
    secondary: convWindow(q.secondary),
  };
}
function activeIndex() {
  if (activeFile && fs.existsSync(activeFile)) {
    const v = Number(fs.readFileSync(activeFile, 'utf8').trim());
    if (Number.isFinite(v)) return v;
  }
  return Number(sc.activeIndex) || 0;
}
function resolvePin() {
  if (pinFile && fs.existsSync(pinFile)) {
    const raw = fs.readFileSync(pinFile, 'utf8').trim();
    if (raw === '') return null;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return sc.pinnedAccountIndex === undefined ? null : sc.pinnedAccountIndex;
}
function record() {
  if (!process.env.CMA_CALLS) return;
  try {
    fs.appendFileSync(process.env.CMA_CALLS, argv.join(' ') + '\n');
  } catch (e) {
    // 记录失败不影响被测脚本
  }
}

if (cmd === 'status' && argv.includes('--json')) {
  noise();
  console.log(JSON.stringify({
    activeIndex: activeIndex(),
    accountCount: Number(sc.accountCount) || (sc.quota || []).length,
    pinnedAccountIndex: resolvePin(),
  }));
} else if (cmd === 'limits') {
  // forbidRefresh：策略不允许自己做深度探测（limits --refresh 会给每个账号发真实请求）
  if (sc.forbidRefresh && argv.includes('--refresh')) { console.error('limits --refresh is not allowed'); process.exit(1); }
  const omit = Array.isArray(sc.omitQuotaFor) ? sc.omitQuotaFor : [];
  const accounts = (sc.quota || [])
    .map((q, i) => ({ index: i, quota: convQuota(q) }))
    .filter((a) => !omit.includes(a.index));
  noise();
  console.log(JSON.stringify({ accounts }));
} else if (cmd === 'account' && argv[1] === 'policy' && argv[2] === 'list') {
  const policy = Array.isArray(sc.policy) ? sc.policy : [];
  const accounts = policy.map((p, i) => {
    const row = { index: i + 1, paused: !!p.paused, emergencyOnly: !!p.emergencyOnly };
    row.accountKey = p.accountKey;
    row.drained = !!p.drained;
    row.priority = p.priority ?? 1;
    row.weight = p.weight ?? 1;
    // 真实 CLI 的 policy list 带中文 note；用于复现“控制台编码 936 时 UTF-8 被解成乱码”的回归
    if (p.note) row.note = String(p.note);
    return row;
  });
  noise();
  console.log(JSON.stringify({ accounts }));
} else if (cmd === 'unpin') {
  record();
  if (pinFile) fs.writeFileSync(pinFile, '', 'utf8');
  console.log('ok');
} else if (cmd === 'switch') {
  record();
  const n = Number(argv[1]);
  if (!sc.ignoreSwitch && activeFile && Number.isFinite(n)) {
    fs.writeFileSync(activeFile, String(n - 1), 'utf8');
    // 真实 CLI 的 switch 会把目标账号写进 pinnedAccountIndex（钉住）
    if (pinFile) fs.writeFileSync(pinFile, String(n - 1), 'utf8');
  }
  console.log('ok');
} else {
  record();
  console.log('ok');
}
