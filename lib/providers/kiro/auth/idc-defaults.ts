import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountOf } from "../../../core/schemas.js";
import {
  isValidKiroRegion,
  KIRO_DEFAULT_REGION,
  normalizeKiroRegion,
  type KiroRegion,
} from "../constants.js";
import {
  defaultKiroCliDbPath,
  readActiveProfileArnFromKiroCli,
} from "./kiro-cli-import.js";

export type KiroIdcDefaults = {
  startUrl?: string;
  idcRegion?: string;
  profileArn?: string;
  defaultRegion: KiroRegion;
};

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readJsonFile(filePath: string): JsonRecord | undefined {
  try {
    if (!fs.existsSync(filePath)) return undefined;
    return asRecord(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return undefined;
  }
}

function defaultMultiAiSettingsPath(): string {
  const override = process.env.MULTI_AI_SETTINGS_PATH?.trim();
  if (override) return override;
  return path.join(
    os.homedir(),
    ".config",
    "opencode",
    "multi-ai-settings.json",
  );
}

function defaultLegacyKiroConfigPath(): string {
  return path.join(os.homedir(), ".config", "opencode", "kiro.json");
}

function pickString(
  sources: ReadonlyArray<JsonRecord | undefined>,
  keys: readonly string[],
): string | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = optionalString(source[key]);
      if (value) return value;
    }
  }
  return undefined;
}

/**
 * Defaults for IDC device login, matching opencode-kiro-auth resolution order:
 * env → multi-ai-settings.json → legacy kiro.json → built-in defaults.
 */
export function loadKiroIdcDefaults(): KiroIdcDefaults {
  const settings = readJsonFile(defaultMultiAiSettingsPath());
  const kiroSection = asRecord(settings?.kiro);
  const legacy = readJsonFile(defaultLegacyKiroConfigPath());
  const sources = [kiroSection, settings, legacy];

  const startUrl =
    optionalString(process.env.MULTI_AI_KIRO_IDC_START_URL) ??
    pickString(sources, ["idcStartUrl", "idc_start_url"]);

  const idcRegionRaw =
    optionalString(process.env.MULTI_AI_KIRO_IDC_REGION) ??
    pickString(sources, ["idcRegion", "idc_region"]);

  const profileArn =
    optionalString(process.env.MULTI_AI_KIRO_IDC_PROFILE_ARN) ??
    pickString(sources, ["idcProfileArn", "idc_profile_arn"]);

  const defaultRegionRaw =
    optionalString(process.env.MULTI_AI_KIRO_DEFAULT_REGION) ??
    pickString(sources, ["defaultRegion", "default_region"]);

  const idcRegion =
    idcRegionRaw && isValidKiroRegion(idcRegionRaw.trim())
      ? idcRegionRaw.trim()
      : undefined;

  return {
    startUrl,
    idcRegion,
    profileArn,
    defaultRegion: normalizeKiroRegion(defaultRegionRaw),
  };
}

/** Most recently used healthy IDC account that still has a custom start URL. */
export function findLastIdcAccount(
  accounts: ReadonlyArray<AccountOf<"kiro">>,
): AccountOf<"kiro"> | undefined {
  const idc = accounts.filter(
    (a) =>
      a.provider === "kiro" &&
      a.authMethod === "idc" &&
      typeof a.startUrl === "string" &&
      a.startUrl.length > 0 &&
      a.subscriptionStatus !== "dead" &&
      !a.flaggedForRemoval,
  );
  if (idc.length === 0) return undefined;
  return [...idc].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))[0];
}

export async function resolveIdcProfileArn(explicit?: string): Promise<
  string | undefined
> {
  const trimmed = explicit?.trim();
  if (trimmed) return trimmed;
  const defaults = loadKiroIdcDefaults();
  if (defaults.profileArn) return defaults.profileArn;
  try {
    return await readActiveProfileArnFromKiroCli(defaultKiroCliDbPath());
  } catch {
    return undefined;
  }
}

export { KIRO_DEFAULT_REGION };
