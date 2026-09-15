/**
 * Pure presentation logic for the mini session overlay: message shaping,
 * streaming merges, tool/reasoning formatting and height estimation.
 *
 * Kept free of OpenTUI/Solid so it can be unit tested without a renderer.
 */
import type { MiniTheme } from "../opencode";
import type { AnswerDialogState, SessionPart } from "../types";

export type MiniPart =
  | { type: "text"; text: string }
  | {
      type: "reasoning";
      id: string;
      text: string;
      time?: { created?: number; completed?: number };
    }
  | { type: "tool"; text: string; status: string }
  | { type: "meta"; text: string };

export type MiniMessage = {
  id: string;
  role: "user" | "assistant";
  parts: MiniPart[];
  modelName?: string;
};

export type ThinkingMiniPart = Extract<MiniPart, { type: "reasoning" }>;

const THINKING_SPINNER_FRAMES = [
  "⠋",
  "⠙",
  "⠹",
  "⠸",
  "⠼",
  "⠴",
  "⠦",
  "⠧",
  "⠇",
  "⠏",
];

export function buildMiniMessages(state: AnswerDialogState): MiniMessage[] {
  const messages: MiniMessage[] = [];

  for (const entry of state.entries) {
    const message: MiniMessage = {
      id: entry.info.id,
      role: entry.info.type === "assistant" ? "assistant" : "user",
      parts: entry.parts
        .flatMap(toMiniParts)
        .filter((part): part is MiniPart => Boolean(part)),
      modelName:
        entry.info.type === "assistant"
          ? state.messageModels[entry.info.id]
          : undefined,
    };

    if (message.parts.length === 0) continue;

    const previous = messages[messages.length - 1];
    if (shouldMergeMiniMessages(previous, message)) {
      previous.parts.push(...message.parts);
      previous.modelName ??= message.modelName;
      continue;
    }

    messages.push(message);
  }

  if (!state.streamingAnswer) return messages;

  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === "assistant");

  if (!lastAssistant) {
    messages.push({
      id: "streaming-assistant",
      role: "assistant",
      parts: [{ type: "text", text: state.streamingAnswer }],
      modelName: undefined,
    });
    return messages;
  }

  const lastText = [...lastAssistant.parts]
    .reverse()
    .find(
      (part): part is Extract<MiniPart, { type: "text" }> =>
        part.type === "text",
    );

  if (lastText) {
    const streamingTrimmed = state.streamingAnswer.trim();
    const lastTextTrimmed = lastText.text.trim();

    if (streamingTrimmed === lastTextTrimmed) {
      // Identical content, no change needed
    } else if (
      streamingTrimmed.startsWith(lastTextTrimmed) &&
      streamingTrimmed.length > lastTextTrimmed.length
    ) {
      // streamingAnswer contains existing text plus more (cumulative delta)
      lastText.text = state.streamingAnswer;
    } else if (!lastTextTrimmed.endsWith(streamingTrimmed)) {
      // streamingAnswer is genuinely new text (incremental delta)
      lastText.text += state.streamingAnswer;
    }
  } else {
    const lastReasoning = [...lastAssistant.parts]
      .reverse()
      .find((part) => part.type === "reasoning");

    if (
      !lastReasoning ||
      lastReasoning.text.trim() !== state.streamingAnswer.trim()
    ) {
      lastAssistant.parts.push({ type: "text", text: state.streamingAnswer });
    }
  }

  return messages;
}

function shouldMergeMiniMessages(
  previous: MiniMessage | undefined,
  current: MiniMessage,
) {
  return Boolean(
    previous && previous.role === "assistant" && current.role === "assistant",
  );
}

