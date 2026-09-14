import type { SessionMessageInfo } from "@opencode/client";
import type { SessionEntry, SessionPart } from "./types";

export function getSessionEntries(
  messages: readonly SessionMessageInfo[],
): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const info of messages) {
    const parts = getMessageParts(info);
    if (parts.length === 0) continue;
    entries.push({ info, parts });
  }
  return entries;
}

export function formatFullContext(entries: SessionEntry[], tokenLimit: number) {
  return buildCopiedContext(entries, tokenLimit).text;
}

export function buildCopiedContext(entries: SessionEntry[], tokenLimit: number) {
  const chunks = entries
    .map((entry) => {
      const text = formatEntry(entry);
      return text ? { text, tokens: estimateTokens(text) } : undefined;
    })
    .filter((chunk): chunk is { text: string; tokens: number } => Boolean(chunk));
  const totalAvailableTokens = chunks.reduce(
    (total, chunk) => total + chunk.tokens,
    0,
  );
  const selected: string[] = [];
  let usedTokens = 0;

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];
    if (selected.length > 0 && usedTokens + chunk.tokens > tokenLimit) break;

    selected.push(chunk.text);
    usedTokens += chunk.tokens;

    if (usedTokens >= tokenLimit) break;
  }

  if (selected.length === 0) {
    return {
      text: "No conversation context available.",
      usedTokens: 0,
      totalAvailableTokens,
    };
  }

  return {
    text: selected.reverse().join("\n\n"),
    usedTokens,
    totalAvailableTokens,
  };
}

export function getMessageParts(info: SessionMessageInfo): SessionPart[] {
  if (info.type === "user") {
    const text = info.text.trim();
    return text ? [{ type: "text", text }] : [];
  }

  if (info.type === "assistant") {
    const parts: SessionPart[] = [];
    for (const content of info.content) {
      if (content.type === "text") {
        if (content.text.trim()) parts.push({ type: "text", text: content.text.trim() });
        continue;
      }
      if (content.type === "reasoning") {
        if (content.text.trim()) {
          parts.push({
            type: "reasoning",
            text: content.text.trim(),
            time: content.time
              ? { created: content.time.created, completed: content.time.completed }
              : undefined,
          });
        }
        continue;
      }
      if (content.type === "tool") {
        parts.push({
          type: "tool",
          name: content.name,
          status: content.state.status,
          input: getToolInput(content.state),
          title: getToolTitle(content.state),
        });
      }
    }
    return parts;
  }

  return [];
}

function getToolInput(state: { status: string; input?: unknown }): Record<string, unknown> | undefined {
  if (!state.input || typeof state.input !== "object" || Array.isArray(state.input)) {
    return undefined;
  }
  return state.input as Record<string, unknown>;
}

function getToolTitle(state: unknown): string | undefined {
  if (!state || typeof state !== "object") return undefined;
  const metadata = (state as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const title = (metadata as { title?: unknown }).title;
  return typeof title === "string" && title.trim() ? title : undefined;
}

function formatEntry(entry: SessionEntry) {
  const lines: string[] = [];

  for (const part of entry.parts) {
    if (part.type === "text" && part.text.trim()) lines.push(part.text.trim());
    if (part.type === "tool") lines.push(formatToolPart(part));
  }

  if (lines.length === 0) return "";
  return `${entry.info.type}:\n${lines.join("\n")}`;
}

function formatToolPart(part: Extract<SessionPart, { type: "tool" }>) {
  const pairs = Object.entries(part.input ?? {})
    .slice(0, 4)
    .map(([key, value]) => `${key}=${summarizeValue(value)}`);
  return pairs.length > 0
    ? `[tool: ${part.name} ${pairs.join(" ")}]`
    : `[tool: ${part.name}]`;
}

function summarizeValue(value: unknown): string {
  if (typeof value === "string") return truncate(value.replace(/\s+/g, " "), 48);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  if (value && typeof value === "object") return "{...}";
  return String(value);
}

function truncate(value: string, maxLength: number) {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 3)}...`
    : value;
}

export function estimateTokens(text: string) {
  return Math.ceil(text.length / 3.4);
}
