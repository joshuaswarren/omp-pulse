import type { Placement, Surface } from "./config.ts";
import { fitStripBody, HARD_LINE_CHARS, PREFERRED_BODY_CHARS, PREFERRED_LINE_CHARS, STATUS_PREFIX } from "./text.ts";

export const STATUS_KEY = "omp-pulse";
export { PREFERRED_LINE_CHARS, STATUS_PREFIX };

export type ChromeUi = {
  setStatus(key: string, text: string | undefined): void;
  setWidget(
    key: string,
    content:
      | string[]
      | undefined
      | ((tui: unknown, theme: { fg?: (token: string, text: string) => string }) => { render: () => string[] }),
    options?: { placement?: Placement },
  ): void;
};

export function isTooLongForStrip(body: string): boolean {
  const flat = body.replace(/\s+/g, " ").trim();
  if (!flat || flat.endsWith("...") || flat.endsWith("…")) return true;
  return `${STATUS_PREFIX}${flat}`.length > PREFERRED_LINE_CHARS;
}

export function statusLine(body: string): string {
  const clean = fitStripBody(body, PREFERRED_BODY_CHARS);
  const line = clean ? `${STATUS_PREFIX}${clean}` : `${STATUS_PREFIX}idle`;
  return line.length <= HARD_LINE_CHARS ? line : `${STATUS_PREFIX}idle`;
}

export function paint(
  ui: ChromeUi,
  config: { surface: Surface; placement: Placement },
  line: string,
): void {
  const showStatus = config.surface === "status" || config.surface === "both";
  const showWidget = config.surface === "widget" || config.surface === "both";

  if (showStatus) ui.setStatus(STATUS_KEY, line);

  if (showWidget) {
    try {
      ui.setWidget(
        STATUS_KEY,
        (_tui, theme) => ({ render: () => [themeLine(theme, line)] }),
        { placement: config.placement },
      );
    } catch {
      if (config.surface === "widget") ui.setStatus(STATUS_KEY, line);
      return;
    }
  } else {
    clearWidget(ui);
  }

  if (config.surface === "widget") ui.setStatus(STATUS_KEY, undefined);
}

function clearWidget(ui: ChromeUi): void {
  try {
    ui.setWidget(STATUS_KEY, undefined);
  } catch {
    /* status line is the only surface on this host */
  }
}

function themeLine(theme: { fg?: (token: string, text: string) => string }, line: string): string {
  if (typeof theme.fg !== "function") return line;
  const mark = STATUS_PREFIX;
  if (!line.startsWith(mark)) return theme.fg("text", line);
  return theme.fg("accent", "pulse") + theme.fg("dim", " · ") + theme.fg("text", line.slice(mark.length));
}
