import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isTooLongForStrip, paint, preferredBodyBudget, PREFERRED_LINE_CHARS, pulseNotice, STATUS_KEY, statusLine } from "../src/chrome.ts";
import ompPulse from "../src/index.ts";
import { loadConfig } from "../src/config.ts";
import { completionsUrl, SMOL_ROLE, summarize, type PulseModelHost, type SmolComplete, type SmolModel } from "../src/summarize.ts";
import { runTick } from "../src/tick.ts";
import { PULSE_VERSION } from "../src/version.ts";
import {
  echoesLatestClause,
  extractiveSummary,
  isAnsweringStatus,
  isContentParaphrase,
  isRejectedStatus,
  isTruncatedStatus,
  isVagueStatus,
  recentTranscript,
} from "../src/transcript.ts";

const entries = [
  { type: "label", label: "ignore me" },
  {
    type: "message",
    message: {
      role: "user",
      content: "Fix the status strip so it stays out of the live turn.",
    },
  },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "plan the widget first" },
        { type: "text", text: "Editing the strip." },
        { type: "toolCall", name: "write" },
      ],
    },
  },
  {
    type: "message",
    message: { role: "toolResult", toolName: "write", content: [{ type: "text", text: "wrote src/index.ts" }] },
  },
  null,
  "not-an-entry",
];

const SMOL_MODEL: SmolModel = { provider: "test", id: "smol-role" };

type SmolCall = {
  transcript: string;
  system: string;
  apiKey: unknown;
  maxTokens?: number;
  disableReasoning?: boolean;
  model: SmolModel;
};

function smolDouble(
  reply: (transcript: string, call: number) => string,
  options?: { model?: SmolModel | undefined; apiKey?: string | undefined },
) {
  const resolved: string[] = [];
  const keys: SmolModel[] = [];
  const calls: SmolCall[] = [];
  const model = options && "model" in options ? options.model : SMOL_MODEL;
  const apiKey = options && "apiKey" in options ? options.apiKey : "resolved-key";
  const host: PulseModelHost = {
    models: {
      resolve(spec: string) {
        resolved.push(spec);
        return spec === SMOL_ROLE ? model : undefined;
      },
    },
    modelRegistry: {
      async getApiKey(seen: SmolModel) {
        keys.push(seen);
        return apiKey;
      },
      resolver(seen: SmolModel) {
        return `resolver:${seen.provider}/${seen.id}`;
      },
    },
  };
  const completeImpl: SmolComplete = async (seen, context, completeOptions) => {
    const transcript = context.messages[0]?.content ?? "";
    calls.push({
      transcript,
      system: context.systemPrompt?.[0] ?? "",
      apiKey: completeOptions?.apiKey,
      maxTokens: completeOptions?.maxTokens,
      disableReasoning: completeOptions?.disableReasoning,
      model: seen,
    });
    return { stopReason: "stop", content: [{ type: "text", text: reply(transcript, calls.length) }] };
  };
  const fetchImpl: typeof fetch = async () => {
    throw new Error("default summarizer must not fetch");
  };
  return { host, completeImpl, calls, resolved, keys, fetchImpl };
}

test("recent transcript keeps assistant and tool progress and drops the user prompt", () => {
  const tail = recentTranscript(entries, 8_000);
  assert.equal(tail.text.includes("Fix the status strip"), false);
  assert.match(tail.text, /assistant: Editing the strip\. \[write\]/);
  assert.match(tail.text, /tool: write src\/index\.ts: wrote src\/index\.ts/);
  assert.equal(tail.text.includes("plan the widget"), false);
  assert.equal(tail.text.includes("ignore me"), false);
  assert.equal(tail.fingerprint, tail.text);
});

test("recent transcript drops older lines when the cap is small", () => {
  const tail = recentTranscript(entries, 40);
  assert.equal(tail.text.includes("Fix the status strip"), false);
  assert.match(tail.text, /wrote src\/index\.ts/);
});

test("extractive summary is the turn's step, not the latest file", () => {
  assert.equal(extractiveSummary(entries), "Editing the strip");
  assert.equal(extractiveSummary(entries).includes("src/index.ts"), false);
});

const OPENING =
  "zebra-prompt-token: make the status strip restate this opening request about agent progress and the mid-turn summary.";

test("a user-heavy transcript does not yield a prompt paraphrase", async () => {
  const heavy = [
    {
      type: "custom_message",
      customType: "skill-prompt",
      attribution: "user",
      display: false,
      content: `${OPENING} Follow the skill and paraphrase the user's prompt in the status strip.`,
    },
    {
      type: "message",
      message: { role: "user", content: OPENING },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: `I will ${OPENING}` }],
      },
    },
    {
      type: "message",
      message: { role: "bashExecution", command: "echo hi", output: "hi", exitCode: 0 },
    },
  ];
  assert.equal(extractiveSummary(heavy), "");
  const tail = recentTranscript(heavy, 8_000);
  assert.equal(tail.text.includes("zebra-prompt-token"), false);
  assert.equal(tail.text.includes("paraphrase the user's prompt"), false);

  const withTool = [
    ...heavy,
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `I will ${OPENING}` },
          { type: "toolCall", name: "write", arguments: { path: "src/transcript.ts", content: "export {}" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "write",
        content: [{ type: "text", text: "Successfully wrote 20 bytes to src/transcript.ts" }],
      },
    },
  ];
  assert.equal(extractiveSummary(withTool), "Editing src/transcript.ts");
  const progressTail = recentTranscript(withTool, 8_000);
  assert.equal(progressTail.text.includes("zebra-prompt-token"), false);
  assert.match(progressTail.text, /write src\/transcript\.ts/);

  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  const smol = smolDouble(() => OPENING);
  const turn = await runTick({
    phase: "inTurn",
    config,
    entries: withTool,
    previousFingerprint: "",
    force: false,
    host: smol.host,
    completeImpl: smol.completeImpl,
    fetchImpl: smol.fetchImpl,
  });
  assert.equal(smol.resolved[0], SMOL_ROLE);
  assert.equal(smol.calls[0]?.transcript.includes("zebra-prompt-token"), false);
  assert.equal(turn.action, "paint");
  if (turn.action !== "paint") return;
  assert.equal(turn.line.includes("zebra-prompt-token"), false);
  assert.equal(turn.line, "pulse · Editing src/transcript.ts");
  assert.equal(turn.source, "extract");
});

