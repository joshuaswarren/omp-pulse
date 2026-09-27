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
  "running checks",
  "running check",
  "running tests",
  "running test",
  "running stuff",
  "running things",
  "running thing",
  "running work",
  "running progress",
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

/** Modifiers that can sit in front of a bare "running …" line without naming a target. */
const RUNNING_MODIFIER = new Set([
  "still", "currently", "just", "now", "again", "really", "actually", "simply",
]);

/** Nouns that do not name a target. "Running" plus only these is as vague as "Running todo". */
const RUNNING_FILLER = new Set([
  "check", "checks", "test", "tests",
  "todo", "todos", "todowrite", "todoread", "task", "tasks",
  "stuff", "thing", "things", "work", "progress",
  "step", "steps", "tool", "tools", "item", "items",
  "something", "anything", "update", "updates", "info",
  "code", "file", "files", "request",
]);

function isBareRunning(norm: string): boolean {
  const words = norm.split(" ").filter((word) => word.length >= 3 && !STOP.has(word));
  let sawRunning = false;
  let sawFiller = false;
  for (const word of words) {
    if (word === "running") {
      sawRunning = true;
      continue;
    }
    if (RUNNING_MODIFIER.has(word)) continue;
    if (RUNNING_FILLER.has(word)) {
      sawFiller = true;
      continue;
    }
    return false;
  }
  return sawRunning && sawFiller;
}

export function isVagueStatus(text: string): boolean {
  const norm = normalize(text);
  if (!norm || VAGUE_LINES.has(norm)) return true;
  if (isBareRunning(norm)) return true;
  const words = norm.split(" ").filter((word) => word.length >= 3 && !STOP.has(word));
  if (words.length === 0) return true;
  return words.every((word) => BARE_STATUS.has(word));
}

const DANGLING_END = new Set(
  `a an the and or but nor so yet because if when while although though whether unless
   that which who whom whose where what how to of for with from into about onto upon on in at by as than via per
   without within across toward towards after before during until since through over under between among against around along
   off up out vs versus then`
    .split(/\s+/)
    .filter(Boolean),
);

/** Words of at most 5 letters that can end a finished status line. Longer tokens use a suffix check. Hanging particles such as just and only are left out. */
const KNOWN_SHORT = new Set(
  `ok ui ux id js ts ai os py sh go rb vm ip io qa pr ci cd db api url uri css git src npm pnpm yarn bun node bash grep glob
   cli gui tui sdk mcp llm ide sql ssh http json yaml yml html omp pid env tmp log err csv svg png jpg pdf xml jwt key
   add all any app args back base best bin body both bug bump busy call cargo check code col data debug deps diff
   docs done draft each edit end error fail fails feat file files find fix flag form full get good grep head help high
   hook host idle index info init issue last left less lib line lines lint list lock log logs main make map mock
   mode model more name new next node note notes now null old open opts out pass patch path phase pid pkg
   port pulse put read real ref repo rev role row run runs same set sha ship show site smol spec src state step stub
   strip style suite sync tab test tests text theme timer todo tool tools tree true turn type unit user ver view wait warn watch
   word words work write yaml yes yet`
    .split(/\s+/)
    .filter((word) => word.length > 0 && word.length <= 5),
);

/** 6–7 letter words that do not match a normal complete ending. */
const KNOWN_LONG = new Set(
  `button column config design layout method number origin public return review rollup schema screen static stream string window`
    .split(/\s+/)
    .filter(Boolean),
);

const COMPLETE_ENDING =
  /(?:ing|ed|es|er|or|ly|ion|al|ic|ty|ry|ow|ew|ay|ey|oy|ee|oo|ous|ful|ive|est|ist|ism|ate|ble|nce|ncy|ity|ory|ary|ery|ship|hood|ward|ment|ness|tion|sion|age|ant|ent|ck|sh|ch|th|gh|ph|nt|st|nd|ld|mp|ct|pt|ng|e|s|y|t|d)$/;

