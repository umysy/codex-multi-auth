// Added by the local deployment (CodexMultiAuth repo, scripts/patch-cli-head-retry.js).
// The upstream sometimes accepts a streaming request (HTTP 200) and then reports
// an overload inside the SSE body ("server_is_overloaded" / "slow_down" ...).
// Codex maps that to "Selected model is at capacity" and, for a normal turn,
// gives up instead of retrying.
//
// Two layers handle it:
//  1. Head gate: before anything is written to the client, hold the stream until
//     the first real output event. A capacity error seen while holding is
//     reported as `retryable`, so the proxy re-sends on another account and the
//     client never sees it.
//  2. Tail guard: once the gate has opened, a capacity error can no longer be
//     retried transparently. The guard turns it into a broken stream instead of
//     forwarding it; Codex treats a broken stream as retryable and re-sends the
//     turn, while a forwarded capacity error ends the turn.
//
// SSE is parsed per event (blank-line separated), never per network chunk, so a
// chunk boundary can not hide an event or make SSE look like a plain body.
export const PATCH_VERSION = 2;
const CAPACITY_CODES = new Set([
    "server_is_overloaded",
    "slow_down",
    "model_at_capacity",
    "model_capacity_exceeded",
    "capacity_exceeded",
    "overloaded_error",
    "capacity",
]);
const CAPACITY_MESSAGE_RE = /\bat capacity\b|\boverloaded\b|\bcapacity[_ ]exceeded\b|\bslow_down\b/i;
// Events that carry no visible content; holding them costs the client nothing.
// The structural "added" events come right before the first delta, and overload
// errors were seen right after them, so they are held too (bounded by holdMs).
const HOLD_EVENT_TYPES = new Set([
    "response.created",
    "response.in_progress",
    "response.queued",
    "response.metadata",
    "response.output_item.added",
    "response.content_part.added",
    "response.reasoning_summary_part.added",
]);
const SSE_START_RE = /^(?:data|event|id|retry)\s*:|^:/;
const EVENT_END_RE = /\r?\n\r?\n/g;
function isRecord(value) {
    return value !== null && typeof value === "object";
}
function retryAfterMsOf(error) {
    const headers = isRecord(error.headers) ? error.headers : {};
    const raw = headers["retry-after"] ?? headers["Retry-After"] ?? error.retry_after;
    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}
/**
 * Classify one parsed SSE event.
 * @returns {{kind: "capacity", reason: string, retryAfterMs: number|null} | {kind: "failure"} | {kind: "hold"} | {kind: "output"}}
 */
