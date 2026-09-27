import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paint, pulseNotice, STATUS_KEY, statusLine, type ChromeUi } from "./chrome.ts";
import { DEFAULT_CONFIG_PATH, loadConfig, type PulseConfig } from "./config.ts";
import { type PulseModelHost } from "./summarize.ts";
import { extractiveSummary, isVagueStatus } from "./transcript.ts";
import { runTick, type Phase } from "./tick.ts";

type PulseUi = ChromeUi & {
  notify?(message: string, type?: "info" | "warning" | "error"): void;
};

type PulseHost = PulseModelHost & {
  ui: PulseUi;
  sessionManager?: { getBranch?: () => unknown };
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
};

type PulseEvent =
  | "session_start"
  | "session_switch"
  | "session_branch"
  | "turn_start"
  | "turn_end"
  | "session_shutdown";

type PiApi = {
  on(event: PulseEvent, handler: (event: unknown, ctx: PulseHost) => void | Promise<void>): void;
  registerCommand(
    name: string,
    options: { description: string; handler: (args: string | undefined, ctx: PulseHost) => void | Promise<void> },
  ): void;
};

export default function ompPulse(pi: PiApi): void {
  const config = loadConfig();
  let host: PulseHost | null = null;
  let phase: Phase = "idle";
  let previousFingerprint = "";
  let timer: unknown;
  let started = false;
  let running = false;
  let queued = false;
  let queuedForce = false;
  let loop: Promise<void> | null = null;
  const strip = { showVersion: config.showVersion };
  let lastLine = statusLine("idle", strip);

  function readEntries(): unknown {
    try {
      return host?.sessionManager?.getBranch?.() ?? [];
    } catch {
      return [];
    }
  }

  function showExtract(emptyBody: string): void {
    if (!host) return;
    const extracted = extractiveSummary(readEntries());
    const body = extracted && !isVagueStatus(extracted) ? extracted : emptyBody;
    if (!body || isVagueStatus(body)) return;
    lastLine = statusLine(body, strip);
    paint(host.ui, config, lastLine);
  }

  function refresh(force: boolean): Promise<void> {
    if (!host) return Promise.resolve();
    if (running && loop) {
      queued = true;
      queuedForce = queuedForce || force;
      return loop;
    }
    loop = runLoop(force).finally(() => {
      running = false;
      loop = null;
    });
    return loop;
  }

  async function runLoop(force: boolean): Promise<void> {
    running = true;
    let useForce = force;
    do {
      const forced = useForce || queuedForce;
      useForce = false;
      queued = false;
      queuedForce = false;
      const result = await runTick({
        phase,
        config,
        entries: readEntries(),
        previousFingerprint,
        force: forced,
        host: host ?? undefined,
      });
      if (result.action === "paint" && host) {
        if (result.source === "model") previousFingerprint = result.fingerprint;
        lastLine = result.line;
        paint(host.ui, config, result.line);
      }
    } while (queued);
  }

  function arm(ctx: PulseHost, cfg: PulseConfig): void {
    host = ctx;
    if (started) return;
    started = true;
    try {
      mkdirSync(dirname(DEFAULT_CONFIG_PATH), { recursive: true });
    } catch {
      /* unwritable home still uses defaults */
    }
    showExtract("idle");
    const tick = () => {
      void refresh(false);
    };
    if (typeof ctx.setInterval === "function") {
      timer = ctx.setInterval(tick, cfg.intervalMs);
      return;
    }
    const handle = setInterval(tick, cfg.intervalMs);
    handle.unref?.();
    timer = handle;
  }

  pi.on("session_start", (_event, ctx) => {
    phase = "idle";
    previousFingerprint = "";
    arm(ctx, config);
  });

  pi.on("session_switch", (_event, ctx) => {
    host = ctx;
    phase = "idle";
    previousFingerprint = "";
    showExtract("idle");
  });

  pi.on("session_branch", (_event, ctx) => {
    host = ctx;
    previousFingerprint = "";
    showExtract(phase === "inTurn" ? "" : "idle");
  });

  pi.on("turn_start", (_event, ctx) => {
    host = ctx;
    phase = "inTurn";
    showExtract("");
  });

  pi.on("turn_end", (_event, ctx) => {
    host = ctx;
    void refresh(false).finally(() => {
      phase = "idle";
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (timer !== undefined && typeof ctx.clearTimer === "function") ctx.clearTimer(timer);
    else if (timer !== undefined) clearInterval(timer as ReturnType<typeof setInterval>);
    timer = undefined;
    ctx.ui.setStatus(STATUS_KEY, undefined);
    try {
      ctx.ui.setWidget(STATUS_KEY, undefined);
    } catch {
      /* status is already cleared */
    }
  });

  pi.registerCommand("pulse", {
    description: "Refresh the omp-pulse strip from the current transcript",
    handler: async (_args, ctx) => {
      host = ctx;
      await refresh(true);
      ctx.ui.notify?.(pulseNotice(lastLine), "info");
    },
  });
}
