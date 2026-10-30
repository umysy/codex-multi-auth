'use strict';
// 静态资源清单闸门：panel/public 下每个文件都必须被两个服务器的 STATIC 表登记。
// 防的是「新加一个前端模块，忘了改 STATIC → 浏览器 404 → 页面白屏」。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const PUBLIC = path.join(ROOT, 'panel', 'public');

const { STATIC: PROD_STATIC, PUBLIC_MODULES } = require(path.join(ROOT, 'panel', 'lib', 'panel-http.js'));
const { STATIC: MOCK_STATIC } = require(path.join(ROOT, 'panel', 'tests', 'mock-server.js'));

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(PUBLIC).map((full) => path.relative(PUBLIC, full).split(path.sep).join('/')).sort();

test('panel/public 的每个文件都被生产 STATIC 表登记', () => {
  for (const rel of files) {
    const key = rel === 'index.html' ? '/' : '/' + rel;
    assert.ok(PROD_STATIC[key], `生产 STATIC 缺少 ${key}（文件 ${rel}）`);
    assert.equal(PROD_STATIC[key][0], rel, `生产 STATIC 的 ${key} 指向了错误的文件`);
  }
});

test('mock-server 的 STATIC 覆盖生产 STATIC 的全部键', () => {
  for (const key of Object.keys(PROD_STATIC)) {
    assert.ok(MOCK_STATIC[key], `mock STATIC 缺少 ${key}`);
    assert.equal(MOCK_STATIC[key][0], PROD_STATIC[key][0], `mock STATIC 的 ${key} 文件不一致`);
  }
});

test('PUBLIC_MODULES 清单与实际 modules 目录一致', () => {
  const onDisk = files
    .filter((rel) => rel.startsWith('modules/') && rel.endsWith('.mjs'))
    .map((rel) => rel.slice('modules/'.length, -'.mjs'.length))
    .sort();
  assert.deepEqual(onDisk, [...PUBLIC_MODULES].sort());
});

test('index.html 只通过 module 方式加载前端入口', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  assert.match(html, /<script type="module" src="\/app\.mjs"><\/script>/);
  assert.doesNotMatch(html, /src="\/app\.js"/);
});

test('app.mjs 的相对 import 都能解析到已登记的静态资源', () => {
  const src = fs.readFileSync(path.join(PUBLIC, 'app.mjs'), 'utf8');
  const re = /from '(\.[^']+)'/g;
  let m;
  let checked = 0;
  while ((m = re.exec(src))) {
    const resolved = path.posix.normalize(m[1]);
    assert.ok(PROD_STATIC['/' + resolved], `app.mjs import 的 ${m[1]} 解析为 /${resolved}，但 STATIC 里没有`);
    checked += 1;
  }
  assert.ok(checked >= 7, `app.mjs 应该 import 至少 7 个模块，实际 ${checked}`);
});