const PROGRESS_WORDS = new Set(
  `edit edits edited editing read reads reading run runs ran running search searched searching grep grepped grepping
   update updates updated updating review reviews reviewed reviewing fix fixes fixed fixing check checks checked checking
   write writes wrote written writing implement implements implemented implementing add adds added adding remove removes
   removed removing test tests tested testing summarize summarizes summarized summarizing ship ships shipped
   shipping debug debugged debugging refactor refactored refactoring install installed installing build builds built
   building compile compiles compiled compiling verify verifies verified verifying finish finishes finished finishing
   start starts started starting block blocks blocked blocking wait waits waited waiting investigate investigates
   investigated investigating explore explores explored exploring scan scans scanned scanning parse parses parsed parsing
   rename renames renamed renaming delete deletes deleted deleting create creates created creating open opens opened
   opening close closes closed closing commit commits committed committing push pushes pushed pushing pull pulls pulled
   pulling merge merges merged merging rebase rebases rebased rebasing lint lints linted linting format formats formatted
   formatting document documents documented documenting design designs designed designing wire wires wired wiring hook
   hooks hooked hooking fetch fetches fetched fetching prepare prepares prepared preparing apply applies applied applying
   draft drafts drafted drafting outline outlines outlined outlining plan plans planned planning trace traces traced
   tracing validate validates validated validating confirm confirms confirmed confirming compare compares compared
   comparing migrate migrates migrated migrating bump bumps bumped bumping publish publishes published publishing
   deploy deploys deployed deploying configure configures configured configuring connect connects connected connecting
   resolve resolves resolved resolving reject rejects rejected rejecting paint paints painted painting inspect inspects
   inspected inspecting audit audits audited auditing index indexes indexed indexing load loads loaded loading save saves
   saved saving continue continues continued continuing keep keeps kept keeping`
    .split(/\s+/)
    .filter(Boolean),
);

const ANSWER_START = /^(yes|no|sure|okay|ok)\b/i;

