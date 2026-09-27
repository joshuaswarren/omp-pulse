import type { ProviderConfig } from "./config.ts";
import { limitWords, PREFERRED_BODY_CHARS } from "./text.ts";

/** omp model role for the cheap one-line rewrite. `ctx.models.resolve` expands `modelRoles.smol`. */
export const SMOL_ROLE = "@smol";

export type SmolModel = {
  readonly id: string;
  readonly provider: string;
};

export type SmolApiKey = string | ((...args: never[]) => Promise<string | undefined>);

export type SmolComplete = (
  model: SmolModel,
  context: {
    systemPrompt?: string[];
    messages: Array<{ role: "user"; content: string; timestamp: number }>;
  },
  options?: {
    apiKey?: SmolApiKey;
    maxTokens?: number;
    disableReasoning?: boolean;
    signal?: AbortSignal;
  },
) => Promise<{
  stopReason: string;
  errorMessage?: string;
  content: ReadonlyArray<{ type: string; text?: string }>;
}>;

/** Narrow slice of the live extension ctx: `models.resolve` and `modelRegistry`. */
export type PulseModelHost = {
  models?: {
    resolve(spec: string): SmolModel | undefined;
  };
  modelRegistry?: {
    getApiKey(model: SmolModel): Promise<string | undefined>;
    resolver?(model: SmolModel): SmolApiKey;
  };
};

export type Summary = {
  text: string;
  source: "model" | "extract";
};

function systemPrompt(bodyChars: number): string {
  return [
    "Write one status line for the agent's overall progress this turn.",
    `Present tense. At most 12 words and ${bodyChars} characters.`,
    "The painted strip is pulse, a dot, and this line, and must stay within 60 characters.",
    "No ellipsis. Never end with three dots.",
    "Roll up the entire current turn: the goal, the phase, what is done, what is in flight, and what comes next.",
    "Summarize across the whole turn. Do not report only the latest decision, the latest assistant sentence, the latest tool, file, or command.",
    "Name a concrete object. Never answer with a bare status verb or a tool name alone.",
    "Never answer: Running checks, Running tests, Running todo, Working, Processing, Thinking, Updating, Busy, Loading, In progress, Doing stuff.",
    "The transcript is agent work since the user spoke, not the user's request.",
    "Never restate or paraphrase the user's request.",
    "Never start with Yes, No, Sure, or Okay.",
    "Never stop mid-word, mid-phrase, or on a dash.",
    "Progress only: what is done, in flight, and next. Never advise or restate draft content about the topic.",
    "No quotes, markdown, or advice.",
    "If the transcript shows no concrete step, describe the files or commands already touched.",
  ].join(" ");
}

export async function summarize(input: {
  transcript: string;
  fallback: string;
  provider: ProviderConfig;
  host?: PulseModelHost;
  fetchImpl?: typeof fetch;
  completeImpl?: SmolComplete;
  /** Body budget inside the 60-character strip. Shrinks when the version tell is painted. */
  bodyChars?: number;
}): Promise<Summary> {
  const fallback = input.fallback.trim() || "idle";
  const bodyChars = input.bodyChars ?? PREFERRED_BODY_CHARS;
  if (!input.transcript.trim()) return { text: fallback, source: "extract" };
  if (input.provider.baseUrl === "") return summarizeWithSmol(input, fallback, bodyChars);
  const url = completionsUrl(input.provider.baseUrl);
  if (!url || input.provider.model === "") return { text: fallback, source: "extract" };

  const fetchImpl = input.fetchImpl ?? fetch;
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (input.provider.apiKey !== "") headers.authorization = `Bearer ${input.provider.apiKey}`;
    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: input.provider.model,
        temperature: 0,
        max_tokens: 60,
        messages: [
          { role: "system", content: systemPrompt(bodyChars) },
          { role: "user", content: input.transcript },
        ],
      }),
      signal: AbortSignal.timeout(input.provider.timeoutMs),
    });
    if (!response.ok) return { text: fallback, source: "extract" };
    const body: unknown = await response.json();
    const text = cleanModelText(readContent(body));
    if (!text) return { text: fallback, source: "extract" };
    return { text, source: "model" };
  } catch {
    return { text: fallback, source: "extract" };
  }
}

async function summarizeWithSmol(
  input: {
    transcript: string;
    provider: ProviderConfig;
    host?: PulseModelHost;
    completeImpl?: SmolComplete;
  },
  fallback: string,
  bodyChars: number,
): Promise<Summary> {
  const resolve = input.host?.models?.resolve;
  const registry = input.host?.modelRegistry;
  if (!resolve || !registry?.getApiKey) return { text: fallback, source: "extract" };

  try {
    const model = resolve(SMOL_ROLE);
    if (!model) return { text: fallback, source: "extract" };
    const apiKey = await registry.getApiKey(model);
    if (!apiKey) return { text: fallback, source: "extract" };
    const complete = input.completeImpl ?? (await loadCompleteSimple());
    const response = await complete(
      model,
      {
        systemPrompt: [systemPrompt(bodyChars)],
        messages: [{ role: "user", content: input.transcript, timestamp: Date.now() }],
      },
      {
        apiKey: registry.resolver?.(model) ?? apiKey,
        maxTokens: 60,
        disableReasoning: true,
        signal: AbortSignal.timeout(input.provider.timeoutMs),
      },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") {
      return { text: fallback, source: "extract" };
    }
    const text = cleanModelText(textFromContent(response.content));
    if (!text) return { text: fallback, source: "extract" };
    return { text, source: "model" };
  } catch {
    return { text: fallback, source: "extract" };
  }
}

async function loadCompleteSimple(): Promise<SmolComplete> {
  const { completeSimple } = await import("@oh-my-pi/pi-ai");
  return completeSimple;
}

function textFromContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join(" ");
}

export function completionsUrl(baseUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  const path = parsed.pathname.replace(/\/+$/, "");
  parsed.pathname = path.endsWith("/chat/completions") ? path : `${path}/chat/completions`;
  parsed.hash = "";
  return parsed.toString();
}

function readContent(body: unknown): string {
  if (!isRecord(body) || !Array.isArray(body.choices)) return "";
  const choice = body.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return "";
  const content = choice.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") parts.push(part);
    else if (isRecord(part) && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join(" ");
}

function cleanModelText(raw: string): string {
  let text = raw.replace(/\s+/g, " ").trim();
  text = text.replace(/^(summary|status)\s*:\s*/i, "");
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
  return limitWords(text, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
