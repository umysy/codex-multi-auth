'use strict';
/**
 * router-control 的纯逻辑单测。
 *
 * 这个模块原来只有契约测试间接覆盖（面板启动时才会跑到），
 * 而它最容易坏的地方是**判定逻辑**：进程还活着但状态文件说 running、
 * 陈旧错误什么时候算“已恢复”、启动项被别的 HOME 改写成什么样子才该修。
 * 这些都不需要真的起进程/改本机文件，所以抽成纯函数单独测。
 */
const { test } = require('node:test');
const assert = require('node:assert');

const rc = require('../lib/router-control');

// 固定时钟：状态文件里 updatedAt 每秒刷新一次，判 running 必须带上当前时间才可测。
const NOW = 1700000500000;

const BIND = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  routerScriptPath: 'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\codex-multi-auth\\scripts\\codex-app-router.js',
  port: 56014,
  statusPath: 'C:\\Users\\me\\.codex\\multi-auth\\app-bind\\runtime-rotation-app-bind-status.json',
  identityToken: 'tok',
  statePath: 'C:\\Users\\me\\.codex\\multi-auth\\app-bind\\state.json',
  logPath: 'C:\\Users\\me\\.codex\\multi-auth\\app-bind\\router.log',
};

const GOOD_CMD = [
  '@echo off',
  'set "CODEX_AUTH_FETCH_TIMEOUT_MS=300000"',
  'set "CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=90000"',
  `"${BIND.nodePath}" "${BIND.routerScriptPath}" --port ${BIND.port} --status "${BIND.statusPath}" --identity-token "tok" --state "${BIND.statePath}" --log "${BIND.logPath}" --max-log-bytes 1048576`,
].join('\r\n');

function status(over) {
  return Object.assign({
    state: 'running',
    pid: 4242,
    totalRequests: 100,
    upstreamRequests: 90,
    rotations: 3,
    retries: 2,
    websocketConnections: 1,
    lastError: '',
    lastAccountIndex: 1,
    startedAt: 1700000000000,
    updatedAt: 1700000500000,
  }, over);
}

test('describeRouterStatus：进程活着、状态 running、状态文件新鲜才算 running', () => {
  const base = rc.describeRouterStatus(status(), true, null, NOW);
  assert.equal(base.running, true);
  assert.equal(base.pid, 4242);
  assert.equal(base.port, 56014, '端口是写死的 56014（面板约定的固定入口）');
  assert.equal(base.requests, 100);
  assert.equal(base.rotations, 3);
  assert.equal(base.lastAccountIndex, 2, '状态文件 0 基 → 面板 1 基');
});

test('describeRouterStatus：状态写着 running 但进程不在 → 不算 running', () => {
  const dead = rc.describeRouterStatus(status(), false, null, NOW);
  assert.equal(dead.running, false);
  assert.equal(dead.pid, 4242, 'pid 原样返回，方便排障');
});

test('describeRouterStatus：状态文件过期（进程已被系统回收/换 PID）→ 不算 running', () => {
  const staleNow = NOW + 60000;
  const stale = rc.describeRouterStatus(status(), true, null, staleNow);
  assert.equal(stale.running, false, 'updatedAt 超过 15 秒没刷新就说明路由已经不在了');
  const fresh = rc.describeRouterStatus(status(), true, null, NOW + 5000);
  assert.equal(fresh.running, true, '1 秒一刷新的状态文件，5 秒内必须算活着');
});

test('describeRouterStatus：字段缺失时给安全默认值', () => {
  const empty = rc.describeRouterStatus({}, false, null, NOW);
  assert.equal(empty.running, false);
  assert.equal(empty.requests, 0);
  assert.equal(empty.lastError, '');
  assert.equal(empty.lastAccountIndex, null);
  assert.equal(empty.rotations, 0);
});

