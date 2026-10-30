'use strict';
/**
 * Codex 应用登录（auth.json）与代理账号对照的单元测试。
 *
 * 背景：面板「切换账号」只改代理路由，不改应用登录；应用界面的额度横幅读的是
 * 应用登录账号。这个测试锁住两件事：
 *   - 从 token 解出身份 / 把代理账号写成应用登录（含备份）
 *   - describeAppLogin 能发现“应用登录 ≠ 代理当前账号”
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { decodeIdentity, readAppLogin, buildAuthPayload, writeAppLogin } = require('../lib/app-auth');
const { readProxyAccounts, findAccount, describeAppLogin } = require('../lib/proxy-accounts');

/** 造一个只有 payload 有意义的假 JWT：exp 在 1 小时后。 */
function fakeToken(email, accountId, plan = 'plus') {
  const payload = {
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: 'auth0|test',
    'https://api.openai.com/auth': { chatgpt_account_id: accountId, chatgpt_plan_type: plan },
    'https://api.openai.com/profile': { email },
  };
  return 'h.' + Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url') + '.s';
}

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-app-auth-'));
  const data = path.join(dir, 'multi-auth');
  fs.mkdirSync(data, { recursive: true });
  return { dir, data, authPath: path.join(dir, 'auth.json'), accountsFile: path.join(data, 'openai-codex-accounts.json') };
}

function writeAccounts(file, list, activeIndex = 0) {
  fs.writeFileSync(file, JSON.stringify({ activeIndex, accounts: list }, null, 2), 'utf8');
}

test('decodeIdentity：从 access_token 里解出 email / accountId / plan / 过期时间', () => {
  const id = decodeIdentity(fakeToken('a@example.com', 'acct-1'));
  assert.equal(id.email, 'a@example.com');
  assert.equal(id.accountId, 'acct-1');
  assert.equal(id.plan, 'plus');
  assert.ok(id.expiresAt > Date.now());
});

test('decodeIdentity：垃圾输入返回 null，不抛错', () => {
  for (const bad of [null, undefined, '', 'not-a-jwt', 'a.b']) {
    assert.equal(decodeIdentity(bad), null, String(bad));
  }
});

test('readAppLogin：文件不存在 / JSON 损坏时返回 present=false', () => {
  const box = sandbox();
  assert.equal(readAppLogin(box.authPath).present, false);
  fs.writeFileSync(box.authPath, '{ broken', 'utf8');
  const r = readAppLogin(box.authPath);
  assert.equal(r.present, false);
  assert.equal(r.email, null);
});

test('buildAuthPayload：id_token 用 access_token 兜底，account_id 保留', () => {
  const token = fakeToken('a@example.com', 'acct-1');
  const payload = buildAuthPayload({ accessToken: token, refreshToken: 'rt-x', accountId: 'acct-1' });
  assert.equal(payload.auth_mode, 'chatgpt');
  assert.equal(payload.tokens.access_token, token);
  assert.equal(payload.tokens.id_token, token);
  assert.equal(payload.tokens.refresh_token, 'rt-x');
  assert.equal(payload.tokens.account_id, 'acct-1');
  assert.throws(() => buildAuthPayload({}), /accessToken/);
});

test('writeAppLogin：写入后能读回身份，并留下备份文件', () => {
  const box = sandbox();
  fs.writeFileSync(box.authPath, JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: fakeToken('old@example.com', 'acct-old') } }), 'utf8');
  const token = fakeToken('new@example.com', 'acct-new');
  const out = writeAppLogin({ email: 'new@example.com', accountId: 'acct-new', accessToken: token, refreshToken: 'rt-1' }, { authPath: box.authPath });
  assert.equal(out.ok, true);
  assert.equal(out.email, 'new@example.com');
  assert.ok(out.backup && fs.existsSync(out.backup), '必须备份旧 auth.json');
  const protectedText = fs.readFileSync(out.backup, 'utf8');
  assert.doesNotMatch(protectedText, /access_token|old@example.com/);
  const restored = require('../lib/protected-data').unprotect(JSON.parse(protectedText));
  assert.equal(decodeIdentity(JSON.parse(restored).tokens.access_token).email, 'old@example.com');
  const login = readAppLogin(box.authPath);
  assert.equal(login.email, 'new@example.com');
  assert.equal(login.accountId, 'acct-new');
});

test('describeAppLogin：应用登录与代理当前账号不一致时给出提示', () => {
  const box = sandbox();
  const tokenA = fakeToken('a@example.com', 'acct-a');
  const tokenB = fakeToken('b@example.com', 'acct-b');
  writeAccounts(box.accountsFile, [
    { email: 'a@example.com', accountId: 'acct-a', accessToken: tokenA, refreshToken: 'r1' },
    { email: 'b@example.com', accountId: 'acct-b', accessToken: tokenB, refreshToken: 'r2' },
  ], 1);
  fs.writeFileSync(box.authPath, JSON.stringify(buildAuthPayload({ accessToken: tokenA, accountId: 'acct-a' })), 'utf8');

  const info = readProxyAccounts(box.accountsFile);
  assert.equal(info.ok, true);
  assert.equal(findAccount(info, {}).email, 'b@example.com');
  assert.equal(findAccount(info, { n: 1 }).email, 'a@example.com');
  assert.equal(findAccount(info, { email: 'a@example.com' }).accountId, 'acct-a');

  const mismatch = describeAppLogin({ authPath: box.authPath, file: box.accountsFile });
  assert.equal(mismatch.loggedInEmail, 'a@example.com');
  assert.equal(mismatch.currentEmail, 'b@example.com');
  assert.equal(mismatch.matchesCurrent, false);
  assert.match(mismatch.hint, /不一致/);

  writeAppLogin(findAccount(info, {}), { authPath: box.authPath });
  const fixed = describeAppLogin({ authPath: box.authPath, file: box.accountsFile });
  assert.equal(fixed.matchesCurrent, true);
  assert.equal(fixed.hint, '');
});