export function estimateMiniMessagesHeight(
  messages: MiniMessage[],
  state: AnswerDialogState,
  width: number,
) {
  let lines = 0;
  for (const message of messages) {
    lines += 1;
    for (let index = 0; index < message.parts.length; index++) {
      const part = message.parts[index];
      lines += getMiniPartTopMargin(message.parts, index, message.role);
      if (part.type === "reasoning") {
        lines += estimateWrappedLines(
          formatThinkingHeader(part, isThinkingPartExpanded(state, part), state),
          width,
        );
        if (isThinkingPartExpanded(state, part)) {
          const body = getThinkingBodyText(part);
          if (body)
            lines += 1 + estimateWrappedLines(body, Math.max(1, width - 2));
        }
      } else {
        lines += estimateWrappedLines(formatMiniPart(part), width);
      }
    }
    lines += 1;
  }
  if (state.error)
    lines += estimateWrappedLines(`Error: ${state.error}`, width);
  if (state.errorDetail)
    lines += estimateWrappedLines(state.errorDetail, width);
  const hint = getCreateUserMessageHint(state);
  if (hint) lines += estimateWrappedLines(hint, width);
  if (state.notice)
    lines += estimateWrappedLines(`Warning: ${state.notice}`, width);
  if (state.loading && messages.length > 0) lines += 1;
  if (messages.length === 0) lines += 1;
  return lines;
}

function estimateWrappedLines(text: string, width: number) {
  const lineWidth = Math.max(1, width);
  return text
    .split("\n")
    .reduce(
      (count, line) => count + Math.max(1, Math.ceil(line.length / lineWidth)),
      0,
    );
}

export function getMiniPartTopMargin(
  parts: MiniPart[],
  index: number,
  role: MiniMessage["role"],
) {
  if (index === 0)
    return parts[0]?.type === "reasoning" && role === "assistant" ? 1 : 0;
  const previous = parts[index - 1];
  const current = parts[index];
  if (current.type === "reasoning") {
    return previous.type === "tool" || previous.type === "reasoning" ? 1 : 0;
  }
  if (current.type === "tool") {
    return previous.type === "tool" || previous.type === "reasoning" ? 1 : 0;
  }
  return current.type === "text" && previous.type !== "text" ? 1 : 0;
}

function toMiniParts(part: SessionPart): MiniPart[] {
  if (part.type === "reasoning" && part.text.trim())
    return toReasoningMiniParts(part);

  const miniPart = toMiniPart(part);
  return miniPart ? [miniPart] : [];
}

function toMiniPart(part: SessionPart): MiniPart | undefined {
  if (part.type === "text" && part.text.trim())
    return { type: "text", text: part.text.trim() };
  if (part.type === "reasoning")
    return {
      type: "reasoning",
      id: getReasoningPartID(part),
      text: part.text,
      time: part.time,
    };
  if (part.type === "tool") {
    const toolName = part.name.charAt(0).toUpperCase() + part.name.slice(1);
    const inputSummary = summarizeToolInput(part.input);
    const detail = inputSummary || part.title;
    return {
      type: "tool",
      status: part.status,
      text: detail ? `→ ${toolName} ${detail}` : `→ ${toolName}`,
    };
  }
  return undefined;
}

function toReasoningMiniParts(
  part: Extract<SessionPart, { type: "reasoning" }>,
) {
  const baseID = getReasoningPartID(part);
  const segments = splitReasoningText(part.text.trim());

  return segments.map((text, index) => ({
    type: "reasoning" as const,
    id: segments.length === 1 ? baseID : `${baseID}:${index}`,
    text,
    time: index === 0 ? part.time : undefined,
  }));
}

function splitReasoningText(text: string) {
  const titlePattern = /\*\*([^*\n]+)\*\*/g;
  const matches = [...text.matchAll(titlePattern)].filter((match) =>
    isReasoningTitleMatch(text, match.index ?? -1),
  );

  if (matches.length <= 1) return [text];

  const segments: string[] = [];
  if ((matches[0].index ?? 0) > 0) {
    const intro = text.slice(0, matches[0].index).trim();
    if (intro) segments.push(intro);
  }

  for (let index = 0; index < matches.length; index++) {
    const start = matches[index].index ?? 0;
    const end = matches[index + 1]?.index ?? text.length;
    const segment = text.slice(start, end).trim();
    if (segment) segments.push(segment);
  }

  return segments.length > 0 ? segments : [text];
}

function isReasoningTitleMatch(text: string, index: number) {
  if (index < 0) return false;
  if (index === 0) return true;
  const before = text.slice(0, index).trimEnd();
  if (!before) return true;
  return /[.!?)]$/.test(before) || before.endsWith("...");
}

function summarizeToolInput(
  input: { [key: string]: unknown } | undefined,
): string {
  if (!input) return "";
  const entries = Object.entries(input).slice(0, 2);
  if (entries.length === 0) return "";
  return entries
    .map(([, value]) => {
      const str = typeof value === "string" ? value : String(value);
      return str.length > 60 ? `${str.slice(0, 57)}...` : str;
    })
    .join(" ");
}

