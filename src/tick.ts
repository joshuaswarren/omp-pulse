import type { PulseConfig } from "./config.ts";
import { isTooLongForStrip, preferredBodyBudget, statusLine, type StripOptions } from "./chrome.ts";
import { summarize, type PulseModelHost, type SmolComplete } from "./summarize.ts";
import { echoesLatestAction, echoesLatestClause, echoesUserRequest, extractiveSummary, isRejectedStatus, isVagueStatus, recentTranscript } from "./transcript.ts";

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

function retryNote(bodyChars: number): string {
  return [
    "Rejected as vague.",
    "State what is done, what is in flight, and what is next.",
    "Do not answer Running checks, Running tests, Running todo, Working, Processing, Thinking, Updating, Busy, Loading, In progress, or Doing stuff.",
    "Do not start with Yes, No, Sure, or Okay.",
    "Do not stop mid-word, mid-phrase, or on a dash.",
    "Do not return an unfinished clause or a cut-off transcript fragment.",
    "Rewrite one finished whole-turn rollup.",
    "Do not give advice or restate draft content about the topic.",
    "Do not repeat only the latest decision or the latest assistant sentence.",
    "Roll up the whole turn: goal, phase, done, in flight, and next.",
    `Shorter: at most ${bodyChars} characters. No ellipsis.`,
  ].join(" ");
}

function unusable(text: string, entries: unknown, strip: StripOptions): boolean {
  return (
    isVagueStatus(text) ||
    isRejectedStatus(text) ||
    echoesUserRequest(text, entries) ||
    echoesLatestAction(text, entries) ||
    echoesLatestClause(text, entries) ||
    isTooLongForStrip(text, strip)
  );
}

export async function runTick(input: {
  phase: Phase;
  config: PulseConfig;
  entries: unknown;
  previousFingerprint: string;
  force: boolean;
  host?: PulseModelHost;
  fetchImpl?: typeof fetch;
  completeImpl?: SmolComplete;
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

  const strip: StripOptions = { showVersion: input.config.showVersion };
  const bodyChars = preferredBodyBudget(strip);
  const extracted = extractiveSummary(input.entries);
  const concrete = extracted && !isVagueStatus(extracted) ? extracted : "";
  let summary = await summarize({
    transcript: tail.text,
    fallback: concrete || "idle",
    provider: input.config.provider,
    host: input.host,
    fetchImpl: input.fetchImpl,
    completeImpl: input.completeImpl,
    bodyChars,
  });
  if (summary.source === "model" && unusable(summary.text, input.entries, strip)) {
    if (concrete) {
      summary = { text: concrete, source: "extract" };
    } else {
      const retry = await summarize({
        transcript: `${tail.text}\n\n${retryNote(bodyChars)}`,
        fallback: "idle",
        provider: input.config.provider,
        host: input.host,
        fetchImpl: input.fetchImpl,
        completeImpl: input.completeImpl,
        bodyChars,
      });
      summary =
        retry.source === "model" && !unusable(retry.text, input.entries, strip)
          ? retry
          : { text: "", source: "extract" };
    }
  } else if (summary.source === "extract" && !concrete && input.phase === "inTurn") {
    summary = { text: "", source: "extract" };
  }
  if (!summary.text || isVagueStatus(summary.text)) {
    if (concrete) summary = { text: concrete, source: "extract" };
    else if (input.phase === "idle") summary = { text: "idle", source: "extract" };
    else return { action: "skip" };
  }
  return {
    action: "paint",
    line: statusLine(summary.text, strip),
    fingerprint: summary.source === "model" ? tail.fingerprint : input.previousFingerprint,
    source: summary.source,
  };
}
