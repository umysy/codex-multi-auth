// Keep transport failures actionable without exposing URLs, tokens, or account data.
const CAUSE_CODES = new Set([
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENETUNREACH", "EHOSTUNREACH",
    "ENOTFOUND", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
]);

function causeOf(error) {
    let current = error;
    for (let i = 0; current && i < 4; i += 1) {
        if (current && typeof current === "object") {
            const code = typeof current.code === "string" ? current.code.toUpperCase() : "";
            if (code) return code;
            current = current.cause;
        } else break;
    }
    return "";
}

export function classifyUpstreamTransportError(error) {
    const message = error instanceof Error ? error.message : String(error ?? "");
    const lower = message.toLowerCase();
    if (lower.includes("timed out")) return "upstream-transport:timeout";
    const code = causeOf(error);
    if (CAUSE_CODES.has(code)) return `upstream-transport:${code.toLowerCase()}`;
    if (lower.includes("fetch failed")) return "upstream-transport:fetch-failed";
    return "upstream-transport:unknown";
}