test("assistant and tool progress becomes a progress line", () => {
  const progress = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token ship the strip" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "look at summarize.ts" },
          { type: "text", text: "Updating the summarizer." },
          { type: "toolCall", name: "read", arguments: { path: "src/summarize.ts" } },
          { type: "tool_use", name: "edit", input: { path: "src/summarize.ts" } },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "export const SYSTEM_PROMPT = ..." }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "edit",
        isError: false,
        content: "updated src/summarize.ts",
      },
    },
  ];
  assert.equal(extractiveSummary(progress), "Updating the summarizer, editing the code");
  assert.equal(extractiveSummary(progress).includes("src/summarize.ts"), false);
  const tail = recentTranscript(progress, 8_000);
  assert.equal(tail.text.includes("zebra-prompt-token"), false);
  assert.match(tail.text, /assistant: Updating the summarizer\. \[read src\/summarize\.ts\] \[edit src\/summarize\.ts\]/);
  assert.match(tail.text, /tool: edit src\/summarize\.ts/);
  assert.equal(tail.text.includes("look at summarize"), false);

  const pending = [
    { type: "message", message: { role: "user", content: "do the thing" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "write", arguments: { path: "[src/text.ts#Ab12]", content: "x" } }],
      },
    },
  ];
  assert.equal(extractiveSummary(pending), "Editing src/text.ts");
});

test("a turn with many tools summarizes progress, not the last tool", async () => {
  const many = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token ship a high-level status strip" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Updating the status summary." },
          { type: "toolCall", name: "read", arguments: { path: "src/summarize.ts" } },
        ],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "prompt text" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "grep", arguments: { pattern: "extractiveSummary", path: "src" } }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "grep", content: [{ type: "text", text: "src/transcript.ts" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "edit", arguments: { path: "src/transcript.ts" } }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "edit", content: "updated src/transcript.ts" },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] },
    },
  ];

  assert.equal(extractiveSummary(many), "Updating the status summary, running tests");
  assert.equal(extractiveSummary(many).includes("zebra-prompt-token"), false);
  assert.equal(extractiveSummary(many).includes("transcript.ts"), false);
  assert.equal(extractiveSummary(many).includes("npm test"), false);
  const tail = recentTranscript(many, 8_000);
  assert.equal(tail.text.includes("zebra-prompt-token"), false);
  assert.match(tail.text, /\[read src\/summarize\.ts\]/);
  assert.match(tail.text, /\[bash npm test\]/);

  const editsOnly = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token touch the files" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "edit", arguments: { path: "src/summarize.ts" } }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "edit", content: "updated src/summarize.ts" },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "edit", arguments: { path: "src/transcript.ts" } }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "edit", content: "updated src/transcript.ts" },
    },
  ];
  assert.equal(extractiveSummary(editsOnly), "Editing the code");
  assert.equal(extractiveSummary(editsOnly).includes("transcript.ts"), false);

  const bare = many.map((entry) => {
    if (!entry || typeof entry !== "object" || !("message" in entry)) return entry;
    const message = entry.message;
    if (!message || typeof message !== "object" || !("content" in message) || !Array.isArray(message.content)) return entry;
    const content = message.content.filter(
      (block) => !(block && typeof block === "object" && "type" in block && block.type === "text"),
    );
    return { ...entry, message: { ...message, content } };
  });
  assert.equal(extractiveSummary(bare), "Updated the code, now running tests");

  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  const echoed = smolDouble(() => "Running npm test");
  const echo = await runTick({
    phase: "inTurn",
    config,
    entries: many,
    previousFingerprint: "",
    force: false,
    host: echoed.host,
    completeImpl: echoed.completeImpl,
    fetchImpl: echoed.fetchImpl,
  });
  assert.equal(echo.action, "paint");
  if (echo.action !== "paint") return;
  assert.equal(echo.source, "extract");
  assert.equal(echo.line, "pulse · Updating the status summary, running tests");
  assert.equal(echo.line.includes("zebra-prompt-token"), false);

  const broad = smolDouble(() => "Updating the status summary, running tests");
  const kept = await runTick({
    phase: "inTurn",
    config,
    entries: many,
    previousFingerprint: "",
    force: false,
    host: broad.host,
    completeImpl: broad.completeImpl,
    fetchImpl: broad.fetchImpl,
  });
  assert.equal(kept.action, "paint");
  if (kept.action !== "paint") return;
  assert.equal(kept.source, "model");
  assert.equal(kept.line, "pulse · Updating the status summary, running tests");
});

test("vague status lines are rejected and a trailing todo stays off the strip", async () => {
  for (const line of [
    "Running todo",
    "Working",
    "Processing",
    "Thinking",
    "Updating",
    "Busy",
    "Loading",
    "In progress",
    "Doing stuff",
    "Running todowrite",
    "Doing things",
    "Running checks",
    "running checks",
    "Running tests",
    "running test",
    "still running checks",
    "running the checks",
    "running stuff",
    "running things",
    "running work",
    "running progress",
    "now running tasks",
  ]) {
    assert.equal(isVagueStatus(line), true, line);
  }
  assert.equal(isVagueStatus("Updating the status summary, editing the code"), false);
  assert.equal(isVagueStatus("Running npm test"), false);
  assert.equal(isVagueStatus("running pytest tests/test_pulse.py"), false);
  assert.equal(isVagueStatus("Editing src/transcript.ts"), false);
  assert.equal(isVagueStatus("Blocked on bash npm test"), false);

  const turn = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token ship a high-level status strip" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Updating the status summary." },
          { type: "toolCall", name: "read", arguments: { path: "src/summarize.ts" } },
        ],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "prompt text" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "edit", arguments: { path: "src/transcript.ts" } }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "edit", content: "updated src/transcript.ts" },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Running todo" }, { type: "toolCall", name: "todo" }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "todo", content: [{ type: "text", text: "updated todos" }] },
    },
  ];
  assert.equal(extractiveSummary(turn), "Updating the status summary, editing the code");
  assert.equal(extractiveSummary(turn).toLowerCase().includes("todo"), false);
  assert.equal(extractiveSummary(turn).includes("zebra-prompt-token"), false);

  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  const echoed = smolDouble(() => "Running todo");
  const painted = await runTick({
    phase: "inTurn",
    config,
    entries: turn,
    previousFingerprint: "",
    force: false,
    host: echoed.host,
    completeImpl: echoed.completeImpl,
    fetchImpl: echoed.fetchImpl,
  });
  assert.equal(echoed.calls.length, 1);
  assert.equal(painted.action, "paint");
  if (painted.action !== "paint") return;
  assert.equal(painted.source, "extract");
  assert.equal(painted.line, "pulse · Updating the status summary, editing the code");
  assert.equal(painted.line.toLowerCase().includes("running todo"), false);

  const onlyTodo = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token ship the widget" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "todo" }] },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "todo", content: [{ type: "text", text: "updated todos" }] },
    },
  ];
  assert.equal(extractiveSummary(onlyTodo), "");
  const regen = smolDouble((_transcript, call) => (call === 1 ? "Doing stuff" : "Reviewing open questions"));
  const recovered = await runTick({
    phase: "inTurn",
    config,
    entries: onlyTodo,
    previousFingerprint: "",
    force: false,
    host: regen.host,
    completeImpl: regen.completeImpl,
    fetchImpl: regen.fetchImpl,
  });
  assert.equal(regen.calls.length, 2);
  assert.match(regen.calls[1]?.transcript ?? "", /Rejected as vague/);
  assert.equal(recovered.action, "paint");
  if (recovered.action !== "paint") return;
  assert.equal(recovered.source, "model");
  assert.equal(recovered.line, "pulse · Reviewing open questions");
  assert.equal(recovered.line.includes("zebra-prompt-token"), false);

  const stuck = smolDouble(() => "Working");
  const skipped = await runTick({
    phase: "inTurn",
    config,
    entries: onlyTodo,
    previousFingerprint: "",
    force: false,
    host: stuck.host,
    completeImpl: stuck.completeImpl,
    fetchImpl: stuck.fetchImpl,
  });
  assert.deepEqual(skipped, { action: "skip" });
});