export function classifyEvent(event, eventName) {
    if (!isRecord(event))
        return { kind: "hold" };
    const type = typeof event.type === "string" ? event.type : (eventName || "");
    let error = null;
    if (type === "error") {
        // Both shapes are seen: {"type":"error","error":{...}} and {"type":"error","code":...}.
        error = isRecord(event.error) ? event.error : event;
    }
    else if (type === "response.failed") {
        const response = isRecord(event.response) ? event.response : {};
        error = isRecord(response.error) ? response.error : {};
    }
    if (error) {
        const code = String(error.code ?? "").toLowerCase();
        const errorType = String(error.type ?? "").toLowerCase();
        const message = typeof error.message === "string" ? error.message : "";
        if (CAPACITY_CODES.has(code) || CAPACITY_CODES.has(errorType) || CAPACITY_MESSAGE_RE.test(message)) {
            return { kind: "capacity", reason: code || errorType || "overloaded", retryAfterMs: retryAfterMsOf(error) };
        }
        return { kind: "failure" };
    }
    if (!type || HOLD_EVENT_TYPES.has(type) || type.startsWith("codex.") || type === "keepalive")
        return { kind: "hold" };
    return { kind: "output" };
}
/** Parse one raw SSE event block into its JSON payload (null for comments/keepalives). */
export function parseEventBlock(block) {
    let eventName = "";
    const data = [];
    for (const rawLine of block.split(/\r?\n/)) {
        if (rawLine.startsWith("data:"))
            data.push(rawLine.slice(5).replace(/^ /, ""));
        else if (rawLine.startsWith("event:"))
            eventName = rawLine.slice(6).trim();
    }
    const payload = data.join("\n").trim();
    if (!payload || payload === "[DONE]")
        return { event: null, eventName };
    try {
        return { event: JSON.parse(payload), eventName };
    }
    catch {
        return { event: null, eventName };
    }
}
/** Split complete events off the front of `text`. Returns [blocks, rest]. */
function takeBlocks(text) {
    const blocks = [];
    let start = 0;
    EVENT_END_RE.lastIndex = 0;
    let match;
    while ((match = EVENT_END_RE.exec(text)) !== null) {
        const end = match.index + match[0].length;
        blocks.push(text.slice(start, end));
        start = end;
    }
    return [blocks, text.slice(start)];
}
function raceTimeout(read, timeoutMs) {
    let timer;
    return Promise.race([
        read,
        new Promise((resolve) => {
            timer = setTimeout(() => resolve({ timedOut: true }), Math.max(1, timeoutMs));
        }),
    ]).finally(() => clearTimeout(timer));
}
/**
 * A readable stream that first replays `heldText`, then keeps forwarding the
 * upstream reader event by event. A capacity error found after the gate opened
 * errors the stream (see the tail guard note at the top of this file).
 * `firstRead` is a read that was already started (an idle timeout won the race
 * against it); its chunk must not be lost.
 */
function guardedStream(reader, decoder, heldText, onTailCapacity, firstRead) {
    const encoder = new TextEncoder();
    let pending = heldText;
    // Last event types sent to the client: tells where in a response capacity errors land.
    const forwarded = [];
    const flush = (controller, final) => {
        const [blocks, rest] = takeBlocks(pending);
        pending = rest;
        for (const block of blocks) {
            const { event, eventName } = parseEventBlock(block);
            const verdict = event ? classifyEvent(event, eventName) : { kind: "hold" };
            if (verdict.kind === "capacity") {
                onTailCapacity?.(verdict.reason, forwarded.slice());
                void reader.cancel().catch(() => undefined);
                controller.error(new Error(`upstream model capacity mid-stream: ${verdict.reason}`));
                return false;
            }
            const type = event && typeof event.type === "string" ? event.type : eventName;
            if (type) {
                forwarded.push(type);
                if (forwarded.length > 6)
                    forwarded.shift();
            }
            controller.enqueue(encoder.encode(block));
        }
        if (final && pending) {
            controller.enqueue(encoder.encode(pending));
            pending = "";
        }
        return true;
    };
    return new ReadableStream({
        start(controller) {
            if (!flush(controller, false))
                return;
            (async () => {
                try {
                    let next = firstRead;
                    for (;;) {
                        const { done, value } = await (next ?? reader.read());
                        next = null;
                        if (done) {
                            pending += decoder.decode();
                            if (flush(controller, true))
                                controller.close();
                            return;
                        }
                        if (value && value.byteLength > 0) {
                            pending += decoder.decode(value, { stream: true });
                            if (!flush(controller, false))
                                return;
                        }
                    }
                }
                catch (error) {
                    try {
                        controller.error(error);
                    }
                    catch { /* already closed */ }
                }
            })();
        },
        cancel() {
            void reader.cancel().catch(() => undefined);
        },
    });
}
function rawReplay(reader, buffered, firstRead) {
    return new ReadableStream({
        start(controller) {
            for (const chunk of buffered)
                controller.enqueue(chunk);
            (async () => {
                try {
                    let next = firstRead;
                    for (;;) {
                        const { done, value } = await (next ?? reader.read());
                        next = null;
                        if (done) {
                            controller.close();
                            return;
                        }
                        if (value)
                            controller.enqueue(value);
                    }
                }
                catch (error) {
                    try {
                        controller.error(error);
                    }
                    catch { /* already closed */ }
                }
            })();
        },
        cancel() {
            void reader.cancel().catch(() => undefined);
        },
    });
}
/**
 * Hold the start of a 200 response until real output arrives.
 *
 * Never closes or truncates the upstream stream: every non-retryable outcome
 * returns a `response` that carries all buffered bytes plus the rest of the body.
 *
 * @param {Response} upstream
 * @param {{idleTimeoutMs?: number, holdMs?: number, maxBytes?: number, onTailCapacity?: (reason: string, after: string[]) => void}} [options]
 * @returns {Promise<{response: Response|null, retryable: boolean, reason: string|null, retryAfterMs: number|null}>}
 */