test('describeRouterStatus：lastAccountIndex 非数字时给 null，不做隐式转换', () => {
  assert.equal(rc.describeRouterStatus(status({ lastAccountIndex: '2' }), true).lastAccountIndex, null);
  assert.equal(rc.describeRouterStatus(status({ lastAccountIndex: null }), true).lastAccountIndex, null);
});

test('nextErrorCache：首次看到错误 → 记下时刻与请求数，需要落盘', () => {
  const step = rc.nextErrorCache(false, 'fetch failed', 10, 1700000000000);
  assert.equal(step.started, true);
  assert.deepEqual(step.cache, { text: 'fetch failed', at: 1700000000000, requestsAt: 10 });
});

test('nextErrorCache：同一文本的后续 tick 不重复落盘', () => {
  const first = rc.nextErrorCache(null, 'fetch failed', 10, 1700000000000);
  const again = rc.nextErrorCache(first.cache, 'fetch failed', 12, 1700000030000);
  assert.equal(again.started, false);
  assert.deepEqual(again.cache, first.cache, '保留首次观察时刻，不被后续 tick 覆盖');
});

test('nextErrorCache：错误文本换了 → 重新计时', () => {
  const first = rc.nextErrorCache(null, 'fetch failed', 10, 1700000000000);
  const changed = rc.nextErrorCache(first.cache, 'ECONNRESET', 12, 1700000030000);
  assert.equal(changed.started, true);
  assert.deepEqual(changed.cache, { text: 'ECONNRESET', at: 1700000030000, requestsAt: 12 });
});

test('errorMetaOf：请求数没涨 → 陈旧错误还没恢复', () => {
  const cache = { text: 'fetch failed', at: 1700000000000, requestsAt: 10 };
  const meta = rc.errorMetaOf(cache, 10);
  assert.equal(meta.since, 0);
  assert.equal(meta.recovered, false);
  assert.equal(meta.at, 1700000000000);
});

test('errorMetaOf：之后成功处理 2 个请求才算恢复', () => {
  const cache = { text: 'fetch failed', at: 1700000000000, requestsAt: 10 };
  assert.equal(rc.errorMetaOf(cache, 11).recovered, false, '只涨 1 个还不够');
  const recovered = rc.errorMetaOf(cache, 12);
  assert.equal(recovered.since, 2);
  assert.equal(recovered.recovered, true);
});

test('errorMetaOf：没有错误记录 / 已 reset → 视为已恢复', () => {
  for (const empty of [null, undefined, false, true]) {
    const meta = rc.errorMetaOf(empty, 50);
    assert.deepEqual(meta, { at: null, since: 0, recovered: true });
  }
});

test('needsStartRepair：本机正确启动项不动它', () => {
  assert.equal(rc.needsStartRepair(GOOD_CMD, BIND), false);
});

test('needsStartRepair：启动项被测试工具改写/端口不符/状态路径缺失都要修', () => {
  assert.equal(rc.needsStartRepair('', BIND), true, '空启动项');
  assert.equal(rc.needsStartRepair(GOOD_CMD.replace('56014', '53999'), BIND), true, '端口不符（别的机器/测试残留）');
  assert.equal(rc.needsStartRepair(GOOD_CMD.replace(BIND.statusPath, 'C:\\tmp\\x.json'), BIND), true, 'status 路径不符');
  assert.equal(rc.needsStartRepair(GOOD_CMD + '\r\nrem codexquota-test', BIND), true, '带测试标记的启动项一律重写');
});

test('needsStartRepair：缺少上游超时设置也要修（否则默认 60s 超时会导致 503）', () => {
  const noFetch = GOOD_CMD.replace('set "CODEX_AUTH_FETCH_TIMEOUT_MS=300000"\r\n', '');
  const noStall = GOOD_CMD.replace('set "CODEX_AUTH_STREAM_STALL_TIMEOUT_MS=90000"\r\n', '');
  assert.equal(rc.needsStartRepair(noFetch, BIND), true, '缺 fetch 超时');
  assert.equal(rc.needsStartRepair(noStall, BIND), true, '缺 stall 超时');
});

