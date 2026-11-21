import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { paint, statusLine, STATUS_KEY } from "../src/chrome.ts";
import { loadConfig } from "../src/config.ts";
import { type PulseModelHost, type SmolComplete } from "../src/summarize.ts";
import { runTick } from "../src/tick.ts";
import { extractiveSummary } from "../src/transcript.ts";

const ESC = "\x1b";
const BEL = "\x07";

// Theme colors are real ANSI. They must survive; content controls must not.
const THEME: Record<string, string> = { accent: `${ESC}[36m`, dim: `${ESC}[2m`, text: `${ESC}[37m` };
const RESET = `${ESC}[0m`;
const theme = { fg: (token: string, text: string) => `${THEME[token] ?? ""}${text}${RESET}` };

type WidgetContent =
  | string[]
  | undefined
  | ((tui: unknown, theme: { fg?: (token: string, text: string) => string }) => { render: () => string[] });

function recordingUi() {
  const status: (string | undefined)[] = [];
  const widget: string[] = [];
  const ui = {
    setStatus(_key: string, text: string | undefined) {
      status.push(text);
    },
    setWidget(_key: string, content: WidgetContent) {
      if (typeof content === "function") widget.push(...content(null, theme).render());
    },
  };
  return { ui, status, widget };
}

function withoutTheme(text: string): string {
  let out = text;
  for (const code of [...Object.values(THEME), RESET]) out = out.split(code).join("");
  return out;
}

function assertNoContentControls(text: string): void {
  const bare = withoutTheme(text);
  assert.equal(bare.includes(ESC), false, `ESC leaked: ${JSON.stringify(text)}`);
  assert.equal(bare.includes(BEL), false, `BEL leaked: ${JSON.stringify(text)}`);
  assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(bare), false, `control leaked: ${JSON.stringify(text)}`);
}

const hostileRead = [
  { type: "message", message: { role: "user", content: "review the repo" } },
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", name: "read", arguments: { path: `src/pulse-${ESC}[2J${ESC}[H.ts` } }],
    },
  },
];

test("a filename with CSI erase/cursor sequences cannot reach the terminal", () => {
  const extract = extractiveSummary(hostileRead);
  const line = statusLine(extract);
  assertNoContentControls(line);
  assert.equal(line, "pulse · Reading src/pulse-.ts");

  const { ui, status, widget } = recordingUi();
  paint(ui, { surface: "both", placement: "belowEditor" }, line);
  for (const text of status) assertNoContentControls(text ?? "");
  assert.equal(widget.length, 1);
  assertNoContentControls(widget[0] ?? "");
  // Application theme colors still work.
  assert.ok((widget[0] ?? "").includes(THEME.accent));
  assert.equal(withoutTheme(widget[0] ?? ""), "pulse · Reading src/pulse-.ts");
});

test("BEL- and ST-terminated OSC sequences in model text are removed", () => {
  const body = `Editing ${ESC}]0;owned${BEL}the ${ESC}]8;;https://x.test${ESC}\\strip${ESC}]8;;${ESC}\\ config`;
  const line = statusLine(body);
  assertNoContentControls(line);
  assert.equal(line, "pulse · Editing the strip config");
});

test("paint strips content controls from a raw line but keeps theme colors", () => {
  const { ui, status, widget } = recordingUi();
  const raw = `pulse · Editing ${ESC}[2K${ESC}[1Athe ${ESC}]52;c;cGF5bG9hZA==${BEL}strip${BEL}${ESC}c${"\x9b"}2J`;
  paint(ui, { surface: "both", placement: "belowEditor" }, raw);
  for (const text of status) assertNoContentControls(text ?? "");
  assertNoContentControls(widget[0] ?? "");
  assert.equal(withoutTheme(widget[0] ?? ""), "pulse · Editing the strip");
  assert.equal(status[0], "pulse · Editing the strip");
  assert.equal(STATUS_KEY, "omp-pulse");
});

test("a model summary with terminal controls paints without them", async () => {
  const config = loadConfig({ configPath: join(tmpdir(), "omp-pulse-missing.json"), env: {} });
  const host: PulseModelHost = {
    models: { resolve: () => ({ provider: "test", id: "smol" }) },
    modelRegistry: { getApiKey: async () => "key" },
  };
  const completeImpl: SmolComplete = async () => ({
    stopReason: "stop",
    content: [{ type: "text", text: `Reviewing ${ESC}[2Jrelease ${ESC}]0;x${BEL}gate checks` }],
  });
  const result = await runTick({
    phase: "inTurn",
    config,
    entries: hostileRead,
    previousFingerprint: "",
    force: false,
    host,
    completeImpl,
  });
  assert.equal(result.action, "paint");
  if (result.action !== "paint") return;
  assertNoContentControls(result.line);
  assert.equal(result.line, "pulse · Reviewing release gate checks");
});
