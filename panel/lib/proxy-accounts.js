'use strict';
/**
 * 代理账号库（openai-codex-accounts.json）的只读视图。
 *
 * 之前只有 CLI 能读它；面板需要两件信息：
 *   1. 当前代理在用哪个账号（activeIndex）；
 *   2. 某个账号的 token（用来同步 Codex 应用的登录态）。
 * 所以单独收一个小模块，避免把“读文件 + 解码 JWT”散到 routes / dashboard 里。
 *
 * 注意：accessToken / refreshToken 属于敏感数据，只在进程内使用，
 * **不要把整个 accounts 数组丢进 /api/state 的响应里**。
 */
const fs = require('fs');
const path = require('path');
const paths = require('./paths');
const { readAppLogin } = require('./app-auth');

function accountsFile() {
  return path.join(paths.DATA, 'openai-codex-accounts.json');
}

function readProxyAccounts(file = accountsFile()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    return { ok: false, file, accounts: [], activeIndex: 0, error: err.message };
  }
  const list = Array.isArray(raw && raw.accounts) ? raw.accounts : [];
  const accounts = list.map((a, index) => ({
    index,
    email: (a && a.email) || '',
    accountId: (a && a.accountId) || null,
    accessToken: (a && a.accessToken) || '',
    refreshToken: (a && a.refreshToken) || '',
    expiresAt: (a && a.expiresAt) || null,
  }));
  const active = Number(raw && raw.activeIndex);
  return {
    ok: true,
    file,
    accounts,
    activeIndex: Number.isFinite(active) && active >= 0 && active < accounts.length ? active : 0,
  };
}

/** 按 email 或 1 基序号找账号；都不给时取当前代理账号。 */
function findAccount(info, { email = '', n = 0 } = {}) {
  if (!info || !info.ok || !Array.isArray(info.accounts) || info.accounts.length === 0) return null;
  const wanted = String(email || '').trim().toLowerCase();
  if (wanted) return info.accounts.find((a) => String(a.email || '').toLowerCase() === wanted) || null;
  const idx = Number(n) > 0 ? Number(n) - 1 : info.activeIndex;
  return info.accounts[idx] || null;
}

/** 给 /api/state 用的摘要：当前代理账号 vs 应用登录账号，以及是否一致。 */
function describeAppLogin(opts = {}) {
  const login = readAppLogin(opts.authPath);
  const info = readProxyAccounts(opts.file);
  const current = findAccount(info, {});
  const loggedIn = login.email ? login.email.toLowerCase() : null;
  const currentEmail = current ? String(current.email || '').toLowerCase() : null;
  const matchesCurrent = !!(loggedIn && currentEmail && loggedIn === currentEmail);
  return {
    loggedInEmail: login.email || null,
    loggedInPlan: login.plan || null,
    currentEmail: current ? current.email || null : null,
    matchesCurrent,
    accountsKnown: !!info.ok,
    hint: matchesCurrent || !login.email
      ? ''
      : '应用登录（' + login.email + '）与代理当前账号不一致：Codex 界面的额度和“额度用完”横幅读的是应用登录账号',
  };
}

module.exports = { accountsFile, readProxyAccounts, findAccount, describeAppLogin };
