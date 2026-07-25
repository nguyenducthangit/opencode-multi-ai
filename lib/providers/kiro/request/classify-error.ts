import type { Classification } from "../../../core/adapter.js";

/**
 * Subscription / plan usage cap (RECOVERABLE — rotate to a sibling, bench with
 * `quotaResetAt`). Anchored on explicit cap phrasing so it does NOT match a
 * throttling `ThrottlingException` whose message merely contains "rate limit".
 * The bare word "limit" is intentionally excluded (it collides with the
 * per-request throttle copy AWS returns on a transient 429).
 */
const QUOTA_EXHAUSTED_RE =
  /monthly\s+request\s+limit|monthly\s+limit|usage\s+limit|quota|out\s+of\s+(?:free\s+)?credits?|free\s*tier|subscription\s+limit|improvement\s+quota|MonthlyRequestLimit/i;

/**
 * Per-request throttle (NOT a subscription cap). KEEP the account and back off
 * briefly. AWS CodeWhisperer surfaces these as `ThrottlingException` (HTTP 429)
 * with messages like "Too many requests" / "rate exceeded".
 */
const THROTTLE_RE = /throttl|rate\s*(?:limit|exceeded)|too\s+many\s+requests/i;

export function classifyKiroSdkError(err: unknown): Classification {
  if (err && typeof err === "object") {
    const e = err as {
      name?: string;
      message?: string;
      $metadata?: { httpStatusCode?: number };
      Code?: string;
      code?: string;
    };
    if (e.name === "AbortError") {
      return { kind: "unknown-client-error", status: 499 };
    }
    const status = e.$metadata?.httpStatusCode;
    const message = `${e.message ?? ""} ${e.Code ?? ""} ${e.code ?? ""} ${e.name ?? ""}`;
    if (status === 400) {
      return { kind: "unknown-client-error", status: 400 };
    }
    if (status === 401) {
      return { kind: "auth-dead" };
    }
    if (status === 403) {
      return { kind: "entitlement-blocked" };
    }
    // Explicit subscription/usage cap wins over the transient path (mirrors the
    // Codex classifier: usage_limit is checked before a bare 429). A 402, or a
    // message carrying a genuine cap phrase, benches the account with a reset.
    if (status === 402 || QUOTA_EXHAUSTED_RE.test(message)) {
      return { kind: "quota-exhausted" };
    }
    // A throttling 429 (or throttle-worded error without a cap phrase) is
    // transient: keep the account, short cooldown, rotate. Must run AFTER the
    // quota check so a real cap is not demoted to a 5s retry, and BEFORE any
    // message heuristics so a normal throttle is never mistaken for a cap.
    if (status === 429 || THROTTLE_RE.test(message)) {
      return { kind: "transient", retryAfterMs: 5_000 };
    }
    if (typeof status === "number" && status >= 500) {
      return { kind: "server" };
    }
    if (
      /timeout|ECONNRESET|ENOTFOUND|network|fetch failed/i.test(message) ||
      e.name === "TimeoutError"
    ) {
      return { kind: "network" };
    }
    if (typeof status === "number" && status >= 400) {
      return { kind: "unknown-client-error", status };
    }
  }
  return { kind: "network" };
}
