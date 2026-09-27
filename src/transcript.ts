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

type Action = {
  name: string;
  target: string;
  ok: boolean;
};

const STATUS_FILLER = new Set([
  "editing", "reading", "running", "searching", "blocked", "working",
  "code", "file", "files", "checks", "tests", "test", "now", "step",
]);

const VAGUE_LINES = new Set([
  "running todo",
  "running todos",
  "running todowrite",
  "running task",
  "running tasks",
  "working",
  "processing",
  "thinking",
  "updating",
  "busy",
  "loading",
  "in progress",
  "doing stuff",
  "doing things",
  "working on it",
  "still working",
  "still thinking",
  "making progress",
]);

const BARE_STATUS = new Set([
  "running", "working", "processing", "thinking", "updating", "busy", "loading",
  "doing", "handling", "starting", "finishing", "waiting", "editing", "reading",
  "searching", "writing", "fixing", "checking", "reviewing", "pondering",
  "todo", "todos", "todowrite", "todoread", "task", "tasks", "tool", "tools",
  "stuff", "thing", "things", "work", "progress", "request", "item", "items",
  "step", "steps", "something", "anything", "update", "updates", "info",
  "still", "currently", "just", "now", "again", "really", "actually", "simply",
  "hard", "please", "wait", "moment", "around", "through", "onto",
]);

const BOOKKEEPING = new Set([
  "todo", "todos", "todowrite", "todoread", "updatetodos", "task", "tasks",
  "taskcreate", "taskupdate", "tasklist", "taskwrite",
]);

export function isVagueStatus(text: string): boolean {
  const norm = normalize(text);
  if (!norm || VAGUE_LINES.has(norm)) return true;
  const words = norm.split(" ").filter((word) => word.length >= 3 && !STOP.has(word));
  if (words.length === 0) return true;
  return words.every((word) => BARE_STATUS.has(word));
}

export function extractiveSummary(entries: unknown): string {
  const line = progressSummary(entries);
  return line && !isVagueStatus(line) ? line : "";
}

function progressSummary(entries: unknown): string {
  const { users, items } = progressOf(entries);
  const actions = concreteActions(actionsOf(items));
  const last = actions[actions.length - 1];
  if (last && !last.ok) return describeTool({ kind: "tool", name: last.name, target: last.target, ok: false, detail: "" });

  const prose = usefulProse(items, users, actions);
  const verbs = phasesOf(actions);
  if (verbs.length === 0) {
    const line = prose[prose.length - 1] ?? "";
    return line ? clipWords(line, 12) : "";
  }
  if (verbs.length === 1) {
    const line = prose[prose.length - 1];
    if (line) return clipWords(line, 12);
    if (actions.length === 1 && last) {
      const described = describeCall(last);
      if (described) return described;
    }
    return phaseLabel(verbs[0] ?? "Running");
  }

  const current = verbs[verbs.length - 1] ?? "Running";
  const earlier = verbs.slice(0, -1);
  const aim = prose[0] ?? "";
  const now = nowClause(current, last);
  if (aim && coversEarlier(aim, earlier) && proseCovers(aim, current)) return clipWords(aim, 12);
  if (aim && !proseCovers(aim, current)) return clipWords(`${aim}, ${now}`, 12);
  return clipWords(`${doneClause(earlier)}, now ${now}`, 12);
}

export function echoesUserRequest(text: string, entries: unknown): boolean {
  return isParaphraseOfAny(text, progressOf(entries).users);
}

export function echoesLatestAction(text: string, entries: unknown): boolean {
  const actions = concreteActions(actionsOf(progressOf(entries).items));
  if (actions.length < 2) return false;
  const last = actions[actions.length - 1];
  if (!last) return false;
  const norm = normalize(text);
  if (!norm) return false;
  if (norm === normalize(describeCall(last))) return true;
  const lastBits = actionBits(last);
  if (!lastBits.some((bit) => hasTokens(norm, bit))) return false;
  const earlierBits = actions
    .slice(0, -1)
    .flatMap((action) => actionBits(action))
    .filter((bit) => !lastBits.includes(bit));
  if (earlierBits.some((bit) => hasTokens(norm, bit))) return false;
  let stripped = norm;
  for (const bit of lastBits) stripped = stripped.split(bit).join(" ");
  const leftover = stripped
    .split(" ")
    .filter((word) => word.length >= 3 && !STOP.has(word) && !STATUS_FILLER.has(word));
  return leftover.length === 0;
}

function concreteActions(actions: Action[]): Action[] {
  return actions.filter((action) => !isBookkeeping(action));
}

