import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { paint, STATUS_KEY, statusLine } from "../src/chrome.ts";
import { loadConfig } from "../src/config.ts";
import { completionsUrl, summarize } from "../src/summarize.ts";
import { runTick } from "../src/tick.ts";
import { extractiveSummary, isVagueStatus, recentTranscript } from "../src/transcript.ts";

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
  let sent = "";
  const fetchImpl: typeof fetch = async (_url, init) => {
    sent = String(init?.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: OPENING } }] }), { status: 200 });
  };
  const turn = await runTick({
    phase: "inTurn",
    config,
    entries: withTool,
    previousFingerprint: "",
    force: false,
    fetchImpl,
  });
  assert.equal(sent.includes("zebra-prompt-token"), false);
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
  const echoed: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "Running npm test" } }] }), { status: 200 });
  const echo = await runTick({
    phase: "inTurn",
    config,
    entries: many,
    previousFingerprint: "",
    force: false,
    fetchImpl: echoed,
  });
  assert.equal(echo.action, "paint");
  if (echo.action !== "paint") return;
  assert.equal(echo.source, "extract");
  assert.equal(echo.line, "pulse · Updating the status summary, running tests");
  assert.equal(echo.line.includes("zebra-prompt-token"), false);

  const broad: typeof fetch = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { content: "Updating the status summary, running tests" } }] }),
      { status: 200 },
    );
  const kept = await runTick({
    phase: "inTurn",
    config,
    entries: many,
    previousFingerprint: "",
    force: false,
    fetchImpl: broad,
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
  ]) {
    assert.equal(isVagueStatus(line), true, line);
  }
  assert.equal(isVagueStatus("Updating the status summary, editing the code"), false);
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
  let calls = 0;
  const echoed: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: "Running todo" } }] }), { status: 200 });
  };
  const painted = await runTick({
    phase: "inTurn",
    config,
    entries: turn,
    previousFingerprint: "",
    force: false,
    fetchImpl: echoed,
  });
  assert.equal(calls, 1);
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
  let retries = 0;
  let retryNote = "";
  const regen: typeof fetch = async (_url, init) => {
    retries += 1;
    const body = JSON.parse(String(init?.body)) as { messages?: { content?: string }[] };
    const transcript = body.messages?.[1]?.content ?? "";
    if (retries === 2) retryNote = transcript;
    const content = retries === 1 ? "Doing stuff" : "Reviewing open questions";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };
  const recovered = await runTick({
    phase: "inTurn",
    config,
    entries: onlyTodo,
    previousFingerprint: "",
    force: false,
    fetchImpl: regen,
  });
  assert.equal(retries, 2);
  assert.match(retryNote, /Rejected as vague/);
  assert.equal(recovered.action, "paint");
  if (recovered.action !== "paint") return;
  assert.equal(recovered.source, "model");
  assert.equal(recovered.line, "pulse · Reviewing open questions");
  assert.equal(recovered.line.includes("zebra-prompt-token"), false);

  const stuck: typeof fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "Working" } }] }), { status: 200 });
  const skipped = await runTick({
    phase: "inTurn",
    config,
    entries: onlyTodo,
    previousFingerprint: "",
    force: false,
    fetchImpl: stuck,
  });
  assert.deepEqual(skipped, { action: "skip" });
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

test("status line is one clipped row", () => {
  assert.equal(statusLine("editing the strip"), "pulse · editing the strip");
  assert.equal(statusLine("  line\none  "), "pulse · line one");
  assert.equal(statusLine(""), "pulse · idle");
  const long = statusLine("a".repeat(200));
  assert.equal(long, `pulse · ${"a".repeat(69)}...`);
  assert.equal(long.length, "pulse · ".length + 72);
});

test("missing config uses the local model and a 7 minute interval", () => {
  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  assert.equal(config.intervalMs, 420_000);
  assert.equal(config.refreshWhileIdle, false);
  assert.equal(config.surface, "widget");
  assert.equal(config.placement, "belowEditor");
  assert.equal(config.provider.baseUrl, "http://127.0.0.1:11434/v1");
  assert.equal(config.provider.model, "qwen2.5:0.5b");
  assert.equal(config.provider.apiKey, "");
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
      provider: { baseUrl: "http://127.0.0.1:11434/v1/", model: "from-file", apiKey: "file-key" },
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
        OMP_PULSE_MODEL: "qwen2.5-0.5b",
        OMP_PULSE_API_KEY: "fleet-key",
      },
    });
    assert.equal(config.intervalMs, 1_800_000);
    assert.equal(config.refreshWhileIdle, true);
    assert.equal(config.surface, "status");
    assert.equal(config.placement, "aboveEditor");
    assert.equal(config.provider.baseUrl, "http://fleet.internal:8000/v1");
    assert.equal(config.provider.model, "qwen2.5-0.5b");
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

