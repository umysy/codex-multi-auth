"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test } = require("node:test");

const ROOT = path.resolve(__dirname, "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "patch-cli-head-retry.js");
const PAYLOAD = path.join(ROOT, "scripts", "cli-patch", "sse-head-retry.js");
const LIVE_QUOTA_PAYLOAD = path.join(ROOT, "scripts", "cli-patch", "live-quota.js");

const PROXY_BODY = [
  'import { forwardStreamingResponse } from "./request/stream-failover-runtime.js";',
  'const state = { streamStallTimeoutMs: 45000 };',
  'async function handle(upstream) {',
  '    const usageScanner = createUsageStreamScanner({});',
  '    return usageScanner;',
  '}',
  '',
].join("\n");

function makeAppData() {
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), "cma-cli-patch-"));
  const dist = path.join(appData, "npm", "node_modules", "codex-multi-auth", "dist");
  fs.mkdirSync(path.join(dist, "lib", "request"), { recursive: true });
  fs.writeFileSync(path.join(dist, "lib", "runtime-rotation-proxy.js"), PROXY_BODY, "utf8");
  return { appData, dist };
}

function run(appData, args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, APPDATA: appData },
    encoding: "utf8",
  });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

test("patch-cli-head-retry：安装、幂等、--check、--revert", () => {
  const { appData, dist } = makeAppData();
  const proxy = path.join(dist, "lib", "runtime-rotation-proxy.js");
  try {
    const first = run(appData, []);
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /"installed": true/);
    assert.ok(fs.existsSync(path.join(dist, "lib", "request", "sse-head-retry.js")));
    assert.equal(
      fs.readFileSync(path.join(dist, "lib", "request", "sse-head-retry.js"), "utf8"),
      fs.readFileSync(PAYLOAD, "utf8"),
    );
    const patched = fs.readFileSync(proxy, "utf8");
    assert.match(patched, /inspectResponseHead/);
    assert.match(patched, /CODEX_MULTI_AUTH_STREAM_HEAD_RETRY/);
    assert.match(patched, /refundConsumedPoolToken\(refreshed\.account\)/);
    assert.match(patched, /lastError = `model-capacity:/);
    assert.match(patched, /import \{ recordLiveQuota \} from "\.\/request\/live-quota\.js";/);
    assert.match(patched, /recordLiveQuota\(accountId, upstream\.headers, upstream\.status\)/);
    assert.equal(
      fs.readFileSync(path.join(dist, "lib", "request", "live-quota.js"), "utf8"),
      fs.readFileSync(LIVE_QUOTA_PAYLOAD, "utf8"),
    );

    const second = run(appData, []);
    assert.equal(second.code, 0, second.out);
    assert.match(second.out, /"skipped": true/);
    assert.equal(fs.readFileSync(proxy, "utf8"), patched);

    const check = run(appData, ["--check"]);
    assert.equal(check.code, 0, check.out);
    assert.match(check.out, /"installed": true/);
    assert.match(check.out, /"moduleOk": true/);
    assert.match(check.out, /"liveQuotaOk": true/);

    const revert = run(appData, ["--revert"]);
    assert.equal(revert.code, 0, revert.out);
    assert.equal(fs.readFileSync(proxy, "utf8"), PROXY_BODY);
    assert.equal(fs.existsSync(path.join(dist, "lib", "request", "sse-head-retry.js")), false);
    assert.equal(fs.existsSync(path.join(dist, "lib", "request", "live-quota.js")), false);
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------------------------
 * The SSE gate itself (scripts/cli-patch/sse-head-retry.js).
 * The payload is ESM; copy it to .mjs so every supported Node version loads it.
 * ------------------------------------------------------------------------ */
let gatePromise = null;
function loadGate() {
  if (!gatePromise) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cma-sse-gate-"));
    const file = path.join(dir, "sse-head-retry.mjs");
    fs.copyFileSync(PAYLOAD, file);
    gatePromise = import(require("node:url").pathToFileURL(file).href);
  }
  return gatePromise;
}

const enc = new TextEncoder();
const sse = (obj, name) => (name ? `event: ${name}\n` : "") + `data: ${JSON.stringify(obj)}\n\n`;
const CREATED = sse({ type: "response.created", response: { id: "r1" } }, "response.created");
const OUTPUT = sse({ type: "response.output_item.added", item: { type: "reasoning" } }, "response.output_item.added");
const COMPLETED = sse({ type: "response.completed", response: { id: "r1" } }, "response.completed");
const OVERLOAD = sse({ type: "error", error: { message: "Our servers are currently overloaded.", type: "service_unavailable_error", code: "server_is_overloaded", headers: { "retry-after": "6" } } });

/** Upstream double: emits the given chunks; a number in the list is a delay in ms. */
function upstreamOf(chunks, { status = 200, contentType = null } = {}) {
  const body = new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        if (typeof c === "number") { await new Promise((r) => setTimeout(r, c)); continue; }
        controller.enqueue(enc.encode(c));
      }
      controller.close();
    },
  });
  const headers = new Headers(contentType ? { "content-type": contentType } : {});
  return new Response(body, { status, headers });
}

async function drain(response) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += dec.decode(value, { stream: true });
  }
}

test("SSE 闸门：response.created 之后的过载错误 → retryable（带 retry-after）", async () => {
  const { inspectResponseHead } = await loadGate();
  const head = await inspectResponseHead(upstreamOf([CREATED, OVERLOAD]));
  assert.equal(head.retryable, true);
  assert.equal(head.reason, "server_is_overloaded");
  assert.equal(head.retryAfterMs, 6000);
});

test("SSE 闸门：顶层形状 {type:error, code} 与 response.failed/slow_down 都算容量", async () => {
  const { inspectResponseHead } = await loadGate();
  const top = await inspectResponseHead(upstreamOf([CREATED, sse({ type: "error", code: "server_is_overloaded", message: "x" })]));
  assert.equal(top.retryable, true);
  const failed = await inspectResponseHead(upstreamOf([CREATED, sse({ type: "response.failed", response: { error: { code: "slow_down", message: "slow down" } } })]));
  assert.equal(failed.retryable, true);
  assert.equal(failed.reason, "slow_down");
});

test("SSE 闸门：分块恰好断在行尾（只有 event: 行 / 注释行）也不能误判成非 SSE", async () => {
  const { inspectResponseHead } = await loadGate();
  // v1 bug: a first chunk without a complete data: line was forwarded unchecked.
  for (const first of ["event: response.created\n", ": keepalive\n\n"]) {
    const rest = first.startsWith("event") ? CREATED.slice(first.length) : CREATED;
    const head = await inspectResponseHead(upstreamOf([first, rest, OVERLOAD]));
    assert.equal(head.retryable, true, JSON.stringify(first));
  }
});

test("SSE 闸门：结构事件（output_item.added / content_part.added / metadata）之后的容量错误仍可透明重试", async () => {
  const { inspectResponseHead } = await loadGate();
  const PART = sse({ type: "response.content_part.added", part: { type: "output_text", text: "" } }, "response.content_part.added");
  const META = sse({ type: "response.metadata", metadata: {} }, "response.metadata");
  const head = await inspectResponseHead(upstreamOf([CREATED, OUTPUT, PART, META, OVERLOAD]));
  assert.equal(head.retryable, true);
});

test("SSE 闸门：容量错误出现在正文之后 → 流以错误结束（客户端会重试），不把容量错误转给客户端", async () => {
  const { inspectResponseHead } = await loadGate();
  let tail = null;
  let after = null;
  const DELTA = sse({ type: "response.output_text.delta", delta: "收" }, "response.output_text.delta");
  const head = await inspectResponseHead(upstreamOf([CREATED, OUTPUT, DELTA, 20, OVERLOAD, COMPLETED]), { onTailCapacity: (r, a) => { tail = r; after = a; } });
  assert.equal(head.retryable, false);
  assert.ok(head.response);
  const reader = head.response.body.getReader();
  const dec = new TextDecoder();
  let seen = "";
  await assert.rejects(async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      seen += dec.decode(value, { stream: true });
    }
  }, /model capacity mid-stream/);
  assert.match(seen, /response\.output_text\.delta/);
  assert.doesNotMatch(seen, /server_is_overloaded/);
  assert.equal(tail, "server_is_overloaded");
  assert.deepEqual(after, ["response.created", "response.output_item.added", "response.output_text.delta"]);
});

test("SSE 闸门：首个正文前空闲超时 → 不截断，后续字节完整转发", async () => {
  const { inspectResponseHead } = await loadGate();
  // v1 bug: the idle timeout closed the replayed stream after the buffered head.
  const head = await inspectResponseHead(upstreamOf([CREATED, 80, OUTPUT, COMPLETED]), { idleTimeoutMs: 20 });
  assert.equal(head.retryable, false);
  assert.equal(await drain(head.response), CREATED + OUTPUT + COMPLETED);
});

test("SSE 闸门：一个字节都没有就超时 → 仍返回可读响应（不能交回已上锁的原始流）", async () => {
  const { inspectResponseHead } = await loadGate();
  const head = await inspectResponseHead(upstreamOf([80, CREATED, OUTPUT, COMPLETED]), { idleTimeoutMs: 20 });
  assert.ok(head.response, "必须给出响应");
  assert.equal(await drain(head.response), CREATED + OUTPUT + COMPLETED);
});

test("SSE 闸门：首个正文事件与后续事件同在一个分块里 → 一个都不能丢", async () => {
  const { inspectResponseHead } = await loadGate();
  // Found on the live router: short answers arrive in one chunk; dropping the rest of
  // the batch lost output_text.delta and response.completed (upstream_missing_terminal).
  const DELTA = sse({ type: "response.output_text.delta", delta: "收到" }, "response.output_text.delta");
  const all = CREATED + OUTPUT + DELTA + COMPLETED;
  const one = await inspectResponseHead(upstreamOf([all]));
  assert.equal(await drain(one.response), all);
  const split = await inspectResponseHead(upstreamOf([CREATED, OUTPUT + DELTA + COMPLETED.slice(0, 10), COMPLETED.slice(10)]));
  assert.equal(await drain(split.response), all);
});

test("SSE 闸门：任意切分分块，输出与上游逐字节相同（含中文多字节）", async () => {
  const { inspectResponseHead } = await loadGate();
  const events = [CREATED, sse({ type: "response.in_progress" }, "response.in_progress"), ": ping\n\n", OUTPUT];
  for (let i = 0; i < 12; i++) events.push(sse({ type: "response.output_text.delta", delta: "第" + i + "段 ✓" }, "response.output_text.delta"));
  events.push(COMPLETED);
  const full = events.join("");
  let seed = 7;
  const rand = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const bytes = enc.encode(full);
    const cuts = new Set();
    const n = 1 + rand(8);
    for (let c = 0; c < n; c++) cuts.add(1 + rand(bytes.length - 1));
    const points = [0, ...[...cuts].sort((a, b) => a - b), bytes.length];
    const body = new ReadableStream({
      start(controller) {
        for (let p = 0; p + 1 < points.length; p++) controller.enqueue(bytes.slice(points[p], points[p + 1]));
        controller.close();
      },
    });
    const head = await inspectResponseHead(new Response(body, { status: 200 }));
    assert.equal(await drain(head.response), full, "cuts=" + points.join(","));
  }
});

test("SSE 闸门：正常流、非容量错误、JSON 正文都原样转发", async () => {
  const { inspectResponseHead } = await loadGate();
  const ok = await inspectResponseHead(upstreamOf([CREATED, OUTPUT, COMPLETED]));
  assert.equal(await drain(ok.response), CREATED + OUTPUT + COMPLETED);
  const ctx = sse({ type: "error", error: { code: "context_length_exceeded", message: "too long" } });
  const other = await inspectResponseHead(upstreamOf([CREATED, ctx]));
  assert.equal(other.retryable, false);
  assert.equal(await drain(other.response), CREATED + ctx);
  const json = '{"id":"x","object":"response"}';
  const plain = await inspectResponseHead(upstreamOf([json], { contentType: "application/json" }));
  assert.equal(await drain(plain.response), json);
  const sniffed = await inspectResponseHead(upstreamOf([json]));
  assert.equal(await drain(sniffed.response), json);
});

test("patch-cli-head-retry：把 v1 钩子升级为 v2，且结果可被 Node 解析", () => {
  const { patchProxyText, hookVersionOf, HOOK_VERSION } = require(SCRIPT);
  const v1 = [
    'import { forwardStreamingResponse } from "./request/stream-failover-runtime.js";',
    'import { classifyUpstreamTransportError } from "./request/upstream-transport-error.js";',
    'import { inspectResponseHead } from "./request/sse-head-retry.js";',
    "async function handle() {",
    "    for (;;) {",
    "            // Local deployment patch (CodexMultiAuth repo): the upstream sometimes",
    '            // "Selected model is at capacity".',
    '            if (isResponsesRequest && process.env.CODEX_MULTI_AUTH_STREAM_HEAD_RETRY !== "0") {',
    "                const head = await inspectResponseHead(upstream, { idleTimeoutMs: 15000 });",
    "                                if (head.retryable) {",
    "                    transientAttempts += 1;",
    "                    continue;",
    "                }",
    "                if (head.response)",
    "                    upstream = head.response;",
    "            }            const usageScanner = createUsageStreamScanner({});",
    "    }",
    "}",
    "",
  ].join("\n");
  assert.equal(hookVersionOf(v1), 1);
  const v2 = patchProxyText(v1);
  assert.equal(hookVersionOf(v2), HOOK_VERSION);
  assert.equal((v2.match(/inspectResponseHead\(upstream/g) || []).length, 1, "旧钩子必须被移除");
  assert.doesNotMatch(v2, /Local deployment patch/);
  assert.match(v2, /waitOutModelCapacity\(head\.retryAfterMs/);
  assert.match(v2, /forgetSession\(context\.sessionKey\)/);
  assert.equal(patchProxyText(v2), v2, "幂等");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cma-hook-syntax-"));
  try {
    const file = path.join(dir, "proxy.mjs");
    fs.writeFileSync(file, v2, "utf8");
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
/* --------------------------------------------------------------------------
 * Live quota recorder (scripts/cli-patch/live-quota.js).
 * ------------------------------------------------------------------------ */
function loadLiveQuota() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cma-live-quota-mod-"));
  const file = path.join(dir, "live-quota.mjs");
  fs.copyFileSync(LIVE_QUOTA_PAYLOAD, file);
  return import(require("node:url").pathToFileURL(file).href);
}

test("live-quota：把响应头里的额度写成 quota-cache 同形快照，连续观测合并成一次写", async () => {
  const { createLiveQuotaRecorder, readQuotaHeaders } = await loadLiveQuota();
  const now = 1_800_000_000_000;
  const headers = new Headers({
    "x-codex-primary-used-percent": "12",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-after-seconds": "600",
    "x-codex-secondary-used-percent": "34",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": String(now / 1000 + 86400),
    "x-codex-plan-type": "plus",
  });
  assert.deepEqual(readQuotaHeaders(headers, 200, now), {
    status: 200,
    planType: "plus",
    primary: { usedPercent: 12, windowMinutes: 300, resetAtMs: now + 600_000 },
    secondary: { usedPercent: 34, windowMinutes: 10080, resetAtMs: now + 86_400_000 },
    updatedAt: now,
  });
  assert.equal(readQuotaHeaders(new Headers({ "content-type": "text/event-stream" }), 200, now), null);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cma-live-quota-"));
  const file = path.join(dir, "live-quota.json");
  try {
    fs.writeFileSync(file, JSON.stringify({ version: 1, byAccountId: { keep: { updatedAt: 1 } } }));
    const rec = createLiveQuotaRecorder({ file, now: () => now });
    const later = new Headers({ "x-codex-primary-used-percent": "13", "x-codex-primary-window-minutes": "300" });
    await Promise.all([rec.record("acct-a", headers, 200), rec.record("acct-a", later, 200), rec.record("acct-b", headers, 200)]);
    await rec.record("", headers, 200);
    await rec.record("acct-c", new Headers(), 200);
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(saved.byAccountId).sort(), ["acct-a", "acct-b", "keep"]);
    assert.equal(saved.byAccountId["acct-a"].primary.usedPercent, 13, "同一账号以最后一次观测为准");
    assert.equal(saved.updatedAt, now);
    assert.deepEqual(fs.readdirSync(dir), ["live-quota.json"], "不留临时文件");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("live-quota：写不进去时吞掉错误，不影响请求", async () => {
  const { createLiveQuotaRecorder } = await loadLiveQuota();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cma-live-quota-bad-"));
  try {
    // 目标路径是一个目录：rename 必然失败。
    const file = path.join(dir, "taken");
    fs.mkdirSync(file);
    const rec = createLiveQuotaRecorder({ file });
    await rec.record("acct-a", new Headers({ "x-codex-primary-used-percent": "5" }), 200);
    assert.ok(fs.statSync(file).isDirectory());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
