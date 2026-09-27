import type { Placement, Surface } from "./config.ts";
import { oneLine } from "./text.ts";

export const STATUS_KEY = "omp-pulse";

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

export function statusLine(body: string): string {
  const clean = oneLine(body, 72);
  return clean ? `pulse · ${clean}` : "pulse · idle";
}

export function paint(
  ui: ChromeUi,
  config: { surface: Surface; placement: Placement },
  line: string,
): void {
  if (config.surface === "status" || config.surface === "both") {
    ui.setStatus(STATUS_KEY, line);
  }
  if (config.surface !== "widget" && config.surface !== "both") return;
  try {
    ui.setWidget(
      STATUS_KEY,
      (_tui, theme) => ({ render: () => [themeLine(theme, line)] }),
      { placement: config.placement },
    );
  } catch {
    if (config.surface === "widget") ui.setStatus(STATUS_KEY, line);
  }
}

function themeLine(theme: { fg?: (token: string, text: string) => string }, line: string): string {
  if (typeof theme.fg !== "function") return line;
  const mark = "pulse · ";
  if (!line.startsWith(mark)) return theme.fg("text", line);
  return theme.fg("accent", "pulse") + theme.fg("dim", " · ") + theme.fg("text", line.slice(mark.length));
}