function isBookkeeping(action: Action): boolean {
  const name = action.name.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (!BOOKKEEPING.has(name) && !name.includes("todo")) return false;
  return !action.target.includes("/") && !/\.[a-z0-9]{1,8}$/i.test(action.target);
}

function actionsOf(items: Array<Exclude<Item, { kind: "user" }>>): Action[] {
  const actions: Action[] = [];
  const pending: Action[] = [];
  for (const item of items) {
    if (item.kind === "assistant") {
      for (const call of item.calls) {
        const action = { name: call.name, target: call.target, ok: true };
        actions.push(action);
        pending.push(action);
      }
      continue;
    }
    const match = pending.find((action) => action.name === item.name);
    if (match) {
      if (!match.target) match.target = item.target;
      if (!item.ok) match.ok = false;
      pending.splice(pending.indexOf(match), 1);
      continue;
    }
    actions.push({ name: item.name, target: item.target, ok: item.ok });
  }
  return actions;
}

function phasesOf(actions: Action[]): string[] {
  const phases: string[] = [];
  for (const action of actions) {
    const verb = verbFor(action.name);
    if (phases[phases.length - 1] !== verb) phases.push(verb);
  }
  return phases;
}

function usefulProse(
  items: Array<Exclude<Item, { kind: "user" }>>,
  users: string[],
  actions: Action[],
): string[] {
  const found: string[] = [];
  for (const item of items) {
    if (item.kind !== "assistant" || !item.prose) continue;
    const clean = cleanProse(item.prose);
    if (!clean || isParaphraseOfAny(clean, users) || isToolEcho(clean, actions) || isVagueStatus(clean)) continue;
    found.push(clean);
  }
  return found;
}

function cleanProse(text: string): string {
  return stripMarkup(text).replace(/[.!?]+$/g, "").trim();
}

function isToolEcho(prose: string, actions: Action[]): boolean {
  let stripped = normalize(prose);
  for (const action of actions) {
    for (const bit of actionBits(action)) stripped = stripped.split(bit).join(" ");
  }
  const words = stripped.split(" ").filter((word) => word.length >= 3 && !STOP.has(word));
  return words.length < 2;
}

function actionBits(action: Action): string[] {
  const bits = [normalize(action.name), normalize(action.target)];
  const base = action.target.split("/").pop() ?? "";
  if (base) bits.push(normalize(base));
  return [...new Set(bits.filter((bit) => bit.length >= 3))];
}

function hasTokens(text: string, bit: string): boolean {
  const tokens = text.split(" ").filter(Boolean);
  const parts = bit.split(" ").filter(Boolean);
  if (parts.length === 0) return false;
  for (let index = 0; index <= tokens.length - parts.length; index += 1) {
    if (parts.every((part, offset) => tokens[index + offset] === part)) return true;
  }
  return false;
}

function proseCovers(prose: string, verb: string): boolean {
  const text = normalize(prose);
  if (verb === "Editing") return /\bedit/.test(text);
  if (verb === "Reading") return /\bread/.test(text);
  if (verb === "Searching") return /\b(search|grep|find)\b/.test(text);
  if (verb === "Running") return /\b(run|running|test|bash)\b/.test(text);
  return false;
}

function coversEarlier(prose: string, earlier: string[]): boolean {
  return earlier.some((verb) => proseCovers(prose, verb));
}

function phaseLabel(verb: string): string {
  if (verb === "Editing") return "Editing the code";
  if (verb === "Reading") return "Reading the code";
  if (verb === "Searching") return "Searching the code";
  if (verb === "Running") return "Running checks";
  return "Continuing the change";
}

function nowClause(verb: string, action: Action | undefined): string {
  if (verb === "Running") {
    const command = action?.target.toLowerCase() ?? "";
    if (/\b(npm|pnpm|yarn|bun) test\b/.test(command) || /\b(pytest|cargo test|go test)\b/.test(command)) {
      return "running tests";
    }
    if (action?.target) return `running ${action.target}`;
    return "running checks";
  }
  if (verb === "Editing") return "editing the code";
  if (verb === "Reading") return "reading the code";
  if (verb === "Searching") return "searching the code";
  return "continuing the change";
}

function doneClause(verbs: string[]): string {
  const kinds = new Set(verbs);
  const review = [...kinds].every((verb) => verb === "Reading" || verb === "Searching");
  if (review && kinds.has("Reading") && kinds.has("Searching")) return "Reviewed the code";
  if (review && kinds.has("Searching")) return "Searched the code";
  if (review) return "Read the code";
  if (kinds.has("Editing")) return "Updated the code";
  if (kinds.has("Running")) return "Ran checks";
  return "Continued the change";
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
  if (verb === "Running") return "";
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
