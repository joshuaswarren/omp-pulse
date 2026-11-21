import assert from "node:assert/strict";
import test from "node:test";
import ompPulse from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;
type WidgetContent =
  | string[]
  | undefined
  | ((tui: unknown, theme: { fg?: (token: string, text: string) => string }) => { render: () => string[] });

function leaf(file: string) {
  return [
    { type: "message", message: { role: "user", content: "ship the strip" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: file } }] },
    },
  ];
}

test("/tree navigation repaints the selected leaf without a prompt or manual refresh", async () => {
  const previous = { idle: process.env.OMP_PULSE_IDLE, base: process.env.OMP_PULSE_BASE_URL };
  process.env.OMP_PULSE_IDLE = "0";
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
    if (previous.idle === undefined) delete process.env.OMP_PULSE_IDLE;
    else process.env.OMP_PULSE_IDLE = previous.idle;
    if (previous.base !== undefined) process.env.OMP_PULSE_BASE_URL = previous.base;
  }

  const state = { branch: leaf("src/alpha.ts") as unknown, requests: 0 };
  const widget: (string | undefined)[] = [];
  const ticks: Array<() => void> = [];
  const ctx = {
    ui: {
      setStatus() {},
      setWidget(_key: string, content: WidgetContent) {
        widget.push(typeof content === "function" ? content(null, {}).render().join("") : undefined);
      },
    },
    sessionManager: { getBranch: () => state.branch },
    setInterval(fn: () => void) {
      ticks.push(fn);
      return 1;
    },
    clearTimer() {},
    models: {
      resolve() {
        state.requests += 1;
        return { provider: "test", id: "smol" };
      },
    },
    modelRegistry: { getApiKey: async () => undefined },
  };
  const emit = async (event: string) => {
    await handlers.get(event)?.({}, ctx);
  };

  await emit("session_start");
  assert.equal(widget.at(-1), "pulse · Editing src/alpha.ts");

  state.branch = leaf("src/beta.ts"); // /tree selects leaf B
  await emit("session_tree");
  assert.equal(widget.at(-1), "pulse · Editing src/beta.ts", "the strip still describes the old leaf");

  state.branch = leaf("src/alpha.ts"); // and back to leaf A
  await emit("session_tree");
  assert.equal(widget.at(-1), "pulse · Editing src/alpha.ts");

  ticks[0]?.(); // idle refresh is off: the timer changes nothing
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(state.requests, 0);
  assert.equal(widget.at(-1), "pulse · Editing src/alpha.ts");
});
