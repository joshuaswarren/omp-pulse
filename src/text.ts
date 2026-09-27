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

/** Drop whole words until the body fits the strip. Never adds an ellipsis. */
export function fitStripBody(text: string, max: number = PREFERRED_BODY_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  if (flat.length <= max && !flat.endsWith("...") && !flat.endsWith("…")) return flat;
  const kept: string[] = [];
  for (const word of flat.replace(/(?:\.\.\.|…)\s*$/g, "").split(" ")) {
    if (!word) continue;
    const next = kept.length === 0 ? word : `${kept.join(" ")} ${word}`;
    if (next.length > max) break;
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
  return line.length <= max ? line : "";
}

export function clipWords(text: string, maxWords: number): string {
  return fitStripBody(limitWords(text, maxWords));
}
