import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface RecapConfig {
  enabled: boolean;
  idleMs: number;
  minTurns: number;
  recentMessages: number;
  maxChars: number;
  maxInputChars: number;
  maxOutputTokens: number;
  timeoutMs: number;
  provider: string;
  model: string;
  reasoningEffort: string;
}

export const DEFAULT_CONFIG: RecapConfig = {
  enabled: true,
  idleMs: 180_000,
  minTurns: 3,
  recentMessages: 30,
  maxChars: 400,
  maxInputChars: 24_000,
  maxOutputTokens: 512,
  timeoutMs: 30_000,
  provider: "",
  model: "",
  reasoningEffort: "",
};

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-recap.json");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

export function parseConfig(raw: unknown): RecapConfig {
  if (!isRecord(raw)) return { ...DEFAULT_CONFIG };
  return {
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : DEFAULT_CONFIG.enabled,
    idleMs: numberValue(raw.idleMs, DEFAULT_CONFIG.idleMs, 1_000, 2_147_483_647),
    minTurns: numberValue(raw.minTurns, DEFAULT_CONFIG.minTurns, 1, 1_000),
    recentMessages: numberValue(raw.recentMessages, DEFAULT_CONFIG.recentMessages, 1, 200),
    maxChars: numberValue(raw.maxChars, DEFAULT_CONFIG.maxChars, 80, 400),
    maxInputChars: numberValue(raw.maxInputChars, DEFAULT_CONFIG.maxInputChars, 1_000, 200_000),
    maxOutputTokens: numberValue(raw.maxOutputTokens, DEFAULT_CONFIG.maxOutputTokens, 16, 4_096),
    timeoutMs: numberValue(raw.timeoutMs, DEFAULT_CONFIG.timeoutMs, 1_000, 2_147_483_647),
    provider: stringValue(raw.provider, DEFAULT_CONFIG.provider),
    model: stringValue(raw.model, DEFAULT_CONFIG.model),
    reasoningEffort: stringValue(raw.reasoningEffort, DEFAULT_CONFIG.reasoningEffort),
  };
}

export function loadConfig(path = CONFIG_PATH): RecapConfig {
  try {
    if (!existsSync(path)) return { ...DEFAULT_CONFIG };
    return parseConfig(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: RecapConfig, path = CONFIG_PATH): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    renameSync(temporary, path);
  } finally {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      // A successful rename leaves no temporary file; cleanup is best effort.
    }
  }
}