const SMOKE_LINE = " Yes—generative UI should use native-styled components that inhe";

test("truncated answers and topic paraphrases stay off the strip", async () => {
  assert.equal(isTruncatedStatus(SMOKE_LINE), true);
  assert.equal(isAnsweringStatus(SMOKE_LINE), true);
  assert.equal(isContentParaphrase(SMOKE_LINE), true);
  assert.equal(isRejectedStatus(SMOKE_LINE), true);

  assert.equal(isTruncatedStatus("Editing the status stri"), true);
  assert.equal(isTruncatedStatus("Updating the inheri"), true);
  assert.equal(isTruncatedStatus("Editing the componen"), true);
  assert.equal(isTruncatedStatus("Editing the status strip and"), true);
  assert.equal(isTruncatedStatus("Editing the code—"), true);
  assert.equal(isTruncatedStatus("Yes—"), true);
  assert.equal(isAnsweringStatus("Yes—editing the status strip"), true);
  assert.equal(isAnsweringStatus("Yes - use native components"), true);
  assert.equal(isAnsweringStatus("No, the widget sits below the editor"), true);
  assert.equal(isAnsweringStatus("Sure, native components inherit the theme"), true);
  assert.equal(isAnsweringStatus("Okay, updating the strip"), true);
  assert.equal(isContentParaphrase("generative UI should use native-styled components"), true);
  assert.equal(isContentParaphrase("native-styled components inherit the host theme"), true);
  assert.equal(isTruncatedStatus("generative UI should use native-styled components"), false);

  for (const good of [
    "Updating the status summary, running tests",
    "Editing the strip",
    "Editing the code",
    "Blocked on bash npm test",
    "Reviewing open questions",
    "Read the code, now editing the code",
    "Editing src/transcript.ts",
  ]) {
    assert.equal(isTruncatedStatus(good), false, good);
    assert.equal(isAnsweringStatus(good), false, good);
    assert.equal(isContentParaphrase(good), false, good);
    assert.equal(isVagueStatus(good), false, good);
  }

  const work = [
    {
      type: "message",
      message: { role: "user", content: "zebra-prompt-token should generative UI use native-styled components?" },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: SMOKE_LINE.trim() },
          { type: "toolCall", name: "read", arguments: { path: "src/chrome.ts" } },
        ],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "widget" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "edit", arguments: { path: "src/transcript.ts" } }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "edit", content: "updated src/transcript.ts" },
    },
  ];
  assert.equal(extractiveSummary(work), "Read the code, now editing the code");
  assert.equal(extractiveSummary(work).includes("inhe"), false);
  assert.equal(extractiveSummary(work).toLowerCase().includes("generative"), false);
  const tail = recentTranscript(work, 8_000);
  assert.equal(tail.text.includes("inhe"), false);
  assert.equal(tail.text.toLowerCase().includes("generative"), false);
  assert.equal(tail.text.includes("zebra-prompt-token"), false);
  assert.match(tail.text, /read src\/chrome\.ts/);
  assert.match(tail.text, /edit src\/transcript\.ts/);

  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  assert.equal(config.provider.baseUrl, "");
  assert.equal(config.provider.model, "");
  const packed = JSON.stringify(config).toLowerCase();
  assert.equal(packed.includes("ollama"), false);
  assert.equal(packed.includes("11434"), false);
  assert.equal(packed.includes("qwen"), false);

  const smoked = smolDouble(() => SMOKE_LINE);
  const painted = await runTick({
    phase: "inTurn",
    config,
    entries: work,
    previousFingerprint: "",
    force: false,
    host: smoked.host,
    completeImpl: smoked.completeImpl,
    fetchImpl: smoked.fetchImpl,
  });
  assert.equal(smoked.calls.length, 1);
  assert.equal(smoked.resolved[0], SMOL_ROLE);
  assert.match(smoked.calls[0]?.system ?? "", /overall progress/);
  assert.match(smoked.calls[0]?.system ?? "", /Yes, No, Sure/);
  assert.match(smoked.calls[0]?.system ?? "", /mid-word/);
  assert.equal(painted.action, "paint");
  if (painted.action !== "paint") return;
  assert.equal(painted.source, "extract");
  assert.equal(painted.line, "pulse · Read the code, now editing the code");
  assert.equal(painted.line.includes("inhe"), false);
  assert.equal(painted.line.includes("Yes"), false);

  const truncated = smolDouble(() => "Editing the status stri");
  const fromTruncate = await runTick({
    phase: "inTurn",
    config,
    entries: work,
    previousFingerprint: "",
    force: false,
    host: truncated.host,
    completeImpl: truncated.completeImpl,
    fetchImpl: truncated.fetchImpl,
  });
  assert.equal(fromTruncate.action, "paint");
  if (fromTruncate.action !== "paint") return;
  assert.equal(fromTruncate.source, "extract");
  assert.equal(fromTruncate.line.includes("stri"), false);

  const answering = smolDouble(() => "Yes—editing the status strip");
  const fromAnswer = await runTick({
    phase: "inTurn",
    config,
    entries: work,
    previousFingerprint: "",
    force: false,
    host: answering.host,
    completeImpl: answering.completeImpl,
    fetchImpl: answering.fetchImpl,
  });
  assert.equal(fromAnswer.action, "paint");
  if (fromAnswer.action !== "paint") return;
  assert.equal(fromAnswer.source, "extract");
  assert.equal(fromAnswer.line.startsWith("pulse · Yes"), false);

  const paraphrase = smolDouble(() => "generative UI should use native-styled components");
  const fromTopic = await runTick({
    phase: "inTurn",
    config,
    entries: work,
    previousFingerprint: "",
    force: false,
    host: paraphrase.host,
    completeImpl: paraphrase.completeImpl,
    fetchImpl: paraphrase.fetchImpl,
  });
  assert.equal(fromTopic.action, "paint");
  if (fromTopic.action !== "paint") return;
  assert.equal(fromTopic.source, "extract");
  assert.equal(fromTopic.line.toLowerCase().includes("generative"), false);

  const good = smolDouble(() => "Updating the status summary, running tests");
  const kept = await runTick({
    phase: "inTurn",
    config,
    entries: work,
    previousFingerprint: "",
    force: false,
    host: good.host,
    completeImpl: good.completeImpl,
    fetchImpl: good.fetchImpl,
  });
  assert.equal(kept.action, "paint");
  if (kept.action !== "paint") return;
  assert.equal(kept.source, "model");
  assert.equal(kept.line, "pulse · Updating the status summary, running tests");
  assert.equal(good.resolved[0], SMOL_ROLE);

  const onlyDraft = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token generative UI" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "todo" }] },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "todo", content: [{ type: "text", text: "updated todos" }] },
    },
  ];
  assert.equal(extractiveSummary(onlyDraft), "");
  const regen = smolDouble((_transcript, call) => (call === 1 ? SMOKE_LINE : "Reviewing open questions"));
  const recovered = await runTick({
    phase: "inTurn",
    config,
    entries: onlyDraft,
    previousFingerprint: "",
    force: false,
    host: regen.host,
    completeImpl: regen.completeImpl,
    fetchImpl: regen.fetchImpl,
  });
  assert.equal(regen.calls.length, 2);
  assert.match(regen.calls[1]?.transcript ?? "", /Rejected as vague/);
  assert.match(regen.calls[1]?.transcript ?? "", /mid-word/);
  assert.equal(recovered.action, "paint");
  if (recovered.action !== "paint") return;
  assert.equal(recovered.source, "model");
  assert.equal(recovered.line, "pulse · Reviewing open questions");
  assert.equal(recovered.line.includes("inhe"), false);

  const stillBad = smolDouble(() => SMOKE_LINE);
  const prior = await runTick({
    phase: "inTurn",
    config,
    entries: onlyDraft,
    previousFingerprint: "",
    force: false,
    host: stillBad.host,
    completeImpl: stillBad.completeImpl,
    fetchImpl: stillBad.fetchImpl,
  });
  assert.equal(stillBad.calls.length, 2);
  assert.deepEqual(prior, { action: "skip" });
});

