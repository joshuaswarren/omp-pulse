export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

export function clipWords(text: string, maxWords: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return "";
  const words = flat.split(" ");
  const clipped = words.length <= maxWords ? flat : words.slice(0, maxWords).join(" ");
  return oneLine(clipped, 72);
}
