import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AccountManager,
  createDefaultRefreshHandlers,
} from "../lib/core/accounts.js";
import {
  findLastIdcAccount,
  loadKiroIdcDefaults,
} from "../lib/providers/kiro/auth/idc-defaults.js";
import {
  beginIdcDeviceLogin,
  buildDeviceUrl,
  importAccountManagerExport,
  loginWithApiKey,
  normalizeStartUrl,
  validateAwsRegionInput,
} from "../lib/providers/kiro/auth/login.js";
import { normalizeCredentialCandidate } from "../lib/providers/kiro/auth/credentials-import.js";
import type { AccountOf } from "../lib/core/schemas.js";

describe("kiro login helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizeStartUrl forces /start path", () => {
    expect(normalizeStartUrl("https://acme.awsapps.com/start/#/")).toBe(
      "https://acme.awsapps.com/start",
    );
    expect(normalizeStartUrl("https://acme.awsapps.com/portal")).toBe(
      "https://acme.awsapps.com/portal/start",
    );
    expect(normalizeStartUrl("")).toBeUndefined();
    expect(normalizeStartUrl(undefined)).toBeUndefined();
  });

  it("buildDeviceUrl embeds user code hash route", () => {
    const url = buildDeviceUrl("https://acme.awsapps.com/start", "ABCD-EFGH");
    expect(url).toContain("https://acme.awsapps.com/start/");
    expect(url).toContain("#/device?user_code=ABCD-EFGH");
  });

  it("validateAwsRegionInput rejects unknown regions", () => {
    expect(validateAwsRegionInput("")).toBeUndefined();
    expect(validateAwsRegionInput("us-east-1")).toBeUndefined();
    expect(validateAwsRegionInput("not-a-region")).toMatch(/valid AWS region/i);
  });

  it("loginWithApiKey builds api-key candidate", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("nope", { status: 404 })),
    );
    const key = `ksk_${"a".repeat(24)}`;
    const account = await loginWithApiKey(key, "eu-central-1");
    expect(account.provider).toBe("kiro");
    expect(account.authMethod).toBe("api-key");
    expect(account.region).toBe("eu-central-1");
    expect(account.refreshToken).toBe(key);
    expect(account.accessToken).toBe(key);
  });

  it("rejects social auth methods on credentials import", async () => {
    await expect(
      normalizeCredentialCandidate({
        refreshToken: "rt",
        authMethod: "google",
      }),
    ).rejects.toThrow(/social login/i);
  });

  it("flattens nested credentials and maps builder-id → idc", async () => {
    const candidate = await normalizeCredentialCandidate(
      {
        credentials: {
          refreshToken: "rt-token",
          clientId: "cid",
          clientSecret: "csec",
          authMethod: "builder-id",
        },
        region: "us-west-2",
        email: "user@example.com",
      },
      { validateRefresh: false },
    );
    expect(candidate.authMethod).toBe("idc");
    expect(candidate.refreshToken).toBe("rt-token");
    expect(candidate.clientId).toBe("cid");
    expect(candidate.clientSecret).toBe("csec");
    expect(candidate.email).toBe("user@example.com");
    expect(candidate.region).toBe("us-west-2");
  });

  it("importAccountManagerExport reads accounts[].credentials", async () => {
    const accounts = await importAccountManagerExport(
      JSON.stringify({
        accounts: [
          {
            email: "a@example.com",
            credentials: {
              refreshToken: "rt1",
              clientId: "c1",
              clientSecret: "s1",
              authMethod: "idc",
              region: "us-east-1",
            },
          },
          {
            credentials: {
              refreshToken: `ksk_${"b".repeat(24)}`,
              authMethod: "api-key",
              region: "eu-central-1",
            },
          },
        ],
      }),
      { validateRefresh: false, enrich: false },
    );
    expect(accounts).toHaveLength(2);
    expect(accounts[0]!.authMethod).toBe("idc");
    expect(accounts[0]!.email).toBe("a@example.com");
    expect(accounts[1]!.authMethod).toBe("api-key");
    expect(accounts[1]!.region).toBe("eu-central-1");
  });

  it("findLastIdcAccount prefers most recently used IDC with startUrl", () => {
    const base = {
      provider: "kiro" as const,
      tags: [],
      refreshToken: "rt",
      accessToken: "at",
      enabled: true,
      priority: 0,
      addedAt: 1,
      lastSwitchReason: "initial" as const,
      subscriptionStatus: "active" as const,
      flaggedForRemoval: false,
      entitlementBlocked: false,
      authMethod: "idc" as const,
      region: "us-east-1" as const,
      credentialSource: "login" as const,
    };
    const older: AccountOf<"kiro"> = {
      ...base,
      accountId: "old",
      email: "old@ex.com",
      lastUsed: 10,
      startUrl: "https://old.awsapps.com/start",
    };
    const newer: AccountOf<"kiro"> = {
      ...base,
      accountId: "new",
      email: "new@ex.com",
      lastUsed: 99,
      startUrl: "https://new.awsapps.com/start",
      oidcRegion: "eu-central-1",
      profileArn:
        "arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABC",
    };
    const picked = findLastIdcAccount([older, newer]);
    expect(picked?.accountId).toBe("new");
    expect(picked?.startUrl).toContain("new.awsapps.com");
  });

  it("loadKiroIdcDefaults reads multi-ai-settings kiro section", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kiro-idc-cfg-"));
    const settingsPath = path.join(dir, "settings.json");
    await writeFile(
      settingsPath,
      JSON.stringify({
        kiro: {
          idcStartUrl: "https://acme.awsapps.com/start",
          idcRegion: "eu-west-1",
          idcProfileArn:
            "arn:aws:codewhisperer:eu-west-1:123456789012:profile/XYZ",
          defaultRegion: "eu-west-1",
        },
      }),
    );
    const prev = process.env.MULTI_AI_SETTINGS_PATH;
    process.env.MULTI_AI_SETTINGS_PATH = settingsPath;
    try {
      const defaults = loadKiroIdcDefaults();
      expect(defaults.startUrl).toBe("https://acme.awsapps.com/start");
      expect(defaults.idcRegion).toBe("eu-west-1");
      expect(defaults.profileArn).toContain("profile/XYZ");
      expect(defaults.defaultRegion).toBe("eu-west-1");
    } finally {
      if (prev === undefined) delete process.env.MULTI_AI_SETTINGS_PATH;
      else process.env.MULTI_AI_SETTINGS_PATH = prev;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("beginIdcDeviceLogin reuses saved IDC portal when prompts empty", async () => {
    const registerCalls: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const href = String(url);
        if (href.includes("/client/register")) {
          return new Response(
            JSON.stringify({ clientId: "cid", clientSecret: "csec" }),
            { status: 200 },
          );
        }
        if (href.includes("/device_authorization")) {
          registerCalls.push(JSON.parse(String(init?.body ?? "{}")));
          return new Response(
            JSON.stringify({
              verificationUri: "https://device.example/verify",
              verificationUriComplete: "https://device.example/verify?user_code=AB",
              userCode: "AB-CD",
              deviceCode: "dev",
              interval: 1,
              expiresIn: 600,
            }),
            { status: 200 },
          );
        }
        return new Response("nope", { status: 404 });
      }),
    );

    const saved: AccountOf<"kiro"> = {
      provider: "kiro",
      accountId: "saved",
      email: "saved@ex.com",
      tags: [],
      refreshToken: "rt",
      accessToken: "at",
      enabled: true,
      priority: 0,
      addedAt: 1,
      lastUsed: 50,
      lastSwitchReason: "initial",
      subscriptionStatus: "active",
      flaggedForRemoval: false,
      entitlementBlocked: false,
      authMethod: "idc",
      region: "eu-central-1",
      oidcRegion: "eu-central-1",
      startUrl: "https://corp.awsapps.com/start",
      profileArn:
        "arn:aws:codewhisperer:eu-central-1:123456789012:profile/SAVED",
      credentialSource: "login",
    };

    const session = await beginIdcDeviceLogin({
      openBrowser: false,
      reuseSavedIdc: true,
      existingAccounts: [saved],
    });
    expect(session.hasCustomStartUrl).toBe(true);
    expect(session.startUrl).toContain("corp.awsapps.com");
    expect(session.oidcRegion).toBe("eu-central-1");
    expect(session.profileArn).toContain("profile/SAVED");
    expect(session.verificationUrl).toContain("#/device?user_code=");
    expect(registerCalls[0]).toEqual(
      expect.objectContaining({
        startUrl: "https://corp.awsapps.com/start",
      }),
    );
  });
});

