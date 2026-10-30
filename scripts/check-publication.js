'use strict';
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const tracked = cp.execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split(/\r?\n/).filter(Boolean);
const denyName = /(^|\/)(?:auth\.json|openai-codex-accounts[^/]*\.json|account-policies\.json|panel-config\.json|quota-cache\.json|quota-policy\.(?:log|state\.json)|panel-cache\.json|runtime-observability\.json|usage-ledger\.jsonl|panel-events\.log|panel-errors\.jsonl|.*\.sqlite|.*\.db|.*\.exe|.*\.dll|.*\.pdb)$/i;
// 反斜杠允许一或两个：JS / JSON 源码里的路径是转义过的（盘符:\\Users\\<name>），旧规则漏掉了这种写法。
// 占位用户名 <...>、%...%、me、example 不算真实路径。
const absoluteWindowsPath = /(?:[A-Z]:\\{1,2}(?:Users\\{1,2}(?!\\)(?!<|%|me\\|example\\)|DS Projects\\)|\\\\[^\\\s]+\\Users\\)/i;
const secretLike = /(?:sk-[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{24,}|"(?:access|refresh)_token"\s*:\s*"(?!<|example|test|dummy)[^"]{12,}")/i;
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
// 本机路由的 clientApiKey / identityToken 是 48–64 位随机十六进制（10-29 曾有真实 key 被写进测试夹具并公开）。
// 账号的 "sha256:<64 位>" 是公开的稳定指纹，不算；全是同一个字符的占位值也不算。
const hexKey = /(?<!sha256:)\b[0-9a-f]{40,}\b/gi;
function isPlaceholderHex(s) { return /^(.)\1+$/.test(s); }
const findings = [];
for (const rel of tracked) {
  if (denyName.test(rel)) findings.push(`${rel}: runtime/build artifact is tracked`);
  if (!fs.existsSync(rel)) continue;
  let stat; try { stat=fs.statSync(rel); } catch { continue; }
  if (!stat.isFile() || stat.size > 2_000_000 || /\.(exe|dll|pdb|png|jpg|ico|sqlite|db)$/i.test(rel)) continue;
  const text=fs.readFileSync(rel,'utf8');
  if (absoluteWindowsPath.test(text)) findings.push(`${rel}: absolute Windows path`);
  if (secretLike.test(text)) findings.push(`${rel}: secret-like credential`);
  for (const m of text.matchAll(hexKey)) {
    if (!isPlaceholderHex(m[0])) { findings.push(`${rel}: long random hex (looks like an API key or token)`); break; }
  }
  for (const m of text.matchAll(email)) {
    if (!/@(?:example\.com|example\.org|example\.net)$/i.test(m[0])) { findings.push(`${rel}: non-example email address`); break; }
  }
}
if (findings.length) { console.error('公开发布扫描失败：'); findings.forEach(x=>console.error(' - '+x)); process.exitCode=1; }
else console.log(`公开发布扫描通过：${tracked.length} 个 Git 文件，无运行态文件、绝对用户路径、凭据样式或非示例邮箱。`);