test("a latest decision is rejected for a whole-turn rollup", async () => {
  const latest = "Keeping the widget below the editor";
  const turn = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token ship the whole-turn status rollup" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Shipping the status strip." },
          { type: "toolCall", name: "read", arguments: { path: "src/summarize.ts" } },
        ],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "prompt text" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Searching the transcript helpers." },
          { type: "toolCall", name: "grep", arguments: { pattern: "progressSummary", path: "src" } },
        ],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "grep", content: [{ type: "text", text: "src/transcript.ts" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: `${latest}.` },
          { type: "toolCall", name: "edit", arguments: { path: "src/chrome.ts" } },
        ],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "edit", content: "updated src/chrome.ts" },
    },
  ];

  assert.equal(echoesLatestClause(latest, turn), true);
  assert.equal(echoesLatestClause("Keeping the widget below the editor now", turn), true);
  const rollup = "Shipping the status strip, editing the code";
  assert.equal(echoesLatestClause(rollup, turn), false);
  assert.equal(extractiveSummary(turn), rollup);
  assert.equal(extractiveSummary(turn).toLowerCase().includes("widget"), false);
  assert.equal(extractiveSummary(turn).includes("zebra-prompt-token"), false);

  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  assert.equal(config.provider.baseUrl, "");
  assert.equal(config.provider.model, "");

  const decided = smolDouble(() => latest);
  const painted = await runTick({
    phase: "inTurn",
    config,
    entries: turn,
    previousFingerprint: "",
    force: false,
    host: decided.host,
    completeImpl: decided.completeImpl,
    fetchImpl: decided.fetchImpl,
  });
  assert.equal(decided.calls.length, 1);
  assert.equal(decided.resolved[0], SMOL_ROLE);
  assert.match(decided.calls[0]?.system ?? "", /entire current turn/);
  assert.match(decided.calls[0]?.system ?? "", /latest decision/);
  assert.match(decided.calls[0]?.system ?? "", /latest tool/);
  assert.equal(painted.action, "paint");
  if (painted.action !== "paint") return;
  assert.equal(painted.source, "extract");
  assert.equal(painted.line, `pulse · ${rollup}`);
  assert.equal(painted.line.toLowerCase().includes("widget"), false);

  const broad = smolDouble(() => "Shipping the strip, now editing");
  const kept = await runTick({
    phase: "inTurn",
    config,
    entries: turn,
    previousFingerprint: "",
    force: false,
    host: broad.host,
    completeImpl: broad.completeImpl,
    fetchImpl: broad.fetchImpl,
  });
  assert.equal(kept.action, "paint");
  if (kept.action !== "paint") return;
  assert.equal(kept.source, "model");
  assert.equal(kept.line, "pulse · Shipping the strip, now editing");
  assert.equal(broad.resolved[0], SMOL_ROLE);
  assert.ok(kept.line.length <= PREFERRED_LINE_CHARS);
  assert.equal(kept.line.includes("..."), false);
});

test("a line that does not fit is rewritten instead of cut off", async () => {
  const bulky = "Editing the status strip, the parser, the widget, the tests, the docs, and the config";
  assert.equal(isTooLongForStrip(bulky), true);
  assert.equal(bulky.includes("..."), false);

  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  assert.equal(config.provider.baseUrl, "");
  const fitted = smolDouble(() => bulky);
  const painted = await runTick({
    phase: "inTurn",
    config,
    entries,
    previousFingerprint: "",
    force: false,
    host: fitted.host,
    completeImpl: fitted.completeImpl,
    fetchImpl: fitted.fetchImpl,
  });
  assert.equal(fitted.calls.length, 1);
  assert.equal(fitted.resolved[0], SMOL_ROLE);
  assert.match(fitted.calls[0]?.system ?? "", /52 characters/);
  assert.match(fitted.calls[0]?.system ?? "", /No ellipsis/);
  assert.equal(painted.action, "paint");
  if (painted.action !== "paint") return;
  assert.equal(painted.source, "extract");
  assert.equal(painted.line, "pulse · Editing the strip");
  assert.ok(painted.line.length <= PREFERRED_LINE_CHARS);
  assert.equal(painted.line.includes("..."), false);

  const onlyTodo = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token ship the widget" } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "todo" }] } },
    {
      type: "message",
      message: { role: "toolResult", toolName: "todo", content: [{ type: "text", text: "updated todos" }] },
    },
  ];
  assert.equal(extractiveSummary(onlyTodo), "");
  const regen = smolDouble((_transcript, call) => (call === 1 ? bulky : "Reviewing open questions"));
  const recovered = await runTick({
    phase: "inTurn",
    config,
    entries: onlyTodo,
    previousFingerprint: "",
    force: false,
    host: regen.host,
    completeImpl: regen.completeImpl,
    fetchImpl: regen.fetchImpl,
  });
  assert.equal(regen.calls.length, 2);
  assert.match(regen.calls[1]?.transcript ?? "", /52 characters/);
  assert.match(regen.calls[1]?.transcript ?? "", /No ellipsis/);
  assert.equal(recovered.action, "paint");
  if (recovered.action !== "paint") return;
  assert.equal(recovered.source, "model");
  assert.equal(recovered.line, "pulse · Reviewing open questions");
  assert.ok(recovered.line.length <= PREFERRED_LINE_CHARS);
  assert.equal(recovered.line.includes("..."), false);
});