export function isTruncatedStatus(text: string): boolean {
  let flat = text.replace(/\s+/g, " ").trim().replace(/^["']+|["']+$/g, "").trim();
  if (!flat) return false;
  if (/[—–]$/.test(flat) || /(?:^|\s)-$/.test(flat)) return true;
  if (/[,:;([/\\]$/.test(flat)) return true;
  if (/(?:\.\.\.|…)$/.test(flat)) return true;
  const token = (flat.split(" ").pop() ?? "").replace(/[.!?]+$/g, "");
  if (!token) return true;
  if (DANGLING_END.has(token.toLowerCase())) return true;
  return endsMidWord(token);
}

export function isAnsweringStatus(text: string): boolean {
  const flat = text.replace(/\s+/g, " ").trim().replace(/^["']+|["']+$/g, "").trim();
  return ANSWER_START.test(flat);
}

export function isContentParaphrase(text: string): boolean {
  const words = normalize(text).split(" ").filter(Boolean);
  if (words.length === 0) return false;
  const index = words.findIndex((word) => PROGRESS_WORDS.has(word));
  if (index === 0) return false;
  if (index > 0) return isAdvice(words.join(" "));
  return true;
}

export function isRejectedStatus(text: string): boolean {
  return isTruncatedStatus(text) || isAnsweringStatus(text) || isContentParaphrase(text);
}

function isAdvice(norm: string): boolean {
  return (
    /\b(should|must|ought|shall)\b/.test(norm) ||
    /\b(need|needs|needed) to\b/.test(norm) ||
    /\b(recommend|suggest|suggests|consider|prefer|ensure)\b/.test(norm) ||
    /\bmake sure\b/.test(norm)
  );
}

function endsMidWord(token: string): boolean {
  if (/[0-9./_:`\\]/.test(token)) return false;
  const segment = token.split(/[—–-]/).pop() ?? "";
  if (!segment) return true;
  return unfinishedWord(segment);
}

function unfinishedWord(segment: string): boolean {
  if (!/^[A-Za-z][A-Za-z']*$/.test(segment)) return false;
  const word = segment.toLowerCase().replace(/'/g, "");
  if (!word) return true;
  if (KNOWN_SHORT.has(word) || KNOWN_LONG.has(word)) return false;
  if (word.length >= 6 && COMPLETE_ENDING.test(word)) return false;
  return true;
}

export function extractiveSummary(entries: unknown): string {
  const line = progressSummary(entries);
  if (!line || isVagueStatus(line) || isRejectedStatus(line)) return "";
  return line;
}

function progressSummary(entries: unknown): string {
  const { users, items } = progressOf(entries);
  const actions = concreteActions(actionsOf(items));
  const last = actions[actions.length - 1];
  if (last && !last.ok) return describeTool({ kind: "tool", name: last.name, target: last.target, ok: false, detail: "" });

  const prose = usefulProse(items, users, actions);
  const verbs = phasesOf(actions);
  const aim = prose[0] ?? "";
  if (verbs.length === 0) return aim ? clipWords(aim, 12) : "";
  if (verbs.length === 1) {
    const verb = verbs[0] ?? "Running";
    if (aim && (prose.length === 1 || proseCovers(aim, verb))) return clipWords(aim, 12);
    if (aim) return withNow(aim, nowClause(verb, last));
    if (actions.length === 1 && last) {
      const described = describeCall(last);
      if (described && !isVagueStatus(described)) return described;
    }
    if (verb === "Running" && last?.target) {
      const described = describeCall(last);
      if (described && !isVagueStatus(described)) return described;
    }
    return phaseLabel(verb);
  }

  const current = verbs[verbs.length - 1] ?? "Running";
  const earlier = verbs.slice(0, -1);
  const now = nowClause(current, last);
  if (aim && coversEarlier(aim, earlier) && proseCovers(aim, current)) return clipWords(aim, 12);
  if (aim && !proseCovers(aim, current)) return withNow(aim, now);
  if (!now) return clipWords(doneClause(earlier), 12);
  return clipWords(`${doneClause(earlier)}, now ${now}`, 12);
}

function withNow(lead: string, now: string): string {
  if (!now) return clipWords(lead, 12);
  return clipWords(`${lead}, ${now}`, 12);
}

export function echoesUserRequest(text: string, entries: unknown): boolean {
  return isParaphraseOfAny(text, progressOf(entries).users);
}

/** True when the line is only the latest assistant decision and the turn has earlier work. */
export function echoesLatestClause(text: string, entries: unknown): boolean {
  const { users, items } = progressOf(entries);
  const clauses: string[] = [];
  for (const item of items) {
    if (item.kind !== "assistant" || !item.prose) continue;
    const clean = cleanProse(item.prose);
    if (!clean || isParaphraseOfAny(clean, users)) continue;
    clauses.push(...splitClauses(clean));
  }
  const latest = clauses[clauses.length - 1] ?? "";
  if (!latest || !sameClause(text, latest)) return false;
  const earlierClauses = clauses.slice(0, -1);
  const verbs = phasesOf(concreteActions(actionsOf(items)));
  if (earlierClauses.length === 0 && verbs.length < 2) return false;
  if (earlierClauses.some((clause) => sameClause(text, clause))) return false;
  if (verbs.slice(0, -1).some((verb) => proseCovers(text, verb))) return false;
  return true;
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
    if (!clean || isParaphraseOfAny(clean, users) || isToolEcho(clean, actions) || isVagueStatus(clean) || isRejectedStatus(clean)) continue;
    found.push(clean);
  }
  return found;
}

function cleanProse(text: string): string {
  return stripMarkup(text).replace(/[.!?]+$/g, "").trim();
}

function splitClauses(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?])\s+|\s+[—–]\s+|\s+-\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  return parts.length > 0 ? parts : [text];
}

function sameClause(candidate: string, clause: string): boolean {
  const left = normalize(candidate);
  const right = normalize(clause);
  if (!left || !right) return false;
  if (left === right) return true;
  const words = significantWords(candidate);
  const clauseWords = new Set(significantWords(clause));
  const extra = words.filter((word) => !clauseWords.has(word) && !STATUS_FILLER.has(word));
  if (left.includes(right) && extra.length > 0) return false;
  if (right.includes(left) && left.length >= 12 && left.length < right.length) return true;
  if (words.length < 3) return false;
  let hits = 0;
  for (const word of words) if (clauseWords.has(word)) hits += 1;
  return hits / words.length >= 0.75 && extra.length === 0;
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
  // A generic Running phase has no target. Leave the extract empty so smol can roll the turn up.
  if (verb === "Running") return "";
  return "Continuing the change";
}

function nowClause(verb: string, action: Action | undefined): string {
  if (verb === "Running") {
    const command = action?.target.toLowerCase() ?? "";
    if (/\b(npm|pnpm|yarn|bun) test\b/.test(command) || /\b(pytest|cargo test|go test)\b/.test(command)) {
      return "running tests";
    }
    if (action?.target) return `running ${action.target}`;
    return "";
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
  let prose = item.prose && !isParaphraseOfAny(item.prose, users) ? item.prose : "";
  if (prose && isRejectedStatus(prose)) prose = "";
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
