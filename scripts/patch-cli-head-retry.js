#!/usr/bin/env node
// Patch the installed codex-multi-auth CLI so a streaming model-capacity error
// (HTTP 200 + SSE {"type":"error","error":{"code":"server_is_overloaded"}})
// is retried on another account instead of reaching the Codex client.
//
// The payload (scripts/cli-patch/sse-head-retry.js) holds the start of each
// /responses stream until real output arrives; the hook below re-sends on a
// capacity error. npm upgrades replace dist/, so re-run this script after
// `npm i -g codex-multi-auth`, then restart the router.
//
// usage: node scripts/patch-cli-head-retry.js [--check] [--revert]
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const APPDATA = process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming");
const DIST = path.join(APPDATA, "npm", "node_modules", "codex-multi-auth", "dist");
const MODULE_DST = path.join(DIST, "lib", "request", "sse-head-retry.js");
const TRANSPORT_DST = path.join(DIST, "lib", "request", "upstream-transport-error.js");
const LIVE_QUOTA_DST = path.join(DIST, "lib", "request", "live-quota.js");
const PROXY = path.join(DIST, "lib", "runtime-rotation-proxy.js");
const PAYLOAD = path.join(__dirname, "cli-patch", "sse-head-retry.js");
const TRANSPORT_PAYLOAD = path.join(__dirname, "cli-patch", "upstream-transport-error.js");
const LIVE_QUOTA_PAYLOAD = path.join(__dirname, "cli-patch", "live-quota.js");

const IMPORT_ANCHOR = /(import \{[^}]*\} from "\.\/request\/stream-failover-runtime\.js";\r?\n)/;
const IMPORT_LINE = 'import { inspectResponseHead } from "./request/sse-head-retry.js";\n';
const TRANSPORT_IMPORT_LINE = 'import { classifyUpstreamTransportError } from "./request/upstream-transport-error.js";\n';
const LIVE_QUOTA_IMPORT_LINE = 'import { recordLiveQuota } from "./request/live-quota.js";\n';
const HOOK_ANCHOR = /( *)const usageScanner = createUsageStreamScanner\(\{/;
const HOOK_MARK = "CODEX_MULTI_AUTH_STREAM_HEAD_RETRY";
const HOOK_VERSION = 4;
const BLOCK_BEGIN = "// >>> codex-multi-auth-panel stream-head-retry v";
const BLOCK_END = "// <<< codex-multi-auth-panel stream-head-retry v";
// A versioned hook written by this script (v2+).
const VERSIONED_HOOK_RE = /[ \t]*\/\/ >>> codex-multi-auth-panel stream-head-retry v\d+\r?\n[\s\S]*?\/\/ <<< codex-multi-auth-panel stream-head-retry v\d+\r?\n/;
// The v1 hook (unversioned), including the comment a manual edit put above it.
const V1_HOOK_RE = /(?:[ \t]*\/\/ Local deployment patch \(CodexMultiAuth repo\)[^\n]*\n(?:[ \t]*\/\/[^\n]*\n)*)?[ \t]*if \(isResponsesRequest && process\.env\.CODEX_MULTI_AUTH_STREAM_HEAD_RETRY !== "0"\) \{[\s\S]*?if \(head\.response\)\s*upstream = head\.response;\s*\}/;

/**
 * The proxy hook. Runs inside the request loop of runtime-rotation-proxy.js,
 * after the 200 response arrived and before anything is written to the client.
 *
 * On a capacity error in the held head:
 *  - forget the session affinity that the success path just stored for this account;
 *  - try every other account once (no transient budget spent: the loop is bounded
 *    by attemptedIndexes);
 *  - then use the CLI's own capacity wait (refund, back off, re-send) until its
 *    budget runs out, and only then fall back to the transient budget / 503.
 *
 * Before that (v4), the response's quota headers go to live-quota.json, so the
 * panel sees the in-use account's quota without extra probe requests.
 */
function hookBlock(indent) {
  const i1 = indent;
  const i2 = indent + "    ";
  const i3 = indent + "        ";
  return [
    `${i1}${BLOCK_BEGIN}${HOOK_VERSION}`,
    `${i1}if (isResponsesRequest && !isTranscribeRequest)`,
    `${i2}void recordLiveQuota(accountId, upstream.headers, upstream.status);`,
    `${i1}if (isResponsesRequest && process.env.${HOOK_MARK} !== "0") {`,
    `${i2}const head = await inspectResponseHead(upstream, {`,
    `${i3}idleTimeoutMs: Math.min(state.streamStallTimeoutMs, 30000),`,
    `${i3}holdMs: Math.min(state.streamStallTimeoutMs, 60000),`,
    `${i3}onTailCapacity: (reason, after) => {`,
    `${i3}    state.status.lastError = \`model-capacity-midstream:\${reason}\`;`,
    `${i3}    state.status.lastMidstreamCapacity = { reason, after, at: state.now() };`,
    `${i3}},`,
    `${i2}});`,
    `${i2}if (head.retryable) {`,
    `${i3}state.status.lastError = \`model-capacity:\${head.reason ?? "overloaded"}\`;`,
    `${i3}state.sessionAffinityStore?.forgetSession(context.sessionKey);`,
    `${i3}exhaustionReason = "model-capacity";`,
    `${i3}capabilityRejectionIsLatest = false;`,
    `${i3}const capacityBudgetSpent = capacityDeadlineAt !== null && state.now() >= capacityDeadlineAt;`,
    `${i3}if (!isPinned && !capacityBudgetSpent && attemptedIndexes.size < accountCount) {`,
    `${i3}    refundConsumedPoolToken(refreshed.account);`,
    `${i3}    state.status.retries += 1;`,
    `${i3}    noteRotation();`,
    `${i3}    continue;`,
    `${i3}}`,
    `${i3}const capacityOutcome = await waitOutModelCapacity(head.retryAfterMs ?? null, refreshed.account);`,
    `${i3}if (capacityOutcome === "client-gone") {`,
    `${i3}    await usageRecorder.record({ outcome: "failure", statusCode: upstream.status, errorCode: "client_disconnected_during_capacity_wait", account: refreshed.account });`,
    `${i3}    return;`,
    `${i3}}`,
    `${i3}if (capacityOutcome === "retry")`,
    `${i3}    continue;`,
    `${i3}refundConsumedPoolToken(refreshed.account);`,
    `${i3}transientAttempts += 1;`,
    `${i3}transientExhaustionReason = "model-capacity";`,
    `${i3}state.status.retries += 1;`,
    `${i3}noteRotation();`,
    `${i3}continue;`,
    `${i2}}`,
    `${i2}if (head.response)`,
    `${i3}upstream = head.response;`,
    `${i1}}`,
    `${i1}${BLOCK_END}${HOOK_VERSION}`,
    "",
  ].join("\n");
}

function read(p) {
  return fs.readFileSync(p, "utf8");
}
function write(p, text) {
  fs.writeFileSync(p, text, "utf8");
}
function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+/, "");
}
function backup(p, suffix) {
  const dst = `${p}.bak-headretry-${suffix}`;
  fs.copyFileSync(p, dst);
  return dst;
}

