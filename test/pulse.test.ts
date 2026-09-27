import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { paint, STATUS_KEY, statusLine } from "../src/chrome.ts";
import { loadConfig } from "../src/config.ts";
import { completionsUrl, summarize } from "../src/summarize.ts";
import { runTick } from "../src/tick.ts";
import { extractiveSummary, recentTranscript } from "../src/transcript.ts";

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

test("recent transcript keeps the newest user and assistant text and drops thinking", () => {
  const tail = recentTranscript(entries, 8_000);
  assert.match(tail.text, /user: Fix the status strip/);
  assert.match(tail.text, /assistant: Editing the strip\. \[write\]/);
  assert.match(tail.text, /tool: write: wrote src\/index\.ts/);
  assert.equal(tail.text.includes("plan the widget"), false);
  assert.equal(tail.text.includes("ignore me"), false);
  assert.equal(tail.fingerprint, tail.text);
});

test("recent transcript drops older lines when the cap is small", () => {
  const tail = recentTranscript(entries, 40);
  assert.equal(tail.text.includes("Fix the status strip"), false);
  assert.match(tail.text, /wrote src\/index\.ts/);
});

test("extractive summary is the latest user request and assistant line", () => {
  assert.equal(
    extractiveSummary(entries),
    "Fix the status strip so i... → Editing the strip. [write]",
  );
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
  assert.equal(config.surface, "both");
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
  assert.equal(JSON.stringify(seen[0]?.body).includes("secret-key"), false);
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

test("paint writes status and a below-editor widget, and leaves footer and header alone", () => {
  let status: { key: string; text: string | undefined } | undefined;
  let widget: { key: string; placement?: string; lines: string[] } | undefined;
  const ui = {
    setStatus(key: string, text: string | undefined) {
      status = { key, text };
    },
    setWidget(
      key: string,
      content: ((tui: unknown, theme: { fg?: (token: string, text: string) => string }) => { render: () => string[] }) | string[] | undefined,
      options?: { placement?: "aboveEditor" | "belowEditor" },
    ) {
      if (typeof content !== "function") throw new Error(`expected a widget factory, got ${String(content)}`);
      widget = {
        key,
        placement: options?.placement,
        lines: content(null, { fg: (token, text) => `{${token}}${text}` }).render(),
      };
    },
    setFooter() {
      throw new Error("setFooter called");
    },
    setHeader() {
      throw new Error("setHeader called");
    },
  };

  paint(ui, { surface: "both", placement: "belowEditor" }, "pulse · editing the strip");
  assert.deepEqual(status, { key: STATUS_KEY, text: "pulse · editing the strip" });
  assert.deepEqual(widget, {
    key: STATUS_KEY,
    placement: "belowEditor",
    lines: ["{accent}pulse{dim} · {text}editing the strip"],
  });
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