test("a failed tool is a blocker and json arguments still name the command", () => {
  const failed = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token run the tests" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: "{\"command\":\"npm test\"}" }],
      },
    },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "bash",
        isError: true,
        content: [{ type: "text", text: "npm test exited 1" }],
      },
    },
  ];
  assert.equal(extractiveSummary(failed), "Blocked on bash npm test");
  const tail = recentTranscript(failed, 8_000);
  assert.match(tail.text, /\[bash npm test\]/);
  assert.match(tail.text, /failed/);
  assert.equal(tail.text.includes("zebra-prompt-token"), false);
});

test("status line is one glanceable row and never ends in an ellipsis", () => {
  assert.equal(statusLine("editing the strip"), "pulse · editing the strip");
  assert.equal(statusLine("  line\none  "), "pulse · line one");
  assert.equal(statusLine(""), "pulse · idle");
  const bulky = `Editing ${"the status strip ".repeat(8)}today`;
  assert.equal(isTooLongForStrip(bulky), true);
  const long = statusLine(bulky);
  assert.equal(long.includes("..."), false);
  assert.equal(long.endsWith("…"), false);
  assert.ok(long.length <= PREFERRED_LINE_CHARS);
  const token = statusLine("a".repeat(200));
  assert.equal(token.includes("..."), false);
  assert.equal(token, "pulse · idle");
  assert.ok(token.length <= PREFERRED_LINE_CHARS);
});

test("missing config uses omp smol and a 7 minute interval", () => {
  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  assert.equal(config.intervalMs, 420_000);
  assert.equal(config.refreshWhileIdle, false);
  assert.equal(config.surface, "widget");
  assert.equal(config.placement, "belowEditor");
  assert.equal(config.provider.baseUrl, "");
  assert.equal(config.provider.model, "");
  assert.equal(config.provider.apiKey, "");
  const packed = JSON.stringify(config).toLowerCase();
  assert.equal(packed.includes("ollama"), false);
  assert.equal(packed.includes("11434"), false);
  assert.equal(packed.includes("qwen"), false);
});

test("env overrides the config file and bad values clamp", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pulse-"));
  const configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      intervalMs: 10,
      refreshWhileIdle: false,
      surface: "widget",
      placement: "aboveEditor",
      provider: { baseUrl: "http://file.internal/v1/", model: "from-file", apiKey: "file-key" },
    }),
  );
  try {
    const config = loadConfig({
      configPath,
      env: {
        OMP_PULSE_INTERVAL_MS: "9000000",
        OMP_PULSE_IDLE: "true",
        OMP_PULSE_SURFACE: "status",
        OMP_PULSE_BASE_URL: "http://fleet.internal:8000/v1",
        OMP_PULSE_MODEL: "fleet-nano",
        OMP_PULSE_API_KEY: "fleet-key",
      },
    });
    assert.equal(config.intervalMs, 1_800_000);
    assert.equal(config.refreshWhileIdle, true);
    assert.equal(config.surface, "status");
    assert.equal(config.placement, "aboveEditor");
    assert.equal(config.provider.baseUrl, "http://fleet.internal:8000/v1");
    assert.equal(config.provider.model, "fleet-nano");
    assert.equal(config.provider.apiKey, "fleet-key");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("surface both stays available and an unknown surface falls back to widget", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-pulse-"));
  const configPath = join(dir, "config.json");
  try {
    writeFileSync(configPath, JSON.stringify({ surface: "both" }));
    assert.equal(loadConfig({ configPath, env: {} }).surface, "both");
    assert.equal(loadConfig({ configPath, env: { OMP_PULSE_SURFACE: "widget" } }).surface, "widget");

    writeFileSync(configPath, JSON.stringify({ surface: "footer" }));
    assert.equal(loadConfig({ configPath, env: {} }).surface, "widget");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("default summarize resolves smol and does not fetch", async () => {
  const smol = smolDouble(() => '"Editing the status strip"');
  const summary = await summarize({
    transcript: "assistant: Editing the strip",
    fallback: "local extract",
    provider: { baseUrl: "", model: "", apiKey: "", timeoutMs: 5_000 },
    host: smol.host,
    completeImpl: smol.completeImpl,
    fetchImpl: smol.fetchImpl,
  });

  assert.equal(summary.source, "model");
  assert.equal(summary.text, "Editing the status strip");
  assert.deepEqual(smol.resolved, [SMOL_ROLE]);
  assert.equal(smol.keys[0], SMOL_MODEL);
  assert.equal(smol.calls.length, 1);
  assert.equal(smol.calls[0]?.model, SMOL_MODEL);
  assert.equal(smol.calls[0]?.apiKey, "resolver:test/smol-role");
  assert.equal(smol.calls[0]?.maxTokens, 60);
  assert.equal(smol.calls[0]?.disableReasoning, true);
  assert.equal(smol.calls[0]?.transcript, "assistant: Editing the strip");
  assert.match(smol.calls[0]?.system ?? "", /overall progress/);
  assert.match(smol.calls[0]?.system ?? "", /latest tool/);
  assert.match(smol.calls[0]?.system ?? "", /Never restate or paraphrase/);
  assert.match(smol.calls[0]?.system ?? "", /Running todo/);
});

test("an opt-in provider posts one chat completion and returns the model line", async () => {
  const seen: { url: string; headers: Record<string, string>; body: { model?: string; messages?: { role: string; content: string }[] } }[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const headers = new Headers(init?.headers);
    const headerMap: Record<string, string> = {};
    headers.forEach((value, key) => {
      headerMap[key] = value;
    });
    seen.push({
      url: String(url),
      headers: headerMap,
      body: JSON.parse(String(init?.body)) as { model?: string; messages?: { role: string; content: string }[] },
    });
    return new Response(JSON.stringify({ choices: [{ message: { content: '"Editing the status strip"' } }] }), {
      status: 200,
    });
  };
  const smol = smolDouble(() => {
    throw new Error("opt-in provider must not call smol");
  });

  const summary = await summarize({
    transcript: "user: Fix the strip",
    fallback: "local extract",
    provider: { baseUrl: "https://fleet.example/v1", model: "fleet-nano", apiKey: "secret-key", timeoutMs: 5_000 },
    host: smol.host,
    completeImpl: smol.completeImpl,
    fetchImpl,
  });

  assert.equal(summary.source, "model");
  assert.equal(summary.text, "Editing the status strip");
  assert.equal(smol.resolved.length, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "https://fleet.example/v1/chat/completions");
  assert.equal(seen[0]?.headers.authorization, "Bearer secret-key");
  assert.equal(seen[0]?.body.model, "fleet-nano");
  assert.deepEqual(
    seen[0]?.body.messages?.map((message) => message.role),
    ["system", "user"],
  );
  assert.equal(seen[0]?.body.messages?.[1]?.content, "user: Fix the strip");
  assert.match(seen[0]?.body.messages?.[0]?.content ?? "", /overall progress/);
  assert.equal(JSON.stringify(seen[0]?.body).includes("secret-key"), false);
});

test("a long smol line is clipped to 12 words", async () => {
  const smol = smolDouble(
    () => "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
  );
  const summary = await summarize({
    transcript: "assistant: editing src/transcript.ts",
    fallback: "working",
    provider: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1_000 },
    host: smol.host,
    completeImpl: smol.completeImpl,
  });
  assert.equal(summary.source, "model");
  assert.equal(summary.text, "one two three four five six seven eight nine ten eleven twelve");
});

test("a missing smol model, empty key, or failed complete keeps the local extract", async () => {
  const unresolved = smolDouble(() => "should not run", { model: undefined });
  const missing = await summarize({
    transcript: "assistant: Editing the strip",
    fallback: "Editing the strip",
    provider: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1_000 },
    host: unresolved.host,
    completeImpl: unresolved.completeImpl,
    fetchImpl: unresolved.fetchImpl,
  });
  assert.deepEqual(missing, { text: "Editing the strip", source: "extract" });
  assert.equal(unresolved.calls.length, 0);

  const noKey = smolDouble(() => "should not run", { apiKey: undefined });
  const locked = await summarize({
    transcript: "assistant: Editing the strip",
    fallback: "Editing the strip",
    provider: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1_000 },
    host: noKey.host,
    completeImpl: noKey.completeImpl,
  });
  assert.deepEqual(locked, { text: "Editing the strip", source: "extract" });
  assert.equal(noKey.calls.length, 0);

  const failed = smolDouble(() => "");
  const empty = await summarize({
    transcript: "assistant: Editing the strip",
    fallback: "Editing the strip",
    provider: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1_000 },
    host: failed.host,
    completeImpl: async () => {
      throw new Error("smol down");
    },
  });
  assert.deepEqual(empty, { text: "Editing the strip", source: "extract" });

  const errored = await summarize({
    transcript: "assistant: Editing the strip",
    fallback: "Editing the strip",
    provider: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1_000 },
    host: failed.host,
    completeImpl: async () => ({ stopReason: "error", errorMessage: "nope", content: [] }),
  });
  assert.deepEqual(errored, { text: "Editing the strip", source: "extract" });

  const blank = await summarize({
    transcript: "assistant: Editing the strip",
    fallback: "Editing the strip",
    provider: { baseUrl: "", model: "", apiKey: "", timeoutMs: 1_000 },
    host: failed.host,
    completeImpl: failed.completeImpl,
  });
  assert.deepEqual(blank, { text: "Editing the strip", source: "extract" });
});

