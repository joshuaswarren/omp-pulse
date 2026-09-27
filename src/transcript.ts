import { clipWords, oneLine } from "./text.ts";

export type TranscriptTail = {
  text: string;
  fingerprint: string;
};

type ToolRef = {
  name: string;
  target: string;
};

type Item =
  | { kind: "user"; text: string }
  | { kind: "assistant"; prose: string; calls: ToolRef[] }
  | { kind: "tool"; name: string; target: string; ok: boolean; detail: string };

const PER_MESSAGE_CHARS = 500;
const TOOL_DETAIL_CHARS = 180;

const STOP = new Set([
  "the", "and", "for", "that", "this", "with", "from", "into", "about", "your",
  "you", "are", "was", "were", "will", "just", "have", "has", "had", "not",
  "but", "its", "can", "should", "would", "could", "please", "than", "then",
  "when", "what", "which", "while", "where", "who", "how", "why", "all", "any",
  "our", "out", "off", "too", "also", "only", "over", "under", "after", "before",
  "again", "here", "there", "they", "them", "their", "one", "let", "make", "sure",
]);

const QUIET_ERRORS = new Set(["Interrupted by user", "Request was aborted", "__omp.silent_abort__"]);

export function recentTranscript(entries: unknown, maxChars: number): TranscriptTail {
  const { users, items } = progressOf(entries);
  const lines: string[] = [];
  for (const item of items) {
    if (item.kind === "assistant") {
      const line = assistantModelLine(item, users);
      if (line) lines.push(line);
      continue;
    }
    const detail = isParaphraseOfAny(item.detail, users) ? "" : item.detail;
    lines.push(toolModelLine({ ...item, detail }));
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = text.slice(text.length - maxChars);
  return { text, fingerprint: text };
}

export function extractiveSummary(entries: unknown): string {
  const { users, items } = progressOf(entries);
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!item) continue;
    if (item.kind === "tool") return describeTool(item);
    const call = item.calls[item.calls.length - 1];
    if (call) return describeCall(call);
    if (item.prose && !isParaphraseOfAny(item.prose, users)) return clipWords(stripMarkup(item.prose), 12);
  }
  return "";
}

export function echoesUserRequest(text: string, entries: unknown): boolean {
  return isParaphraseOfAny(text, progressOf(entries).users);
}

function progressOf(entries: unknown): { users: string[]; items: Array<Exclude<Item, { kind: "user" }>> } {
  const spoken = spokenItems(entries);
  const users: string[] = [];
  let boundary = -1;
  for (let index = 0; index < spoken.length; index += 1) {
    const item = spoken[index];
    if (item?.kind === "user") {
      users.push(item.text);
      boundary = index;
    }
  }
  const items: Array<Exclude<Item, { kind: "user" }>> = [];
  for (const item of spoken.slice(boundary + 1)) {
    if (item.kind !== "user") items.push(item);
  }
  return { users, items: pairTargets(items) };
}

function spokenItems(entries: unknown): Item[] {
  if (!Array.isArray(entries)) return [];
  const items: Item[] = [];
  for (const entry of entries) {
    const item = itemFrom(entry);
    if (item) items.push(item);
  }
  return items;
}

function itemFrom(entry: unknown): Item | undefined {
  if (!isRecord(entry)) return undefined;
  if (entry.type === "custom_message") return customItem(entry);
  if (entry.type !== "message" || !isRecord(entry.message)) return undefined;
  const message = entry.message;
  const role = message.role;
  if (role === "user") {
    const text = textOf(message.content);
    return text ? { kind: "user", text } : undefined;
  }
  if (role === "assistant") return assistantItem(message);
  if (role === "toolResult" || role === "tool") return toolItem(message);
  return undefined;
}

function customItem(entry: Record<string, unknown>): Item | undefined {
  const customType = typeof entry.customType === "string" ? entry.customType : "";
  const text = textOf(entry.content);
  if (!text) return undefined;
  if (entry.attribution === "user" || customType === "skill-prompt") return { kind: "user", text };
  if (entry.attribution === "agent") return { kind: "assistant", prose: text, calls: [] };
  return undefined;
}

function assistantItem(message: Record<string, unknown>): Item | undefined {
  const { prose, calls } = assistantParts(message.content);
  const error = typeof message.errorMessage === "string" ? message.errorMessage.trim() : "";
  if (!prose && calls.length === 0) {
    if (!error || QUIET_ERRORS.has(error)) return undefined;
    return { kind: "tool", name: "model", target: "", ok: false, detail: error };
  }
  return { kind: "assistant", prose, calls };
}

function assistantParts(content: unknown): { prose: string; calls: ToolRef[] } {
  if (typeof content === "string") return { prose: content.trim(), calls: [] };
  if (!Array.isArray(content)) return { prose: "", calls: [] };
  const prose: string[] = [];
  const calls: ToolRef[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      const text = block.text.trim();
      if (text) prose.push(text);
      continue;
    }
    if (block.type === "toolCall" || block.type === "tool_use") {
      const name = typeof block.name === "string" && block.name !== "" ? block.name : "tool";
      const args = block.arguments ?? block.input ?? block.args;
      calls.push({ name, target: targetFromArgs(args) });
    }
  }
  return { prose: prose.join(" ").trim(), calls };
}

