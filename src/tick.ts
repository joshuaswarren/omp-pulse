import type { PulseConfig } from "./config.ts";
import { statusLine } from "./chrome.ts";
import { summarize } from "./summarize.ts";
import { extractiveSummary, recentTranscript } from "./transcript.ts";

export type Phase = "idle" | "inTurn";

export function decideRefresh(input: {
  phase: Phase;
  refreshWhileIdle: boolean;
  previousFingerprint: string;
  nextFingerprint: string;
  force: boolean;
}): "model" | "skip" {
  if (!input.nextFingerprint) return "skip";
  if (input.force) return "model";
  if (input.phase === "idle" && !input.refreshWhileIdle) return "skip";
  if (input.nextFingerprint === input.previousFingerprint) return "skip";
  return "model";
}

export type TickResult =
  | { action: "skip" }
  | { action: "paint"; line: string; fingerprint: string; source: "model" | "extract" };

export async function runTick(input: {
  phase: Phase;
  config: PulseConfig;
  entries: unknown;
  previousFingerprint: string;
  force: boolean;
  fetchImpl?: typeof fetch;
}): Promise<TickResult> {
  const tail = recentTranscript(input.entries, input.config.maxTranscriptChars);
  const decision = decideRefresh({
    phase: input.phase,
    refreshWhileIdle: input.config.refreshWhileIdle,
    previousFingerprint: input.previousFingerprint,
    nextFingerprint: tail.fingerprint,
    force: input.force,
  });
  if (decision === "skip") return { action: "skip" };

  const fallback = extractiveSummary(input.entries) || (input.phase === "inTurn" ? "working" : "idle");
  const summary = await summarize({
    transcript: tail.text,
    fallback,
    provider: input.config.provider,
    fetchImpl: input.fetchImpl,
  });
  return {
    action: "paint",
    line: statusLine(summary.text),
    fingerprint: summary.source === "model" ? tail.fingerprint : input.previousFingerprint,
    source: summary.source,
  };
}