test("a down opt-in endpoint or a non-http url keeps the local extract", async () => {
  const fetchImpl: typeof fetch = async () => new Response("nope", { status: 503 });
  const failed = await summarize({
    transcript: "user: Fix the strip",
    fallback: "Fix the strip → editing",
    provider: { baseUrl: "https://fleet.example/v1", model: "fleet-nano", apiKey: "", timeoutMs: 1_000 },
    fetchImpl,
  });
  assert.deepEqual(failed, { text: "Fix the strip → editing", source: "extract" });

  let called = false;
  const blocked: typeof fetch = async () => {
    called = true;
    return new Response("no");
  };
  const local = await summarize({
    transcript: "user: Fix the strip",
    fallback: "Fix the strip",
    provider: { baseUrl: "file:///tmp/pulse", model: "x", apiKey: "", timeoutMs: 1_000 },
    fetchImpl: blocked,
  });
  assert.equal(called, false);
  assert.equal(local.text, "Fix the strip");
  assert.equal(completionsUrl("file:///tmp/pulse"), undefined);
});

test("an in-turn tick paints the smol line and an idle tick does not call smol", async () => {
  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  const smol = smolDouble(() => "Editing the status strip");

  const idle = await runTick({
    phase: "idle",
    config,
    entries,
    previousFingerprint: "",
    force: false,
    host: smol.host,
    completeImpl: smol.completeImpl,
    fetchImpl: smol.fetchImpl,
  });
  assert.deepEqual(idle, { action: "skip" });
  assert.equal(smol.calls.length, 0);

  const turn = await runTick({
    phase: "inTurn",
    config,
    entries,
    previousFingerprint: "",
    force: false,
    host: smol.host,
    completeImpl: smol.completeImpl,
    fetchImpl: smol.fetchImpl,
  });
  assert.equal(turn.action, "paint");
  if (turn.action !== "paint") return;
  assert.equal(turn.line, "pulse · Editing the status strip");
  assert.equal(turn.source, "model");
  assert.equal(smol.calls.length, 1);
  assert.equal(smol.resolved[0], SMOL_ROLE);

  const repeat = await runTick({
    phase: "inTurn",
    config,
    entries,
    previousFingerprint: turn.fingerprint,
    force: false,
    host: smol.host,
    completeImpl: smol.completeImpl,
    fetchImpl: smol.fetchImpl,
  });
  assert.deepEqual(repeat, { action: "skip" });
  assert.equal(smol.calls.length, 1);

  const idleRefresh = await runTick({
    phase: "idle",
    config: { ...config, refreshWhileIdle: true },
    entries,
    previousFingerprint: "",
    force: false,
    host: smol.host,
    completeImpl: smol.completeImpl,
    fetchImpl: smol.fetchImpl,
  });
  assert.equal(idleRefresh.action, "paint");
  if (idleRefresh.action !== "paint") return;
  assert.equal(idleRefresh.line, "pulse · Editing the status strip");
  assert.equal(smol.calls.length, 2);

  const forced = await runTick({
    phase: "idle",
    config,
    entries,
    previousFingerprint: turn.fingerprint,
    force: true,
    host: smol.host,
    completeImpl: smol.completeImpl,
    fetchImpl: smol.fetchImpl,
  });
  assert.equal(forced.action, "paint");
  assert.equal(smol.calls.length, 3);
});

type WidgetContent =
  | string[]
  | undefined
  | ((tui: unknown, theme: { fg?: (token: string, text: string) => string }) => { render: () => string[] });

