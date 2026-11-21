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
  return async (event: string, ctx: unknown) => {
    await handlers.get(event)?.({}, ctx);
  };
}

/** One session host. Summary requests stay pending until `release()`. */
function session(file: string) {
  const state = { branch: progress(file) as unknown };
  const widget: (string | undefined)[] = [];
  const held: Array<(key: string | undefined) => void> = [];
  const ctx = {
    ui: {
      setStatus() {},
      setWidget(_key: string, content: WidgetContent) {
        widget.push(typeof content === "function" ? content(null, {}).render().join("") : undefined);
      },
    },
    sessionManager: { getBranch: () => state.branch },
    setInterval: () => 1,
    clearTimer() {},
    models: { resolve: () => ({ provider: "test", id: "smol" }) },
    modelRegistry: {
      getApiKey() {
        return new Promise<string | undefined>((resolve) => held.push(resolve));
      },
    },
  };
  const release = async () => {
    const next = held.shift();
    assert.ok(next, "expected a pending summary request");
    next(undefined);
    await settle();
  };
  return { ctx, state, widget, held, release };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("a summary started in session A does not paint into session B after a switch", async () => {
  const emit = loadPulse();
  const a = session("src/alpha.ts");
  const b = session("src/beta.ts");
  await emit("session_start", a.ctx);
  await emit("turn_start", a.ctx);
  await emit("turn_end", a.ctx);
  await settle();
  assert.equal(a.held.length, 1);

  await emit("session_switch", b.ctx);
  assert.equal(b.widget.at(-1), "pulse · Editing src/beta.ts");

  await a.release();
  assert.equal(b.widget.at(-1), "pulse · Editing src/beta.ts");
  assert.equal(b.widget.some((line) => line?.includes("alpha")), false, "A's line painted into B");
  assert.equal(a.widget.some((line) => line?.includes("beta")), false);
});

test("a summary started before a branch change does not paint the old history", async () => {
  const emit = loadPulse();
  const s = session("src/alpha.ts");
  await emit("session_start", s.ctx);
  await emit("turn_start", s.ctx);
  await emit("turn_end", s.ctx);
  await settle();
  assert.equal(s.held.length, 1);

  s.state.branch = progress("src/beta.ts");
  await emit("session_branch", s.ctx);
  assert.equal(s.widget.at(-1), "pulse · Editing src/beta.ts");

  await s.release();
  assert.equal(s.widget.at(-1), "pulse · Editing src/beta.ts", "the old branch's summary repainted the strip");
});

test("a summary that settles after shutdown leaves the strip cleared", async () => {
  const emit = loadPulse();
  const s = session("src/alpha.ts");
  await emit("session_start", s.ctx);
  await emit("turn_start", s.ctx);
  await emit("turn_end", s.ctx);
  await settle();
  assert.equal(s.held.length, 1);

  await emit("session_shutdown", s.ctx);
  assert.equal(s.widget.at(-1), undefined);

  await s.release();
  assert.equal(s.widget.at(-1), undefined, "pending work repainted the strip after shutdown");
});

test("a refresh requested after a switch still paints the new session", async () => {
  const emit = loadPulse();
  const a = session("src/alpha.ts");
  const b = session("src/beta.ts");
  await emit("session_start", a.ctx);
  await emit("turn_start", a.ctx);
  await emit("turn_end", a.ctx);
  await settle();

  await emit("session_switch", b.ctx);
  b.state.branch = progress("src/gamma.ts");
  await emit("turn_start", b.ctx);
  await emit("turn_end", b.ctx); // queues behind A's pending loop
  await a.release(); // stale A result is dropped, loop reruns for B
  assert.equal(b.held.length, 1);
  await b.release();
  assert.equal(b.widget.at(-1), "pulse · Editing src/gamma.ts");
  assert.equal(b.widget.some((line) => line?.includes("alpha")), false);
});
