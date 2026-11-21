import assert from "node:assert/strict";
import test from "node:test";
import ompPulse from "../src/index.ts";

type Handler = (event: unknown, ctx: unknown) => void | Promise<void>;

function progress(file: string) {
  return [
    { type: "message", message: { role: "user", content: "ship the strip" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "edit", arguments: { path: file } }] },
    },
  ];
}

/** Pulse with idle refresh off, a captured timer, and summary requests held open until released. */
function harness() {
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
  const state = { branch: progress("src/a.ts") as unknown, requests: 0 };
  const ticks: Array<() => void> = [];
  const held: Array<(key: string | undefined) => void> = [];
  const ctx = {
    ui: { setStatus() {}, setWidget() {} },
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
    modelRegistry: {
      getApiKey() {
        return new Promise<string | undefined>((resolve) => held.push(resolve));
      },
    },
  };
  const emit = async (event: string) => {
    await handlers.get(event)?.({}, ctx);
  };
  const release = async () => {
    const next = held.shift();
    assert.ok(next, "expected a pending summary request");
    next(undefined);
    await settle();
  };
  return { state, ticks, held, emit, release };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

test("a late summary from turn A does not mark active turn B idle", async () => {
  const pulse = harness();
  await pulse.emit("session_start");
  assert.equal(pulse.ticks.length, 1);

  await pulse.emit("turn_start");
  await pulse.emit("turn_end"); // A's refresh is pending
  await settle();
  assert.equal(pulse.state.requests, 1);

  await pulse.emit("turn_start"); // B is now active
  await pulse.release(); // A's summary completes late, while B runs

  pulse.state.branch = progress("src/b.ts"); // B persists new work
  pulse.ticks[0]?.();
  await settle();
  assert.equal(pulse.state.requests, 2, "the timer must refresh B's changed progress");
  assert.equal(pulse.held.length, 1);
  await pulse.release();
});

test("overlapping turn-end notifications sharing one refresh loop do not mark an active agent idle", async () => {
  const pulse = harness();
  await pulse.emit("session_start");

  await pulse.emit("turn_start");
  await pulse.emit("turn_end"); // A starts the loop
  await settle();
  await pulse.emit("turn_start");
  await pulse.emit("turn_end"); // B queues onto A's loop
  await pulse.emit("turn_start"); // C is active
  await pulse.release(); // A settles; the loop reruns for B
  assert.equal(pulse.state.requests, 2);
  await pulse.release(); // the shared loop settles

  pulse.state.branch = progress("src/c.ts");
  pulse.ticks[0]?.();
  await settle();
  assert.equal(pulse.state.requests, 3, "the timer must refresh C's changed progress");
  await pulse.release();
});

test("the latest turn end still returns pulse to idle", async () => {
  const pulse = harness();
  await pulse.emit("session_start");
  await pulse.emit("turn_start");
  await pulse.emit("turn_end");
  await settle();
  await pulse.release();
  assert.equal(pulse.state.requests, 1);

  pulse.state.branch = progress("src/d.ts");
  pulse.ticks[0]?.();
  await settle();
  assert.equal(pulse.state.requests, 1, "idle refresh is off, so an idle timer tick makes no request");
});
