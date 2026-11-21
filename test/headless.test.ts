import assert from "node:assert/strict";
import test from "node:test";
import ompPulse from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;
type WidgetContent =
  | string[]
  | undefined
  | ((tui: unknown, theme: { fg?: (token: string, text: string) => string }) => { render: () => string[] });

function progress(file: string) {
  return [
    { type: "message", message: { role: "user", content: "ship the strip" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: file } }] },
    },
  ];
}

function loadPulse() {
  const previous = process.env.OMP_PULSE_BASE_URL;
  delete process.env.OMP_PULSE_BASE_URL;
  const handlers = new Map<string, Handler>();
  try {
    ompPulse({
      on(event, handler) {
        handlers.set(event, handler as Handler);
      },
      registerCommand() {},
    });
  } finally {
    if (previous !== undefined) process.env.OMP_PULSE_BASE_URL = previous;
  }
  return async (event: string, ctx: unknown) => {
    await handlers.get(event)?.({}, ctx);
  };
}

function host(display: { hasUI?: boolean; mode?: string }) {
  const seen = { timers: 0, requests: 0, widget: [] as (string | undefined)[] };
  const state = { branch: progress("src/alpha.ts") as unknown };
  const ctx = {
    ...display,
    ui: {
      setStatus() {},
      setWidget(_key: string, content: WidgetContent) {
        seen.widget.push(typeof content === "function" ? content(null, {}).render().join("") : undefined);
      },
    },
    sessionManager: { getBranch: () => state.branch },
    setInterval() {
      seen.timers += 1;
      return 1;
    },
    clearTimer() {},
    models: {
      resolve() {
        seen.requests += 1;
        return { provider: "test", id: "smol" };
      },
    },
    modelRegistry: { getApiKey: async () => undefined },
  };
  return { ctx, seen, state };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("a headless session with a changed transcript arms no timer and makes no summary request", async () => {
  const emit = loadPulse();
  const h = host({ hasUI: false, mode: "print" });
  await emit("session_start", h.ctx);
  await emit("turn_start", h.ctx);
  await emit("turn_end", h.ctx);
  h.state.branch = progress("src/beta.ts");
  await emit("turn_start", h.ctx);
  await emit("turn_end", h.ctx);
  await settle();
  assert.equal(h.seen.timers, 0, "headless session armed a refresh timer");
  assert.equal(h.seen.requests, 0, "headless session made a summary request");
});

test("a TUI session still arms the timer and shows progress", async () => {
  const emit = loadPulse();
  const h = host({ hasUI: true, mode: "tui" });
  await emit("session_start", h.ctx);
  assert.equal(h.seen.timers, 1);
  await emit("turn_start", h.ctx);
  await emit("turn_end", h.ctx);
  await settle();
  assert.equal(h.seen.requests, 1);
  assert.equal(h.seen.widget.at(-1), "pulse · Editing src/alpha.ts");
});