test('routerEnv：给路由进程注入上游超时，且不丢父进程环境', () => {
  const env = rc.routerEnv();
  assert.equal(env.CODEX_AUTH_FETCH_TIMEOUT_MS, '300000');
  assert.equal(env.CODEX_AUTH_STREAM_STALL_TIMEOUT_MS, '90000');
  assert.equal(rc.ROUTER_ENV.CODEX_AUTH_FETCH_TIMEOUT_MS, '300000', '导出常量便于文档/排障引用');
});

test('needsStartRepair：app-bind 配置缺字段时返回 false（由调用方报错，不静默改写）', () => {
  assert.equal(rc.needsStartRepair(GOOD_CMD, null), false);
  assert.equal(rc.needsStartRepair(GOOD_CMD, { port: 1 }), false);
  assert.equal(rc.needsStartRepair(GOOD_CMD, { nodePath: 'x', routerScriptPath: 'y', port: 1 }), false);
});

test('launchWrapperText：call 启动项、记 EXITCODE、写 ROUTER-EXIT 行（纯函数）', () => {
  const txt = rc.launchWrapperText('C:\\a b\\Startup\\router.cmd', 'C:\\a b\\app-bind\\launch.log');
  assert.ok(txt.startsWith('@echo off\r\n'), 'CRLF 是 cmd 的硬要求');
  assert.ok(txt.includes('call "C:\\a b\\Startup\\router.cmd"'), '路径带空格时必须加引号');
  assert.ok(txt.includes('set "EXITCODE=%ERRORLEVEL%"'), '必须先存 ERRORLEVEL 再 echo，否则 echo 会把它冲掉');
  assert.ok(txt.includes('ROUTER-EXIT exit=%EXITCODE%'), '退出码要落在 launch 日志里');
  assert.ok(txt.includes('>>"C:\\a b\\app-bind\\launch.log"'), '追加写，不覆盖历史退出记录');
  assert.ok(txt.trimEnd().endsWith('endlocal'), 'setlocal 必须配对');
});

test('launchVbsText：wscript 脱壳脚本里 launcher 路径被引号包住、并且不等待（False）', () => {
  const txt = rc.launchVbsText('C:\\a b\\router-launch.cmd');
  assert.ok(txt.includes('CreateObject("WScript.Shell")'), '用 WScript.Shell.Run 脱壳');
  assert.ok(txt.includes('"""" & "C:\\a b\\router-launch.cmd" & """"'), '路径要包成 "..." 传给 Run');
  assert.ok(/,\s*0,\s*False\r\n$/.test(txt), '窗口隐藏(0) 且不等待(False)：wscript 立刻退出，父子关系断开');
});

test('模块导出面：纯函数都在，进程操作也还在', () => {
  for (const name of ['readRouter', 'describeRouterStatus', 'nextErrorCache', 'errorMetaOf', 'needsStartRepair', 'launchWrapperText']) {
    assert.equal(typeof rc[name], 'function', name + ' 应该是函数');
  }
  for (const name of ['ensureRouterCmd', 'startRouter', 'stopRouter', 'resetRouterError']) {
    assert.equal(typeof rc[name], 'function', name + ' 应该保留');
  }
});

test('readLaunchExit 读出最后一条退出记录', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { readLaunchExit } = require('../lib/router-control');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cma-exit-'));
  const file = path.join(dir, 'launch.log');
  assert.equal(readLaunchExit(file), null);
  fs.writeFileSync(file, '[2026-10-26 15:53:45.12] ROUTER-EXIT exit=0\r\n', 'ascii');
  assert.deepEqual(readLaunchExit(file), { raw: '[2026-10-26 15:53:45.12] ROUTER-EXIT exit=0', code: 0 });
  fs.appendFileSync(file, '[2026-10-26 16:02:01.90] ROUTER-EXIT exit=1\r\n', 'ascii');
  assert.equal(readLaunchExit(file).code, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});
