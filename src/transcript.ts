import { oneLine } from "./text.ts";

export type TranscriptTail = {
  text: string;
  fingerprint: string;
};

type Spoken = {
  role: "user" | "assistant" | "tool";
  text: string;
};

const PER_MESSAGE_CHARS = 500;

export function recentTranscript(entries: unknown, maxChars: number): TranscriptTail {
  const lines = spokenLines(entries).map((line) => `${label(line.role)}: ${oneLine(line.text, PER_MESSAGE_CHARS)}`);
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return { text, fingerprint: text };
}

export function extractiveSummary(entries: unknown): string {
  let user = "";
  let assistant = "";
  let tool = "";
  for (const line of spokenLines(entries)) {
    if (line.role === "user") user = line.text;
    if (line.role === "assistant") assistant = line.text;
    if (line.role === "tool") tool = line.text;
  }
  if (user && assistant) return `${oneLine(user, 28)} → ${oneLine(assistant, 40)}`;
  if (assistant) return oneLine(assistant, 72);
  if (tool) return oneLine(tool, 72);
  if (user) return oneLine(user, 72);
  return "";
}

function spokenLines(entries: unknown): Spoken[] {
  if (!Array.isArray(entries)) return [];
  const lines: Spoken[] = [];
  for (const entry of entries) {
    const spoken = spokenFrom(entry);
    if (spoken) lines.push(spoken);
  }
  return lines;
}

function spokenFrom(entry: unknown): Spoken | undefined {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const message = entry.message;
  const role = message.role;
  if (role === "user") {
    const text = textOf(message.content);
    return text ? { role: "user", text } : undefined;
  }
  if (role === "assistant") {
    const text = textOf(message.content);
    return text ? { role: "assistant", text } : undefined;
  }
  if (role === "toolResult" || role === "tool") {
    const name = typeof message.toolName === "string" ? message.toolName : "tool";
    const text = textOf(message.content);
    return { role: "tool", text: text ? `${name}: ${text}` : name };
  }
  return undefined;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (text) parts.push(text);
      continue;
    }
    if (block.type === "toolCall" || block.type === "tool_use") {
      const name = typeof block.name === "string" && block.name !== "" ? block.name : "tool";
      parts.push(`[${name}]`);
    }
  }
  return parts.join(" ").trim();
}

function label(role: Spoken["role"]): string {
  if (role === "tool") return "tool";
  return role;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