function recordingUi() {
  const status: { key: string; text: string | undefined }[] = [];
  const widgets: { key: string; content: WidgetContent; placement?: string; lines?: string[] }[] = [];
  const ui = {
    setStatus(key: string, text: string | undefined) {
      status.push({ key, text });
    },
    setWidget(
      key: string,
      content: WidgetContent,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) {
      const lines =
        typeof content === "function"
          ? content(null, { fg: (token, text) => `{${token}}${text}` }).render()
          : undefined;
      widgets.push({ key, content, placement: options?.placement, lines });
    },
    setFooter() {
      throw new Error("setFooter called");
    },
    setHeader() {
      throw new Error("setHeader called");
    },
  };
  return { ui, status, widgets };
}

test("paint writes status and a below-editor widget, and leaves footer and header alone", () => {
  const { ui, status, widgets } = recordingUi();

  paint(ui, { surface: "both", placement: "belowEditor" }, "pulse · editing the strip");
  assert.deepEqual(status, [{ key: STATUS_KEY, text: "pulse · editing the strip" }]);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.key, STATUS_KEY);
  assert.equal(widgets[0]?.placement, "belowEditor");
  assert.equal(typeof widgets[0]?.content, "function");
  assert.deepEqual(widgets[0]?.lines, ["{accent}pulse{dim} · {text}editing the strip"]);
});

test("widget paint writes the widget and clears the status line", () => {
  const { ui, status, widgets } = recordingUi();

  paint(ui, { surface: "widget", placement: "belowEditor" }, "pulse · editing the strip");
  assert.deepEqual(status, [{ key: STATUS_KEY, text: undefined }]);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0]?.key, STATUS_KEY);
  assert.equal(typeof widgets[0]?.content, "function");
  assert.equal(widgets[0]?.placement, "belowEditor");
  assert.deepEqual(widgets[0]?.lines, ["{accent}pulse{dim} · {text}editing the strip"]);
});

test("status paint writes the status line and clears the widget", () => {
  const { ui, status, widgets } = recordingUi();

  paint(ui, { surface: "status", placement: "aboveEditor" }, "pulse · editing the strip");
  assert.deepEqual(status, [{ key: STATUS_KEY, text: "pulse · editing the strip" }]);
  assert.deepEqual(widgets, [{ key: STATUS_KEY, content: undefined, placement: undefined, lines: undefined }]);
});

test("widget-only paint falls back to status when the widget surface throws", () => {
  let status = "";
  const ui = {
    setStatus(_key: string, text: string | undefined) {
      status = text ?? "";
    },
    setWidget() {
      throw new Error("no widget");
    },
    setFooter() {
      throw new Error("setFooter called");
    },
    setHeader() {
      throw new Error("setHeader called");
    },
  };
  paint(ui, { surface: "widget", placement: "aboveEditor" }, "pulse · editing the strip");
  assert.equal(status, "pulse · editing the strip");
});

test("a live tick passes ctx into smol resolve and getApiKey", async () => {
  const resolved: string[] = [];
  const keys: SmolModel[] = [];
  let painted = "";
  type HostHandler = (event: unknown, ctx: {
    ui: {
      setStatus: () => void;
      setWidget: (
        key: string,
        content: ((tui: unknown, theme: { fg?: (token: string, text: string) => string }) => { render: () => string[] }) | undefined,
      ) => void;
    };
    sessionManager: { getBranch: () => unknown };
    setInterval: () => unknown;
    clearTimer: () => void;
    models: { resolve: (spec: string) => SmolModel };
    modelRegistry: { getApiKey: (model: SmolModel) => Promise<string> };
  }) => void | Promise<void>;
  const handlers = new Map<string, HostHandler>();
  ompPulse({
    on(event, handler) {
      handlers.set(event, handler as HostHandler);
    },
    registerCommand() {},
  });
  const model: SmolModel = { provider: "test", id: "smol-role" };
  const ctx = {
    ui: {
      setStatus() {},
      setWidget(
        _key: string,
        content: ((tui: unknown, theme: { fg?: (token: string, text: string) => string }) => { render: () => string[] }) | undefined,
      ) {
        if (typeof content !== "function") return;
        painted = content(null, { fg: (_token, text) => text }).render().join("");
      },
    },
    sessionManager: { getBranch: () => entries },
    setInterval() {
      return 1;
    },
    clearTimer() {},
    models: {
      resolve(spec: string) {
        resolved.push(spec);
        return model;
      },
    },
    modelRegistry: {
      async getApiKey(seen: SmolModel) {
        keys.push(seen);
        return "resolved-key";
      },
    },
  };
  await handlers.get("session_start")?.({}, ctx);
  await handlers.get("turn_start")?.({}, ctx);
  await handlers.get("turn_end")?.({}, ctx);
  const deadline = Date.now() + 2_000;
  while (resolved.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.deepEqual(resolved, [SMOL_ROLE]);
  assert.deepEqual(keys, [model]);
  assert.equal(painted, "pulse · Editing the strip");
});

test("a generic Running phase does not paint Running checks", async () => {
  const generic = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token ship the strip" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Running checks" }, { type: "toolCall", name: "bash" }],
      },
    },
  ];
  assert.equal(extractiveSummary(generic), "");
  assert.equal(extractiveSummary(generic).toLowerCase().includes("running checks"), false);

  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  const vague = smolDouble(() => "Running checks");
  const skipped = await runTick({
    phase: "inTurn",
    config,
    entries: generic,
    previousFingerprint: "",
    force: false,
    host: vague.host,
    completeImpl: vague.completeImpl,
    fetchImpl: vague.fetchImpl,
  });
  assert.equal(vague.calls.length, 2);
  assert.match(vague.calls[1]?.transcript ?? "", /Running checks/);
  assert.match(vague.calls[1]?.transcript ?? "", /Running tests/);
  assert.deepEqual(skipped, { action: "skip" });

  const rolled = smolDouble(() => "Shipping the status strip");
  const painted = await runTick({
    phase: "inTurn",
    config,
    entries: generic,
    previousFingerprint: "",
    force: false,
    host: rolled.host,
    completeImpl: rolled.completeImpl,
    fetchImpl: rolled.fetchImpl,
  });
  assert.equal(painted.action, "paint");
  if (painted.action !== "paint") return;
  assert.equal(painted.source, "model");
  assert.equal(painted.line, "pulse · Shipping the status strip");
  assert.equal(painted.line.toLowerCase().includes("running checks"), false);

  const targeted = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token run the suite" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
      },
    },
  ];
  assert.equal(extractiveSummary(targeted), "Running npm test");
  assert.equal(extractiveSummary(targeted).toLowerCase().includes("running checks"), false);
  assert.equal(isVagueStatus(extractiveSummary(targeted)), false);

  const several = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token run the suite" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command: "npm test" } }],
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok" }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", name: "bash", arguments: { command: "npm run typecheck" } }],
      },
    },
  ];
  assert.equal(extractiveSummary(several), "Running npm run typecheck");
  assert.equal(extractiveSummary(several).toLowerCase().includes("running checks"), false);
});