describe("kiro plugin auth methods", () => {
  let dir: string;
  let store: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "kiro-auth-"));
    store = path.join(dir, "accounts.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("registers seven OpenCode auth methods (kiro-auth five + kiro-cli + legacy-db)", async () => {
    const {
      getAccountManager,
      resetAccountManager,
    } = await import("../lib/core/accounts.js");
    resetAccountManager();
    const singleton = getAccountManager(store);
    await singleton.load();
    try {
      const mod = await import("../lib/plugin/kiro.js");
      const hooks = await mod.default.server({
        client: {} as never,
        project: {} as never,
        directory: process.cwd(),
        worktree: process.cwd(),
        experimental_workspace: { register() {} },
        serverUrl: new URL("http://127.0.0.1:0"),
        $: {} as never,
      });
      expect(hooks.auth?.provider).toBe("kiro-multi");
      const methods = hooks.auth?.methods ?? [];
      expect(methods).toHaveLength(7);
      const labels = methods.map((m) => m.label);
      expect(labels).toEqual([
        "Kiro API Key",
        "AWS Builder ID / IAM Identity Center",
        "IAM Identity Center with Profile ARN",
        "Import account from credentials JSON",
        "Import accounts from Kiro Account Manager export",
        "Import from kiro-cli DB",
        "Import from legacy kiro.db",
      ]);
      expect(methods.filter((m) => m.type === "api")).toHaveLength(5);
      expect(methods.filter((m) => m.type === "oauth")).toHaveLength(2);

      const api = methods.find((m) => m.label === "Kiro API Key");
      expect(api?.type).toBe("api");
      if (api?.type === "api") {
        vi.stubGlobal(
          "fetch",
          vi.fn(async () =>
            new Response(
              JSON.stringify({
                usageBreakdownList: [{ currentUsage: 1, usageLimit: 100 }],
                userInfo: { email: "plugin-api@example.com" },
                subscriptionInfo: { subscriptionTitle: "KIRO PRO" },
              }),
              { status: 200 },
            ),
          ),
        );
        const key = `ksk_${"c".repeat(24)}`;
        const result = await api.authorize?.({
          api_key: key,
          region: "us-east-1",
        });
        expect(result).toEqual(
          expect.objectContaining({
            type: "success",
            provider: "kiro-multi",
          }),
        );
        const kiroAccounts = singleton.list("kiro");
        expect(kiroAccounts.length).toBeGreaterThanOrEqual(1);
        const first = kiroAccounts[0]!;
        expect(first.provider).toBe("kiro");
        if (first.provider === "kiro") {
          expect(first.authMethod).toBe("api-key");
          expect(first.email).toBe("plugin-api@example.com");
          expect(first.usedCount).toBe(1);
          expect(first.limitCount).toBe(100);
        }
      }
    } finally {
      resetAccountManager();
    }
  });
});