export function formatMiniPart(part: MiniPart) {
  return part.text;
}

export function truncateWithEllipsis(text: string, maxWidth: number) {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return ".".repeat(maxWidth);
  return `${text.slice(0, maxWidth - 3)}...`;
}

export function getFooterCounterWidth(
  state: AnswerDialogState["footerCounter"],
) {
  const miniWidth = state.miniSession?.text.length ?? 0;
  const copiedWidth = state.copiedContext?.text.length ?? 0;
  if (miniWidth && copiedWidth) return miniWidth + copiedWidth + 3;
  return miniWidth + copiedWidth;
}

function getReasoningPartID(part: Extract<SessionPart, { type: "reasoning" }>) {
  return `reasoning:${part.text.slice(0, 48)}`;
}

export function isThinkingPartExpanded(
  state: AnswerDialogState,
  part: ThinkingMiniPart,
) {
  const toggled = Boolean(state.expandedThinkingPartIDs[part.id]);
  return state.thinkingEnabled ? !toggled : toggled;
}

export function formatThinkingHeader(
  part: ThinkingMiniPart,
  expanded: boolean,
  spinnerSource: Pick<AnswerDialogState, "spinnerFrame">,
) {
  const title = getThinkingTitle(part);
  const duration = formatThinkingDuration(part.time);
  const prefix = isThinkingPartLoading(part)
    ? `${THINKING_SPINNER_FRAMES[spinnerSource.spinnerFrame]} `
    : expanded
      ? "- "
      : "+ ";
  if (title)
    return `${prefix}Thought: ${title}${duration ? ` · ${duration}` : ""}`;
  return `${prefix}Thought${duration ? `: ${duration}` : ""}`;
}

function isThinkingPartLoading(part: ThinkingMiniPart) {
  if (!part.time) return false;
  const start = Number(part.time.created);
  const end = Number(part.time.completed);
  return Number.isFinite(start) && !Number.isFinite(end);
}

function getThinkingTitle(part: ThinkingMiniPart) {
  return getExplicitThinkingTitle(part.text);
}

function getExplicitThinkingTitle(text: string) {
  const line = text
    .split("\n")
    .find((candidate) => candidate.trim().length > 0)
    ?.trim();
  const match = line?.match(/^\*\*(.+?)\*\*/);
  return match?.[1]?.trim() ? truncateThinkingTitle(match[1].trim()) : "";
}

function truncateThinkingTitle(title: string) {
  return title.length > 80 ? `${title.slice(0, 77).trim()}...` : title;
}

export function getThinkingBodyText(part: ThinkingMiniPart) {
  const lines = part.text.split("\n");
  const title = getThinkingTitle(part);
  const titleIndex = lines.findIndex((line) => line.trim().length > 0);
  if (titleIndex === -1) return "";

  if (!title) return part.text;

  lines[titleIndex] = lines[titleIndex].replace(/^\s*\*\*(.+?)\*\*/, "");

  return lines
    .slice(titleIndex)
    .join("\n")
    .replace(/^\s+/, "")
    .trimEnd();
}

function formatThinkingDuration(time: ThinkingMiniPart["time"]) {
  if (!time) return "";
  const start = Number(time.created);
  const end = Number(time.completed);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start)
    return "";
  const milliseconds = end - start;
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  return seconds < 10 ? `${seconds.toFixed(1)}s` : `${Math.round(seconds)}s`;
}

export function getMiniPartColor(theme: MiniTheme, part: MiniPart) {
  if (part.type === "reasoning") return theme.textMuted;
  if (part.type === "meta") return theme.textMuted;
  if (part.type === "tool" && part.status === "error") return theme.error;
  if (part.type === "tool" && part.status === "running") return theme.info;
  if (part.type === "tool") return theme.textMuted;
  return theme.text;
}

export function getCreateUserMessageHint(state: AnswerDialogState) {
  const text = [state.error, state.errorDetail].filter(Boolean).join("\n");
  if (
    !/SessionPrompt\.createUserMessage|createUserMessage|chat\.message/i.test(text)
  )
    return undefined;
  return "Hint: OpenCode failed while creating the user message. A server plugin chat.message hook may be throwing.";
}