function toolItem(message: Record<string, unknown>): Item {
  const name = typeof message.toolName === "string" && message.toolName !== "" ? message.toolName : "tool";
  return {
    kind: "tool",
    name,
    target: targetFromArgs(message.arguments),
    ok: message.isError !== true,
    detail: textOf(message.content),
  };
}

function pairTargets(items: Array<Exclude<Item, { kind: "user" }>>): Array<Exclude<Item, { kind: "user" }>> {
  const pending = new Map<string, string[]>();
  for (const item of items) {
    if (item.kind === "assistant") {
      for (const call of item.calls) {
        const queue = pending.get(call.name) ?? [];
        queue.push(call.target);
        pending.set(call.name, queue);
      }
      continue;
    }
    const queue = pending.get(item.name);
    const queued = queue && queue.length > 0 ? (queue.shift() ?? "") : "";
    if (!item.target) item.target = queued || pathInText(item.detail);
  }
  return items;
}

function assistantModelLine(item: Extract<Item, { kind: "assistant" }>, users: string[]): string | undefined {
  const prose = item.prose && !isParaphraseOfAny(item.prose, users) ? item.prose : "";
  const tools = item.calls
    .map((call) => (call.target ? `[${call.name} ${call.target}]` : `[${call.name}]`))
    .join(" ");
  const body = [prose, tools].filter(Boolean).join(" ");
  if (!body) return undefined;
  return `assistant: ${oneLine(body, PER_MESSAGE_CHARS)}`;
}

function toolModelLine(item: Extract<Item, { kind: "tool" }>): string {
  const head = [item.name, item.target].filter(Boolean).join(" ");
  const state = item.ok ? "" : " failed";
  const detail = item.detail ? `: ${oneLine(item.detail, TOOL_DETAIL_CHARS)}` : "";
  return `tool: ${oneLine(`${head}${state}${detail}`, PER_MESSAGE_CHARS)}`;
}

function describeTool(item: Extract<Item, { kind: "tool" }>): string {
  const label = [item.name, item.target].filter(Boolean).join(" ");
  if (!item.ok) return clipWords(`Blocked on ${label}`.trim(), 12);
  return describeCall({ name: item.name, target: item.target });
}

function describeCall(call: ToolRef): string {
  const verb = verbFor(call.name);
  if (call.target) return clipWords(`${verb} ${call.target}`, 12);
  if (verb === "Running") return clipWords(`Running ${call.name}`, 12);
  return clipWords(`${verb} with ${call.name}`, 12);
}

function verbFor(name: string): string {
  const token = name.toLowerCase();
  if (["write", "edit", "multiedit", "apply_patch", "strreplace", "search_replace"].includes(token)) return "Editing";
  if (["read", "read_file"].includes(token)) return "Reading";
  if (["grep", "search", "glob", "find", "rg"].includes(token)) return "Searching";
  return "Running";
}

function targetFromArgs(args: unknown): string {
  const record = asRecord(args);
  if (!record) return "";
  const path = firstString(record, ["path", "file_path", "filePath", "file", "filename", "target"]);
  if (path) return unwrapPath(path);
  const command = firstString(record, ["command", "cmd"]);
  if (command) return shortCommand(command);
  const pattern = firstString(record, ["pattern", "query", "glob"]);
  if (pattern) return oneLine(pattern, 40);
  return "";
}

function asRecord(args: unknown): Record<string, unknown> | undefined {
  if (isRecord(args)) return args;
  if (typeof args !== "string" || !args.trim().startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function unwrapPath(raw: string): string {
  const trimmed = raw.trim();
  const wrapped = /^\[(.+)#[A-Za-z0-9]+\]$/.exec(trimmed);
  return shortPath(wrapped?.[1] ?? trimmed);
}

function shortPath(path: string): string {
  const parts = path.replace(/\\/g, "/").replace(/^\.\//, "").split("/").filter(Boolean);
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}

function shortCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
}

function pathInText(text: string): string {
  const match = /(?:^|[\s"'`(])((?:[\w.+@~-]+\/)+[\w.+@~-]+\.[\w]{1,8})\b/.exec(text);
  return match?.[1] ? shortPath(match[1]) : "";
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
    }
  }
  return parts.join(" ").trim();
}

function isParaphraseOfAny(candidate: string, users: string[]): boolean {
  return users.some((user) => isParaphrase(candidate, user));
}

function isParaphrase(candidate: string, userText: string): boolean {
  const cand = candidate.trim();
  const user = userText.trim();
  if (!cand || !user) return false;
  const c = normalize(cand);
  const u = normalize(user);
  if (c.length >= 24 && (u.includes(c) || c.includes(u))) return true;
  const userWords = new Set(significantWords(user));
  const words = significantWords(cand);
  if (words.length < 3) return false;
  let hits = 0;
  for (const word of words) if (userWords.has(word)) hits += 1;
  return hits / words.length >= 0.75;
}

function significantWords(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((word) => word.length >= 3 && !STOP.has(word));
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function stripMarkup(text: string): string {
  return text.replace(/[*_`#]/g, " ").replace(/\s+/g, " ").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
