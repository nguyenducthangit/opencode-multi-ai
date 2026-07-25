import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccountOf } from "../lib/core/schemas.js";
import {
  emailFromAccessToken,
  enrichKiroCandidate,
  isPlaceholderKiroEmail,
  kiroAccountIdentity,
} from "../lib/providers/kiro/auth/enrich.js";

const HOUR = 3_600_000;

function baseCandidate(
  overrides: Partial<AccountOf<"kiro">> = {},
): AccountOf<"kiro"> {
  return {
    provider: "kiro",
    accountId: "seed-account-id",
    email: "desktop@kiro.local",
    tags: [],
    refreshToken: "rt-desktop",
    accessToken: "at-desktop",
    // Far enough out that the enricher never tries to refresh.
    expiresAt: Date.now() + HOUR,
    enabled: true,
    priority: 0,
    addedAt: Date.now(),
    lastUsed: 0,
    lastSwitchReason: "initial",
    subscriptionStatus: "active",
    flaggedForRemoval: false,
    entitlementBlocked: false,
    authMethod: "desktop",
    region: "us-east-1",
    credentialSource: "kiro-cli",
    ...overrides,
  };
}

function usageResponse(payload: Record<string, unknown>): Response {
  return new Response(JSON.stringify(payload), { status: 200 });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("kiroAccountIdentity", () => {
  it("is stable and 24 hex chars", () => {
    const a = kiroAccountIdentity("a@b.test", "idc", "cid", "arn:x");
    expect(a).toHaveLength(24);
    expect(a).toMatch(/^[0-9a-f]{24}$/);
    expect(kiroAccountIdentity("a@b.test", "idc", "cid", "arn:x")).toBe(a);
  });

  it("separates identical inputs by fallback seed", () => {
    const plain = kiroAccountIdentity("desktop@kiro.local", "desktop");
    const one = kiroAccountIdentity(
      "desktop@kiro.local",
      "desktop",
      undefined,
      undefined,
      "rt-one",
    );
    const two = kiroAccountIdentity(
      "desktop@kiro.local",
      "desktop",
      undefined,
      undefined,
      "rt-two",
    );
    expect(one).not.toBe(two);
    expect(one).not.toBe(plain);
    expect(one).not.toContain("rt-one");
  });
});

describe("emailFromAccessToken / isPlaceholderKiroEmail", () => {
  it("reads email then sub from a JWT payload", () => {
    const jwt = (payload: Record<string, unknown>) =>
      [
        Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
        Buffer.from(JSON.stringify(payload)).toString("base64url"),
        "sig",
      ].join(".");
    expect(emailFromAccessToken(jwt({ email: "jwt@example.test" }))).toBe(
      "jwt@example.test",
    );
    expect(emailFromAccessToken(jwt({ sub: "subject-id" }))).toBe("subject-id");
    expect(emailFromAccessToken("not-a-jwt")).toBeUndefined();
    expect(emailFromAccessToken(undefined)).toBeUndefined();
  });

  it("detects placeholder emails", () => {
    expect(isPlaceholderKiroEmail(undefined)).toBe(true);
    expect(isPlaceholderKiroEmail("desktop@kiro.local")).toBe(true);
    expect(isPlaceholderKiroEmail("idc@kiro.local")).toBe(true);
    expect(isPlaceholderKiroEmail("api-key@kiro.local")).toBe(true);
    expect(isPlaceholderKiroEmail("real@example.test")).toBe(false);
  });
});

describe("enrichKiroCandidate", () => {
  it("fills usage counters, email and label from the usage snapshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        usageResponse({
          usageBreakdownList: [{ currentUsage: 12, usageLimit: 200 }],
          userInfo: { email: "probed@example.test" },
          subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
        }),
      ),
    );

    const input = baseCandidate();
    const { candidate, warnings } = await enrichKiroCandidate(input);

    expect(warnings).toEqual([]);
    expect(candidate.usedCount).toBe(12);
    expect(candidate.limitCount).toBe(200);
    expect(candidate.usageObservedAt).toBeGreaterThan(0);
    expect(candidate.email).toBe("probed@example.test");
    expect(candidate.label).toBe("Kiro · KIRO PRO");
    // input is not mutated
    expect(input.email).toBe("desktop@kiro.local");
    expect(input.usedCount).toBeUndefined();
  });

  it("recomputes accountId when a real email replaces the placeholder", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        usageResponse({ userInfo: { email: "probed@example.test" } }),
      ),
    );

    const { candidate } = await enrichKiroCandidate(baseCandidate());

    expect(candidate.accountId).toBe(
      kiroAccountIdentity("probed@example.test", "desktop"),
    );
    expect(candidate.accountId).not.toBe("seed-account-id");
  });

  it("keeps the accountId when preserveAccountId is set", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        usageResponse({ userInfo: { email: "probed@example.test" } }),
      ),
    );

    const { candidate } = await enrichKiroCandidate(baseCandidate(), {
      preserveAccountId: true,
    });

    expect(candidate.accountId).toBe("seed-account-id");
    expect(candidate.email).toBe("probed@example.test");
  });

  it("warns and returns a usable candidate when the probe fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("boom", { status: 500 })),
    );

    const { candidate, warnings } = await enrichKiroCandidate(baseCandidate());

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/usage probe failed/i);
    expect(candidate.refreshToken).toBe("rt-desktop");
    expect(candidate.usedCount).toBeUndefined();
    expect(candidate.email).toBe("desktop@kiro.local");
  });

  it("never leaks token values into warnings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network unreachable");
      }),
    );

    const candidateIn = baseCandidate({
      accessToken: "super-secret-access",
      refreshToken: "super-secret-refresh",
    });
    const { warnings } = await enrichKiroCandidate(candidateIn);

    const joined = warnings.join("\n");
    expect(joined).not.toContain("super-secret-access");
    expect(joined).not.toContain("super-secret-refresh");
  });

  it("refreshes an expired token before probing", async () => {
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/refreshToken")) {
        return new Response(
          JSON.stringify({
            accessToken: "fresh-access",
            refreshToken: "fresh-refresh",
            expiresIn: 3600,
          }),
          { status: 200 },
        );
      }
      return usageResponse({
        usageBreakdownList: [{ currentUsage: 1, usageLimit: 10 }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { candidate, warnings } = await enrichKiroCandidate(
      baseCandidate({ accessToken: undefined, expiresAt: undefined }),
    );

    expect(warnings).toEqual([]);
    expect(candidate.accessToken).toBe("fresh-access");
    expect(candidate.refreshToken).toBe("fresh-refresh");
    expect(candidate.usedCount).toBe(1);
    expect(candidate.limitCount).toBe(10);
  });

  it("stops after an invalid_grant refresh without probing", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { candidate, warnings } = await enrichKiroCandidate(
      baseCandidate({ accessToken: undefined, expiresAt: undefined }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual([
      "refresh token rejected; account may need re-login",
    ]);
    expect(candidate.usedCount).toBeUndefined();
  });

  it("does not refresh api-key candidates", async () => {
    const urls: string[] = [];
    const fetchMock = vi.fn(async (input: unknown) => {
      urls.push(String(input));
      return usageResponse({
        usageBreakdownList: [{ currentUsage: 3, usageLimit: 30 }],
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const key = `ksk_${"a".repeat(24)}`;
    const { candidate, warnings } = await enrichKiroCandidate(
      baseCandidate({
        authMethod: "api-key",
        email: "api-key@kiro.local",
        refreshToken: key,
        accessToken: key,
        expiresAt: undefined,
      }),
    );

    expect(warnings).toEqual([]);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.some((url) => url.includes("/refreshToken"))).toBe(false);
    expect(candidate.usedCount).toBe(3);
  });
});
