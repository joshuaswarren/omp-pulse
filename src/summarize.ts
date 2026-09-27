import type { ProviderConfig } from "./config.ts";
import { clipWords } from "./text.ts";

export type Summary = {
  text: string;
  source: "model" | "extract";
};

const SYSTEM_PROMPT = [
  "Write one status line for the coding agent's current progress.",
  "Present tense. At most 12 words.",
  "Name tools, files, the current step, or a blocker shown in the transcript.",
  "The transcript is agent work since the user spoke, not the user's request.",
  "Never restate or paraphrase the user's request.",
  "No quotes, markdown, or advice.",
  "If the transcript shows no agent progress, answer: working",
].join(" ");

export async function summarize(input: {
  transcript: string;
  fallback: string;
  provider: ProviderConfig;
  fetchImpl?: typeof fetch;
}): Promise<Summary> {
  const fallback = input.fallback.trim() || "working";
  if (!input.transcript.trim()) return { text: fallback, source: "extract" };
  const url = completionsUrl(input.provider.baseUrl);
  if (!url) return { text: fallback, source: "extract" };

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
          { role: "system", content: SYSTEM_PROMPT },
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
  return clipWords(text, 12);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