test("summarize posts one chat completion and returns the model line", async () => {
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

  const summary = await summarize({
    transcript: "user: Fix the strip",
    fallback: "local extract",
    provider: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:0.5b", apiKey: "secret-key", timeoutMs: 5_000 },
    fetchImpl,
  });

  assert.equal(summary.source, "model");
  assert.equal(summary.text, "Editing the status strip");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.url, "http://127.0.0.1:11434/v1/chat/completions");
  assert.equal(seen[0]?.headers.authorization, "Bearer secret-key");
  assert.equal(seen[0]?.body.model, "qwen2.5:0.5b");
  assert.deepEqual(
    seen[0]?.body.messages?.map((message) => message.role),
    ["system", "user"],
  );
  assert.equal(seen[0]?.body.messages?.[1]?.content, "user: Fix the strip");
  assert.match(seen[0]?.body.messages?.[0]?.content ?? "", /overall progress/);
  assert.match(seen[0]?.body.messages?.[0]?.content ?? "", /latest tool/);
  assert.match(seen[0]?.body.messages?.[0]?.content ?? "", /Never restate or paraphrase/);
  assert.match(seen[0]?.body.messages?.[0]?.content ?? "", /Running todo/);
  assert.equal(JSON.stringify(seen[0]?.body).includes("secret-key"), false);
});

test("a long model line is clipped to 12 words", async () => {
  const fetchImpl: typeof fetch = async () =>
    new Response(
      JSON.stringify({
        choices: [
          {
            message: {
              content: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen",
            },
          },
        ],
      }),
      { status: 200 },
    );
  const summary = await summarize({
    transcript: "assistant: editing src/transcript.ts",
    fallback: "working",
    provider: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:0.5b", apiKey: "", timeoutMs: 1_000 },
    fetchImpl,
  });
  assert.equal(summary.source, "model");
  assert.equal(summary.text, "one two three four five six seven eight nine ten eleven twelve");
});

test("a down model or a non-http endpoint keeps the local extract", async () => {
  const fetchImpl: typeof fetch = async () => new Response("nope", { status: 503 });
  const failed = await summarize({
    transcript: "user: Fix the strip",
    fallback: "Fix the strip → editing",
    provider: { baseUrl: "http://127.0.0.1:11434/v1", model: "qwen2.5:0.5b", apiKey: "", timeoutMs: 1_000 },
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

test("an in-turn tick paints the model line and an idle tick does not call the model", async () => {
  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: "Editing the status strip" } }] }), {
      status: 200,
    });
  };

  const idle = await runTick({
    phase: "idle",
    config,
    entries,
    previousFingerprint: "",
    force: false,
    fetchImpl,
  });
  assert.deepEqual(idle, { action: "skip" });
  assert.equal(calls, 0);

  const turn = await runTick({
    phase: "inTurn",
    config,
    entries,
    previousFingerprint: "",
    force: false,
    fetchImpl,
  });
  assert.equal(turn.action, "paint");
  if (turn.action !== "paint") return;
  assert.equal(turn.line, "pulse · Editing the status strip");
  assert.equal(turn.source, "model");
  assert.equal(calls, 1);

  const repeat = await runTick({
    phase: "inTurn",
    config,
    entries,
    previousFingerprint: turn.fingerprint,
    force: false,
    fetchImpl,
  });
  assert.deepEqual(repeat, { action: "skip" });
  assert.equal(calls, 1);

  const idleRefresh = await runTick({
    phase: "idle",
    config: { ...config, refreshWhileIdle: true },
    entries,
    previousFingerprint: "",
    force: false,
    fetchImpl,
  });
  assert.equal(idleRefresh.action, "paint");
  if (idleRefresh.action !== "paint") return;
  assert.equal(idleRefresh.line, "pulse · Editing the status strip");
  assert.equal(calls, 2);

  const forced = await runTick({
    phase: "idle",
    config,
    entries,
    previousFingerprint: turn.fingerprint,
    force: true,
    fetchImpl,
  });
  assert.equal(forced.action, "paint");
  assert.equal(calls, 3);
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