export async function inspectResponseHead(upstream, options = {}) {
    if (!upstream.body || upstream.status !== 200) {
        return { response: upstream, retryable: false, reason: null, retryAfterMs: null };
    }
    const contentType = String(upstream.headers?.get?.("content-type") ?? "").toLowerCase();
    if (contentType && !contentType.includes("event-stream")) {
        return { response: upstream, retryable: false, reason: null, retryAfterMs: null };
    }
    const idleTimeoutMs = Number.isFinite(options.idleTimeoutMs) ? options.idleTimeoutMs : 15000;
    const holdMs = Number.isFinite(options.holdMs) ? options.holdMs : 45000;
    const maxBytes = Number.isFinite(options.maxBytes) ? options.maxBytes : 262144;
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    const buffered = [];
    let total = 0;
    let held = "";
    let unparsed = "";
    let sniffed = false;
    const deadline = Date.now() + holdMs;
    const wrap = (body) => new Response(body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: upstream.headers,
    });
    let inFlight = null;
    const open = () => ({
        response: wrap(guardedStream(reader, decoder, held + unparsed, options.onTailCapacity, inFlight)),
        retryable: false,
        reason: null,
        retryAfterMs: null,
    });
    for (;;) {
        const remaining = deadline - Date.now();
        if (remaining <= 0)
            return open();
        let result;
        try {
            inFlight ??= reader.read();
            result = await raceTimeout(inFlight, Math.min(idleTimeoutMs, remaining));
        }
        catch {
            // Upstream broke before any output: nothing reached the client, so the
            // forwarder can report the failure through its normal error path.
            return { response: wrap(rawReplay(reader, buffered)), retryable: false, reason: null, retryAfterMs: null };
        }
        if (result.timedOut)
            return open();
        inFlight = null;
        if (result.done) {
            unparsed += decoder.decode();
            return { response: wrap(rawReplay(reader, buffered)), retryable: false, reason: null, retryAfterMs: null };
        }
        const value = result.value;
        if (!value || value.byteLength === 0)
            continue;
        buffered.push(value);
        total += value.byteLength;
        unparsed += decoder.decode(value, { stream: true });
        if (!sniffed) {
            const head = unparsed.trimStart();
            if (!head)
                continue;
            if (!SSE_START_RE.test(head)) {
                if (head.length < 8 && !head.includes("\n"))
                    continue;
                // Not an event stream after all: forward the bytes untouched.
                return { response: wrap(rawReplay(reader, buffered)), retryable: false, reason: null, retryAfterMs: null };
            }
            sniffed = true;
        }
        const [blocks, rest] = takeBlocks(unparsed);
        unparsed = rest;
        for (let k = 0; k < blocks.length; k++) {
            const block = blocks[k];
            const { event, eventName } = parseEventBlock(block);
            const verdict = event ? classifyEvent(event, eventName) : { kind: "hold" };
            if (verdict.kind === "capacity") {
                await reader.cancel().catch(() => undefined);
                return { response: null, retryable: true, reason: verdict.reason, retryAfterMs: verdict.retryAfterMs };
            }
            held += block;
            if (verdict.kind !== "hold") {
                // The rest of this batch goes to the tail guard; dropping it lost
                // deltas and response.completed whenever they shared a chunk.
                unparsed = blocks.slice(k + 1).join("") + unparsed;
                return open();
            }
        }
        if (total >= maxBytes)
            return open();
    }
}
