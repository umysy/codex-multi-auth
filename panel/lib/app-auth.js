'use strict';
/**
 * Codex 应用自己的登录态（~/.codex/auth.json）。
 *
 * 为什么需要这个模块：
 *   - 代理（openai-codex-accounts.json）决定“请求最终发给谁”；
 *   - 应用登录决定“Codex 界面显示谁、界面上的额度横幅读谁的限额”。
 *   两者本来是独立的：面板切账号不会改应用登录，于是会出现
 *   “代理已经在用有额度的号，应用却还在喊额度用完”。
 *
 * 这里只做三件事：解码 token 身份、读当前登录、把某个代理账号写成应用登录。
 * 纯函数（decodeIdentity / buildAuthPayload）与文件操作（readAppLogin / writeAppLogin）分开，
 * 便于单测不碰真实 ~/.codex。
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { protect } = require('./protected-data');
const { writeJson } = require('./fs-json');

/** 解出 JWT payload 里的身份信息；不校验签名（只用来看“这是谁”，不用于鉴权）。 */
function decodeIdentity(token) {
  if (typeof token !== 'string' || token.length < 20) return null;
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    const auth = payload['https://api.openai.com/auth'] || {};
    const profile = payload['https://api.openai.com/profile'] || {};
    return {
      email: (profile.email || payload.email || '').toLowerCase() || null,
      accountId: auth.chatgpt_account_id || payload.sub || null,
      plan: auth.chatgpt_plan_type || null,
      expiresAt: typeof payload.exp === 'number' ? payload.exp * 1000 : null,
    };
  } catch {
    return null;
  }
}

/** 读应用当前登录：{ present, email, accountId, plan, loginAt }；文件不存在/损坏不抛错。 */
function readAppLogin(authPath = paths.CODEX_AUTH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  } catch {
    return { present: false, path: authPath, email: null, accountId: null, plan: null, loginAt: null, mtimeMs: null };
  }
  const tokens = (raw && raw.tokens) || {};
  const access = tokens.access_token || tokens.accessToken || '';
  const id = decodeIdentity(access);
  let mtimeMs = null;
  try { mtimeMs = fs.statSync(authPath).mtimeMs; } catch { /* ignore */ }
  return {
    present: true,
    path: authPath,
    email: id ? id.email : null,
    accountId: tokens.account_id || tokens.accountId || (id ? id.accountId : null) || null,
    plan: id ? id.plan : null,
    loginAt: raw.last_refresh || null,
    mtimeMs,
  };
}

/**
 * 生成 auth.json 内容。
 * id_token 用 access_token 兜底 —— codex-multi-auth 自己也是这样写的
 * （dist/lib/runtime/native-rate-limits.js），应用能接受。
 */
function buildAuthPayload(account, now = new Date()) {
  if (!account || !account.accessToken) throw new Error('缺少 accessToken，无法写入应用登录');
  return {
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: {
      id_token: account.accessToken,
      access_token: account.accessToken,
      refresh_token: account.refreshToken || '',
      account_id: account.accountId || null,
    },
    last_refresh: now.toISOString(),
  };
}

/**
 * 把某个代理账号写成 Codex 应用的登录态（先备份、再原子替换）。
 * 返回 { ok, email, backup, path }；备份文件是 `auth.json.bak-<时间戳>`。
 */
function writeAppLogin(account, opts = {}) {
  const authPath = opts.authPath || paths.CODEX_AUTH;
  const now = opts.now || new Date();
  const payload = buildAuthPayload(account, now);
  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  let backup = null;
  if (fs.existsSync(authPath)) {
    const stamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    backup = authPath + '.protected-' + stamp + '-' + require('crypto').randomBytes(4).toString('hex');
    writeJson(backup, protect(fs.readFileSync(authPath, 'utf8')));
  }
  const tmp = authPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tmp, authPath);
  const prefix = path.basename(authPath) + '.protected-';
  const backups = fs.readdirSync(path.dirname(authPath)).filter(n => n.startsWith(prefix) && /^\d{14}-[a-f0-9]{8}$/.test(n.slice(prefix.length))).sort().reverse();
  for (const name of backups.slice(5)) fs.unlinkSync(path.join(path.dirname(authPath), name));
  return { ok: true, email: account.email || null, backup, path: authPath };
}

module.exports = { decodeIdentity, readAppLogin, buildAuthPayload, writeAppLogin };
