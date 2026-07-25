import { createHash } from "node:crypto";

import type { AccountOf } from "../../../core/schemas.js";
import { fetchKiroUsageLimits } from "../request/usage.js";
import { KiroInvalidGrantError, refreshKiroAccount } from "./refresh.js";

export type KiroCandidate = AccountOf<"kiro">;

const PLACEHOLDER_EMAIL = /^(idc|desktop|external-idp|api-key)@kiro\.local$/;

/** Refresh a token that expires within this window before probing. */
const REFRESH_SKEW_MS = 60_000;

/**
 * Stable account identity for the Kiro pool.
 *
 * `fallbackSeed` is hashed (never stored or logged) so credentials without a
 * real email — e.g. kiro-cli desktop/social tokens — do not all collapse onto
 * the same `accountId`.
 */
export function kiroAccountIdentity(
  email: string,
  method: string,
  clientId?: string,
  profileArn?: string,
  fallbackSeed?: string,
): string {
  const base = `${email}:${method}:${clientId ?? ""}:${profileArn ?? ""}`;
  return createHash("sha256")
    .update(fallbackSeed ? `${base}:${fallbackSeed}` : base)
    .digest("hex")
    .slice(0, 24);
}

/** Best-effort email claim from a JWT access token (`email`, then `sub`). */
export function emailFromAccessToken(
  accessToken: string | undefined,
): string | undefined {
  if (!accessToken) return undefined;
  try {
    const parts = accessToken.split(".");
    if (parts.length !== 3 || !parts[1]) return undefined;
    const payload = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    if (typeof payload.email === "string" && payload.email) return payload.email;
    if (typeof payload.sub === "string" && payload.sub) return payload.sub;
  } catch {
    return undefined;
  }
  return undefined;
}

/** True when the email is missing or a `<method>@kiro.local` stand-in. */
export function isPlaceholderKiroEmail(email: string | undefined): boolean {
  if (email === undefined) return true;
  return PLACEHOLDER_EMAIL.test(email);
}

export type KiroEnrichOptions = {
  /** Never recompute `accountId` (callers with an externally owned id). */
  preserveAccountId?: boolean;
};

export type KiroEnrichResult = {
  candidate: KiroCandidate;
  warnings: string[];
};

export type KiroEnricher = (
  candidate: KiroCandidate,
  options?: KiroEnrichOptions,
) => Promise<KiroEnrichResult>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function needsRefresh(candidate: KiroCandidate): boolean {
  if (candidate.authMethod === "api-key") return false;
  return (
    !candidate.accessToken ||
    candidate.expiresAt === undefined ||
    candidate.expiresAt <= Date.now() + REFRESH_SKEW_MS
  );
}

/**
 * Fill in email / usage counters / label for a freshly imported candidate.
 *
 * Best-effort and non-throwing: any failure becomes a warning and the caller
 * still receives a usable candidate. Never logs or echoes token values.
 */
export const enrichKiroCandidate: KiroEnricher = async (
  candidate,
  options,
) => {
  const warnings: string[] = [];
  let next: KiroCandidate = { ...candidate };

  if (needsRefresh(next)) {
    try {
      const tokens = await refreshKiroAccount(next);
      next = {
        ...next,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? next.refreshToken,
        expiresAt: tokens.expiresAt,
      };
    } catch (error) {
      if (error instanceof KiroInvalidGrantError) {
        warnings.push("refresh token rejected; account may need re-login");
        return { candidate: next, warnings };
      }
      warnings.push(`refresh failed: ${errorMessage(error)}`);
      if (!next.accessToken) return { candidate: next, warnings };
    }
  }

  const accessToken = next.accessToken;
  if (!accessToken) return { candidate: next, warnings };

  let email = next.email;
  try {
    const snap = await fetchKiroUsageLimits(next, accessToken);
    if (snap.usedCount !== undefined) next.usedCount = snap.usedCount;
    if (snap.limitCount !== undefined) next.limitCount = snap.limitCount;
    if (snap.usedCount !== undefined || snap.limitCount !== undefined) {
      next.usageObservedAt = snap.observedAt;
    }
    const probed = snap.email?.trim();
    if (probed) email = probed;
    if (snap.subscriptionTitle && !next.label) {
      next.label = `Kiro · ${snap.subscriptionTitle}`;
    }
  } catch (error) {
    warnings.push(`usage probe failed: ${errorMessage(error)}`);
  }

  if (isPlaceholderKiroEmail(email)) {
    email = emailFromAccessToken(next.accessToken) ?? email;
  }

  if (email && email !== candidate.email) {
    next.email = email;
    if (options?.preserveAccountId !== true) {
      next.accountId = kiroAccountIdentity(
        email,
        next.authMethod,
        next.clientId,
        next.profileArn,
      );
    }
  }

  return { candidate: next, warnings };
};