test("version comes from package.json and the strip budget shrinks when it is shown", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(PULSE_VERSION, pkg.version);
  assert.equal(PULSE_VERSION, "0.1.6");

  const missing = join(tmpdir(), "omp-pulse-missing.json");
  assert.equal(loadConfig({ configPath: missing, env: {} }).showVersion, false);
  assert.equal(loadConfig({ configPath: missing, env: { OMP_PULSE_SHOW_VERSION: "1" } }).showVersion, true);
  assert.equal(loadConfig({ configPath: missing, env: { OMP_PULSE_SHOW_VERSION: "true" } }).showVersion, true);
  assert.equal(loadConfig({ configPath: missing, env: { OMP_PULSE_SHOW_VERSION: "TRUE" } }).showVersion, true);
  assert.equal(loadConfig({ configPath: missing, env: { OMP_PULSE_SHOW_VERSION: "0" } }).showVersion, false);
  assert.equal(loadConfig({ configPath: missing, env: { OMP_PULSE_SHOW_VERSION: "false" } }).showVersion, false);

  const shown = statusLine("editing the strip", { showVersion: true });
  assert.equal(shown, `pulse · ${PULSE_VERSION} · editing the strip`);
  assert.ok(shown.length <= PREFERRED_LINE_CHARS);
  assert.equal(shown.includes("..."), false);
  const hidden = statusLine("editing the strip");
  assert.equal(hidden, "pulse · editing the strip");
  assert.equal(hidden.includes(PULSE_VERSION), false);

  const bulky = "Updating the status summary before running tests";
  const plain = statusLine(bulky);
  const fitted = statusLine(bulky, { showVersion: true });
  const plainBody = plain.slice("pulse · ".length);
  const mark = `pulse · ${PULSE_VERSION} · `;
  const fittedBody = fitted.slice(mark.length);
  const budget = preferredBodyBudget({ showVersion: true });
  assert.ok(plainBody.length > budget);
  assert.ok(fittedBody.length <= budget);
  assert.ok(fittedBody.length < plainBody.length);
  assert.equal(fitted.includes("..."), false);
  assert.ok(fitted.length <= PREFERRED_LINE_CHARS);
  assert.equal(isTooLongForStrip(plainBody), false);
  assert.equal(isTooLongForStrip(plainBody, { showVersion: true }), true);
  assert.equal(pulseNotice(hidden), `omp-pulse ${PULSE_VERSION} · ${hidden}`);

  const { ui, widgets } = recordingUi();
  paint(ui, { surface: "widget", placement: "belowEditor" }, shown);
  assert.deepEqual(widgets[0]?.lines, [`{accent}pulse{dim} · {text}${PULSE_VERSION} · editing the strip`]);
});

type PulseCommand = (args: string | undefined, ctx: ReturnType<typeof commandHost>) => Promise<void>;

function commandHost(branch: unknown, notices: string[], painted: string[]) {
  return {
    ui: {
      setStatus() {},
      setWidget(
        _key: string,
        content: ((tui: unknown, theme: { fg?: (token: string, text: string) => string }) => { render: () => string[] }) | undefined,
      ) {
        if (typeof content !== "function") return;
        painted.push(content(null, { fg: (_token, text) => text }).render().join(""));
      },
      notify(message: string) {
        notices.push(message);
      },
    },
    sessionManager: { getBranch: () => branch },
    setInterval() {
      return 1;
    },
    clearTimer() {},
  };
}

function registerPulse(showVersion: string | undefined): PulseCommand {
  const previous = process.env.OMP_PULSE_SHOW_VERSION;
  if (showVersion === undefined) delete process.env.OMP_PULSE_SHOW_VERSION;
  else process.env.OMP_PULSE_SHOW_VERSION = showVersion;
  let command: PulseCommand | undefined;
  const handlers = new Map<string, (event: unknown, ctx: ReturnType<typeof commandHost>) => void | Promise<void>>();
  ompPulse({
    on(event, handler) {
      handlers.set(event, handler as (event: unknown, ctx: ReturnType<typeof commandHost>) => void | Promise<void>);
    },
    registerCommand(_name, options) {
      command = options.handler as PulseCommand;
    },
  });
  if (previous === undefined) delete process.env.OMP_PULSE_SHOW_VERSION;
  else process.env.OMP_PULSE_SHOW_VERSION = previous;
  if (!command) throw new Error("pulse command was not registered");
  return Object.assign(command, { start: handlers.get("session_start") });
}

test("/pulse notice includes the package version when the strip hides it", async () => {
  const notices: string[] = [];
  const painted: string[] = [];
  const command = registerPulse(undefined);
  const ctx = commandHost(entries, notices, painted);
  await command("", ctx);
  assert.equal(painted.at(-1), "pulse · Editing the strip");
  assert.equal(notices[0], `omp-pulse ${PULSE_VERSION} · pulse · Editing the strip`);
});

test("OMP_PULSE_SHOW_VERSION paints the version and /pulse still names it", async () => {
  const notices: string[] = [];
  const painted: string[] = [];
  const command = registerPulse("true");
  const ctx = commandHost(entries, notices, painted);
  const start = (command as PulseCommand & { start?: (event: unknown, ctx: ReturnType<typeof commandHost>) => void }).start;
  await start?.({}, ctx);
  assert.equal(painted.at(-1), `pulse · ${PULSE_VERSION} · Editing the strip`);
  await command("", ctx);
  assert.equal(notices[0], `omp-pulse ${PULSE_VERSION} · pulse · ${PULSE_VERSION} · Editing the strip`);
  assert.ok((painted.at(-1) ?? "").length <= PREFERRED_LINE_CHARS);

  const config = loadConfig({
    configPath: join(tmpdir(), "omp-pulse-missing.json"),
    env: { OMP_PULSE_SHOW_VERSION: "1" },
  });
  const generic = [
    { type: "message", message: { role: "user", content: "zebra-prompt-token ship the strip" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
    },
  ];
  const budget = preferredBodyBudget({ showVersion: true });
  const vague = smolDouble(() => "Running checks");
  await runTick({
    phase: "inTurn",
    config,
    entries: generic,
    previousFingerprint: "",
    force: false,
    host: vague.host,
    completeImpl: vague.completeImpl,
    fetchImpl: vague.fetchImpl,
  });
  assert.match(vague.calls[0]?.system ?? "", new RegExp(`${budget} characters`));
  assert.match(vague.calls[1]?.transcript ?? "", new RegExp(`at most ${budget} characters`));
});