/** Which hook the proxy text carries: 0 = none, 1 = legacy unversioned, n = versioned. */
function hookVersionOf(text) {
  const m = /\/\/ >>> codex-multi-auth-panel stream-head-retry v(\d+)/.exec(text);
  if (m) return Number(m[1]);
  return text.includes(HOOK_MARK) ? 1 : 0;
}

/** Insert the current hook right before the usage scanner (the point before writeHead). */
function insertHook(text) {
  const m = HOOK_ANCHOR.exec(text);
  if (!m) throw new Error("cannot find usageScanner anchor");
  const indent = m[1] || "            ";
  return text.slice(0, m.index) + hookBlock(indent) + indent + text.slice(m.index + m[1].length);
}

/** Pure: proxy text → patched proxy text (current hook version, both imports). */
function patchProxyText(text) {
  let out = text;
  if (!out.includes(IMPORT_LINE.trim())) {
    if (!IMPORT_ANCHOR.test(out)) throw new Error("cannot find stream-failover-runtime import anchor");
    out = out.replace(IMPORT_ANCHOR, (all) => all + IMPORT_LINE);
  }
  for (const line of [TRANSPORT_IMPORT_LINE, LIVE_QUOTA_IMPORT_LINE]) {
    if (out.includes(line.trim())) continue;
    if (!IMPORT_ANCHOR.test(out)) throw new Error("cannot find stream-failover-runtime import anchor");
    out = out.replace(IMPORT_ANCHOR, (all) => all + line);
  }
  const version = hookVersionOf(out);
  if (version !== HOOK_VERSION) {
    if (version > 1) out = out.replace(VERSIONED_HOOK_RE, "");
    else if (version === 1) {
      if (!V1_HOOK_RE.test(out)) throw new Error("legacy hook found but its shape is unknown; run --revert first");
      out = out.replace(V1_HOOK_RE, "");
    }
    out = insertHook(out);
  }
  const transportAnchor = "const transportError = maskString(error instanceof Error ? error.message : String(error));";
  const transportReplacement = "const transportError = classifyUpstreamTransportError(error);";
  if (out.includes(transportAnchor)) out = out.replace(transportAnchor, transportReplacement);
  return out;
}

