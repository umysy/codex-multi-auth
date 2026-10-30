// Live quota from the headers of real /responses traffic.
//
// Upstream sends x-codex-primary-* / x-codex-secondary-* on every response, but the
// router keeps them in memory only; quota-cache.json changes only when someone runs
// `limits --refresh`, and each of those sends a real "quota ping" request per account.
// Writing what normal traffic already reports lets the panel show the in-use
// account's quota within seconds, at no extra quota cost.
import { promises as fsp } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

function numberHeader(headers, name) {
    const raw = headers?.get?.(name);
    if (raw === null || raw === undefined || String(raw).trim() === "")
        return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
}

function resetAtMs(headers, prefix, now) {
    const after = numberHeader(headers, `${prefix}-reset-after-seconds`);
    if (after !== undefined && after > 0)
        return now + Math.round(after * 1000);
    const at = numberHeader(headers, `${prefix}-reset-at`);
    if (at !== undefined && at > 0)
        return at < 10_000_000_000 ? at * 1000 : at;
    return undefined;
}

function windowOf(headers, prefix, now) {
    return {
        usedPercent: numberHeader(headers, `${prefix}-used-percent`),
        windowMinutes: numberHeader(headers, `${prefix}-window-minutes`),
        resetAtMs: resetAtMs(headers, prefix, now),
    };
}

/** Headers → quota-cache-shaped snapshot, or null when the response carries no quota. */
export function readQuotaHeaders(headers, status, now = Date.now()) {
    const primary = windowOf(headers, "x-codex-primary", now);
    const secondary = windowOf(headers, "x-codex-secondary", now);
    if (primary.usedPercent === undefined && secondary.usedPercent === undefined)
        return null;
    const plan = headers?.get?.("x-codex-plan-type");
    return {
        status,
        ...(plan && String(plan).trim() ? { planType: String(plan).trim() } : {}),
        primary,
        secondary,
        updatedAt: now,
    };
}

export function defaultLiveQuotaFile(env = process.env) {
    const dir = (env.CODEX_MULTI_AUTH_DIR ?? "").trim()
        || join((env.CODEX_HOME ?? "").trim() || join(homedir(), ".codex"), "multi-auth");
    return join(dir, "live-quota.json");
}

/**
 * Coalescing writer: one write in flight, later observations overwrite earlier ones.
 * Never throws: a failed write must not affect the request that reported the quota.
 */
export function createLiveQuotaRecorder({ file = defaultLiveQuotaFile(), now = () => Date.now() } = {}) {
    const pending = new Map();
    let data = null;
    let writing = null;
    const load = async () => {
        try {
            const parsed = JSON.parse(await fsp.readFile(file, "utf8"));
            if (parsed && typeof parsed === "object" && parsed.byAccountId && typeof parsed.byAccountId === "object")
                return parsed;
        }
        catch { /* missing or unreadable: start fresh */ }
        return { version: 1, byAccountId: {} };
    };
    const flush = async () => {
        while (pending.size) {
            const batch = [...pending];
            pending.clear();
            data ??= await load();
            for (const [accountId, snapshot] of batch)
                data.byAccountId[accountId] = snapshot;
            data.updatedAt = now();
            const tmp = `${file}.${process.pid}.tmp`;
            try {
                await fsp.mkdir(dirname(file), { recursive: true });
                await fsp.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
                await fsp.rename(tmp, file);
            }
            catch {
                // A reader holding the file on Windows makes rename fail; the next
                // observation rewrites everything we know.
                await fsp.rm(tmp, { force: true }).catch(() => undefined);
            }
        }
    };
    const kick = () => {
        // An observation that lands after flush() saw an empty queue starts the next round.
        writing ??= flush().catch(() => undefined).finally(() => {
            writing = null;
            if (pending.size)
                kick();
        });
        return writing;
    };
    return {
        record(accountId, headers, status) {
            if (typeof accountId !== "string" || !accountId)
                return Promise.resolve();
            const snapshot = readQuotaHeaders(headers, status, now());
            if (!snapshot)
                return Promise.resolve();
            pending.set(accountId, snapshot);
            return kick();
        },
    };
}

let defaultRecorder = null;
export function recordLiveQuota(accountId, headers, status) {
    if (process.env.CODEX_MULTI_AUTH_LIVE_QUOTA === "0")
        return Promise.resolve();
    defaultRecorder ??= createLiveQuotaRecorder();
    return defaultRecorder.record(accountId, headers, status);
}
