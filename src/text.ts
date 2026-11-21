/** Painted row, including the `pulse · ` mark. Prefer this; never exceed the hard cap. */
export const PREFERRED_LINE_CHARS = 60;
export const HARD_LINE_CHARS = 80;
export const STATUS_PREFIX = "pulse · ";
export const PREFERRED_BODY_CHARS = PREFERRED_LINE_CHARS - STATUS_PREFIX.length;

const CUT_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "nor", "so", "to", "of", "for", "with",
  "on", "in", "at", "by", "from", "into", "as", "that", "if", "when",
  "just", "only",
]);

// ESC/C1-introduced terminal sequences: CSI, OSC/DCS/SOS/PM/APC strings
// (BEL- or ST-terminated, or running to the end), and two-byte escapes.
const TERMINAL_SEQUENCE =
  /\x1b\[[0-?]*[ -\/]*[@-~]|\x9b[0-?]*[ -\/]*[@-~]|\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)|[\x90\x98\x9d\x9e\x9f][\s\S]*?(?:\x07|\x9c|$)|\x1b[ -\/]*[0-~]?/g;
// Remaining C0 (except whitespace the callers collapse), DEL and C1 controls.
const CONTROL_CHARS = /[\x00-\x08\x0e-\x1f\x7f-\x9f]/g;

/** Remove content-originated terminal controls. Theme ANSI is added after this. */
export function stripTerminalControls(text: string): string {
  return text.replace(TERMINAL_SEQUENCE, "").replace(CONTROL_CHARS, "");
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const EAST_ASIAN_WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
// A segment carrying VS16 or the keycap mark renders in emoji presentation:
// two columns even when its base (a digit) is not itself pictographic.
const EMOJI = /\p{Emoji_Presentation}|\uFE0F|\u20E3/u;
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]+$/u;

/** Terminal columns: wide East Asian and emoji graphemes take two, combining marks none. */
export function displayColumns(text: string): number {
  if (/^[\x20-\x7e]*$/.test(text)) return text.length;
  let columns = 0;
  for (const { segment } of GRAPHEMES.segment(text)) {
    if (ZERO_WIDTH.test(segment)) continue;
    columns += EAST_ASIAN_WIDE.test(segment) || EMOJI.test(segment) ? 2 : 1;
  }
  return columns;
}

export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function limitWords(text: string, maxWords: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const words = flat.split(" ");
  return words.length <= maxWords ? flat : words.slice(0, maxWords).join(" ");
}

/** Drop whole words until the body fits `max` terminal columns. Never adds an ellipsis. */
export function fitStripBody(text: string, max: number = PREFERRED_BODY_CHARS): string {
  const flat = stripTerminalControls(text).replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (displayColumns(flat) <= max && !flat.endsWith("...") && !flat.endsWith("…")) return flat;
  const kept: string[] = [];
  for (const word of flat.replace(/(?:\.\.\.|…)\s*$/g, "").split(" ")) {
    if (!word) continue;
    const next = kept.length === 0 ? word : `${kept.join(" ")} ${word}`;
    if (displayColumns(next) > max) break;
    kept.push(word);
  }
  while (kept.length > 0) {
    const last = kept[kept.length - 1] ?? "";
    const bare = last.replace(/[,:;.—–-]+$/g, "");
    if (bare !== last) {
      if (bare) kept[kept.length - 1] = bare;
      else kept.pop();
      continue;
    }
    if (CUT_WORDS.has(bare.toLowerCase())) {
      kept.pop();
      continue;
    }
    break;
  }
  const line = kept.join(" ");
  return displayColumns(line) <= max ? line : "";
}

export function clipWords(text: string, maxWords: number): string {
  return fitStripBody(limitWords(text, maxWords));
}
