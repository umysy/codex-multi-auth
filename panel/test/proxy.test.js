'use strict';
/**
 * proxy.js 单测。
 *
 * 重点不是“能不能读注册表”，而是三条兜底链路的优先级与产生给 CLI 的环境变量
 * （尤其是 NODE_USE_ENV_PROXY）——上次“刷新额度没反应”就是因为它丢了。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const proxy = require('../lib/proxy');

function tmpConfig(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-proxy-'));
  const file = path.join(dir, 'panel-config.json');
  fs.writeFileSync(file, JSON.stringify(obj), 'utf8');
  return { dir, file };
}

test('cleanUrl：只认 http(s)，去掉尾部斜杠', () => {
  assert.equal(proxy.cleanUrl(' http://127.0.0.1:7897/ '), 'http://127.0.0.1:7897');
  assert.equal(proxy.cleanUrl('https://proxy.local:8080///'), 'https://proxy.local:8080');
  assert.equal(proxy.cleanUrl('127.0.0.1:7897'), '');
  assert.equal(proxy.cleanUrl('socks5://127.0.0.1:7897'), '');
  assert.equal(proxy.cleanUrl(null), '');
});

test('envProxy：HTTPS 优先，大小写都认', () => {
  assert.equal(proxy.envProxy({ HTTP_PROXY: 'http://a:1', HTTPS_PROXY: 'http://b:2' }), 'http://b:2');
  assert.equal(proxy.envProxy({ http_proxy: 'http://a:1' }), 'http://a:1');
  assert.equal(proxy.envProxy({}), '');
  assert.equal(proxy.envProxy(undefined), '');
});

test('configProxy：读 panel-config.json 的 proxy，坏文件当作没有', () => {
  const good = tmpConfig({ proxy: 'http://127.0.0.1:7897' });
  assert.equal(proxy.configProxy(good.file), 'http://127.0.0.1:7897');
  const empty = tmpConfig({});
  assert.equal(proxy.configProxy(empty.file), '');
  assert.equal(proxy.configProxy(path.join(good.dir, 'missing.json')), '');
  assert.equal(proxy.configProxy(''), '');
});

test('parseProxyServer：host:port 与协议分号写法', () => {
  assert.equal(proxy.parseProxyServer('127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(proxy.parseProxyServer('http=127.0.0.1:7897;https=127.0.0.1:7898'), 'http://127.0.0.1:7898');
  assert.equal(proxy.parseProxyServer('http=127.0.0.1:7897'), 'http://127.0.0.1:7897');
  assert.equal(proxy.parseProxyServer(''), '');
});

test('systemProxy：仅 Windows 且 ProxyEnable=1 才算数（注入执行函数，不碰真注册表）', () => {
  const run = (file, args) => {
    const key = args.join(' ');
    if (key.indexOf('ProxyEnable') !== -1) return 'ProxyEnable    REG_DWORD    0x1\r\n';
    return 'ProxyServer    REG_SZ    127.0.0.1:7897\r\n';
  };
  assert.equal(proxy.systemProxy('linux', run), '');
  assert.equal(proxy.systemProxy('win32', run), 'http://127.0.0.1:7897');
  const off = (file, args) => (args.join(' ').indexOf('ProxyEnable') !== -1 ? '0x0' : '127.0.0.1:7897');
  assert.equal(proxy.systemProxy('win32', off), '');
  const broken = () => { throw new Error('reg missing'); };
  assert.equal(proxy.systemProxy('win32', broken), '');
});

test('resolveProxyUrl：环境 → 配置 → 系统，前者赢', () => {
  const cfg = tmpConfig({ proxy: 'http://127.0.0.1:7777' });
  const run = (file, args) => (args.join(' ').indexOf('ProxyEnable') !== -1
    ? 'ProxyEnable    REG_DWORD    0x1'
    : 'ProxyServer    REG_SZ    127.0.0.1:9999');
  assert.equal(proxy.resolveProxyUrl({ env: { HTTPS_PROXY: 'http://127.0.0.1:1' }, configPath: cfg.file, platform: 'win32', run }), 'http://127.0.0.1:1');
  assert.equal(proxy.resolveProxyUrl({ env: {}, configPath: cfg.file, platform: 'win32', run }), 'http://127.0.0.1:7777');
  assert.equal(proxy.resolveProxyUrl({ env: {}, configPath: '', platform: 'win32', run }), 'http://127.0.0.1:9999');
  assert.equal(proxy.resolveProxyUrl({ env: {}, configPath: '', platform: 'linux' }), '');
});

test('proxyEnv：空代理不注入；有代理必须带 NODE_USE_ENV_PROXY=1', () => {
  assert.deepEqual(proxy.proxyEnv(''), {});
  const env = proxy.proxyEnv('http://127.0.0.1:7897', { NO_PROXY: 'example.com,localhost' });
  assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7897');
  assert.equal(env.https_proxy, 'http://127.0.0.1:7897');
  assert.equal(env.NODE_USE_ENV_PROXY, '1');
  const parts = env.NO_PROXY.split(',');
  assert.ok(parts.includes('localhost'));
  assert.ok(parts.includes('example.com'));
  assert.equal(parts.filter((v) => v === 'localhost').length, 1, 'NO_PROXY 去重');
});

test('currentProxyUrl：带缓存，resetCache 后重新解析', () => {
  proxy.resetCache();
  const saved = {};
  for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) { saved[k] = process.env[k]; delete process.env[k]; }
  const first = tmpConfig({ proxy: 'http://127.0.0.1:6666' });
  const a = proxy.currentProxyUrl(first.file);
  const second = tmpConfig({ proxy: 'http://127.0.0.1:5555' });
  assert.equal(proxy.currentProxyUrl(second.file), a, '缓存期内沿用旧值');
  proxy.resetCache();
  assert.equal(proxy.currentProxyUrl(second.file), 'http://127.0.0.1:5555');
  proxy.resetCache();
  for (const k of Object.keys(saved)) { if (saved[k] !== undefined) process.env[k] = saved[k]; }
});