function apply() {
  if (!fs.existsSync(PAYLOAD)) throw new Error(`missing payload: ${PAYLOAD}`);
  if (!fs.existsSync(PROXY)) throw new Error(`installed CLI not found: ${PROXY}`);
  const suffix = stamp();
  const payload = read(PAYLOAD);
  const transportPayload = read(TRANSPORT_PAYLOAD);
  const moduleChanged = !fs.existsSync(MODULE_DST) || read(MODULE_DST) !== payload;
  const transportChanged = !fs.existsSync(TRANSPORT_DST) || read(TRANSPORT_DST) !== transportPayload;
  const liveQuotaPayload = read(LIVE_QUOTA_PAYLOAD);
  const liveQuotaChanged = !fs.existsSync(LIVE_QUOTA_DST) || read(LIVE_QUOTA_DST) !== liveQuotaPayload;
  const before = read(PROXY);
  const fromVersion = hookVersionOf(before);
  const after = patchProxyText(before);
  const proxyChanged = after !== before;
  if (proxyChanged) {
    // Only the untouched official file is kept as .bak-headretry-*: --revert restores it.
    if (fromVersion === 0) backup(PROXY, suffix);
    else fs.copyFileSync(PROXY, `${PROXY}.bak-headupgrade-v${fromVersion}-${suffix}`);
  }
  if (moduleChanged) {
    fs.mkdirSync(path.dirname(MODULE_DST), { recursive: true });
    write(MODULE_DST, payload);
  }
  if (transportChanged) write(TRANSPORT_DST, transportPayload);
  if (liveQuotaChanged) write(LIVE_QUOTA_DST, liveQuotaPayload);
  if (proxyChanged) write(PROXY, after);
  return {
    moduleChanged,
    transportChanged,
    liveQuotaChanged,
    proxyChanged,
    fromVersion,
    hookVersion: HOOK_VERSION,
    skipped: !proxyChanged && !moduleChanged && !transportChanged && !liveQuotaChanged,
    restartRouter: proxyChanged || moduleChanged || transportChanged || liveQuotaChanged,
  };
}

function revert() {
  const restores = [];
  for (const [target, label] of [[PROXY, "proxy"]]) {
    const dir = path.dirname(target);
    const base = path.basename(target);
    const candidates = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(`${base}.bak-headretry-`))
      .sort();
    if (!candidates.length) continue;
    const latest = path.join(dir, candidates[candidates.length - 1]);
    fs.copyFileSync(latest, target);
    restores.push(`${label} <- ${path.basename(latest)}`);
  }
  if (fs.existsSync(MODULE_DST)) fs.rmSync(MODULE_DST);
  if (fs.existsSync(TRANSPORT_DST)) fs.rmSync(TRANSPORT_DST);
  if (fs.existsSync(LIVE_QUOTA_DST)) fs.rmSync(LIVE_QUOTA_DST);
  return restores;
}

function status() {
  const text = fs.existsSync(PROXY) ? read(PROXY) : "";
  const hookVersion = hookVersionOf(text);
  const installed = hookVersion === HOOK_VERSION;
  const moduleOk = fs.existsSync(MODULE_DST) && fs.existsSync(PAYLOAD) && read(MODULE_DST) === read(PAYLOAD);
  const transportOk = fs.existsSync(TRANSPORT_DST) && fs.existsSync(TRANSPORT_PAYLOAD) && read(TRANSPORT_DST) === read(TRANSPORT_PAYLOAD);
  const liveQuotaOk = fs.existsSync(LIVE_QUOTA_DST) && read(LIVE_QUOTA_DST) === read(LIVE_QUOTA_PAYLOAD);
  // Older CLI builds have no transport-error line to rewrite; nothing is missing then.
  const transportHookOk = text.includes("classifyUpstreamTransportError(error)")
    || !text.includes("const transportError = maskString(");
  return { installed, hookVersion, moduleOk, transportOk, liveQuotaOk, transportHookOk, proxy: PROXY, module: MODULE_DST, transport: TRANSPORT_DST };
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  try {
    if (args.has("--revert")) {
      console.log(JSON.stringify({ reverted: revert() }, null, 2));
    } else if (args.has("--check")) {
      const s = status();
      console.log(JSON.stringify(s, null, 2));
      if (!(s.installed && s.moduleOk && s.transportOk && s.liveQuotaOk && s.transportHookOk)) process.exitCode = 2;
    } else {
      console.log(JSON.stringify({ patched: apply(), status: status() }, null, 2));
    }
  } catch (error) {
    console.error(`patch failed: ${error && error.message ? error.message : error}`);
    process.exit(1);
  }
}

module.exports = { patchProxyText, hookVersionOf, hookBlock, HOOK_VERSION };
