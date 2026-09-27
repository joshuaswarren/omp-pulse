import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Surface = "status" | "widget" | "both";
export type Placement = "aboveEditor" | "belowEditor";

export type ProviderConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  timeoutMs: number;
};

export type PulseConfig = {
  intervalMs: number;
  refreshWhileIdle: boolean;
  surface: Surface;
  placement: Placement;
  maxTranscriptChars: number;
  provider: ProviderConfig;
};

export const DEFAULT_CONFIG_PATH = join(homedir(), ".omp", "agent", "omp-pulse", "config.json");

const MIN_INTERVAL_MS = 60_000;
const MAX_INTERVAL_MS = 30 * 60_000;
const DEFAULT_INTERVAL_MS = 7 * 60_000;

export function loadConfig(options?: { configPath?: string; env?: NodeJS.ProcessEnv }): PulseConfig {
  const env = options?.env ?? process.env;
  const file = readConfigFile(options?.configPath ?? DEFAULT_CONFIG_PATH);
  const providerFile = isRecord(file.provider) ? file.provider : {};

  return {
    intervalMs: clamp(numberFrom(env.OMP_PULSE_INTERVAL_MS, file.intervalMs, DEFAULT_INTERVAL_MS), MIN_INTERVAL_MS, MAX_INTERVAL_MS),
    refreshWhileIdle: boolFrom(env.OMP_PULSE_IDLE, file.refreshWhileIdle, false),
    surface: surfaceFrom(env.OMP_PULSE_SURFACE, file.surface),
    placement: placementFrom(env.OMP_PULSE_PLACEMENT, file.placement),
    maxTranscriptChars: clamp(numberFrom(env.OMP_PULSE_MAX_CHARS, file.maxTranscriptChars, 8_000), 500, 32_000),
    provider: {
      baseUrl: stripSlash(stringFrom(env.OMP_PULSE_BASE_URL, providerFile.baseUrl, "http://127.0.0.1:11434/v1")),
      model: stringFrom(env.OMP_PULSE_MODEL, providerFile.model, "qwen2.5:0.5b"),
      apiKey: stringFrom(env.OMP_PULSE_API_KEY, providerFile.apiKey, ""),
      timeoutMs: clamp(numberFrom(env.OMP_PULSE_TIMEOUT_MS, providerFile.timeoutMs, 15_000), 1_000, 60_000),
    },
  };
}

function readConfigFile(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringFrom(envValue: string | undefined, fileValue: unknown, fallback: string): string {
  if (typeof envValue === "string" && envValue.trim() !== "") return envValue.trim();
  if (typeof fileValue === "string" && fileValue.trim() !== "") return fileValue.trim();
  return fallback;
}

function numberFrom(envValue: string | undefined, fileValue: unknown, fallback: number): number {
  if (typeof envValue === "string" && envValue.trim() !== "") {
    const parsed = Number(envValue);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof fileValue === "number" && Number.isFinite(fileValue)) return fileValue;
  return fallback;
}

function boolFrom(envValue: string | undefined, fileValue: unknown, fallback: boolean): boolean {
  if (typeof envValue === "string" && envValue.trim() !== "") {
    const token = envValue.trim().toLowerCase();
    if (token === "1" || token === "true") return true;
    if (token === "0" || token === "false") return false;
  }
  if (typeof fileValue === "boolean") return fileValue;
  return fallback;
}

function surfaceFrom(envValue: string | undefined, fileValue: unknown): Surface {
  const token = stringFrom(envValue, fileValue, "widget");
  if (token === "status" || token === "widget" || token === "both") return token;
  return "widget";
}

function placementFrom(envValue: string | undefined, fileValue: unknown): Placement {
  const token = stringFrom(envValue, fileValue, "belowEditor");
  if (token === "aboveEditor" || token === "belowEditor") return token;
  return "belowEditor";
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
