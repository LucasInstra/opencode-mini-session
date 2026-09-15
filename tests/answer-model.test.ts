import { describe, expect, it } from "vitest";
import {
  buildMiniMessages,
  estimateMiniMessagesHeight,
  formatThinkingHeader,
  getCreateUserMessageHint,
  getFooterCounterWidth,
  getMiniPartColor,
  getMiniPartTopMargin,
  getThinkingBodyText,
  isThinkingPartExpanded,
  truncateWithEllipsis,
} from "../src/components/answer-model";
import type { MiniTheme } from "../src/opencode";
import type { AnswerDialogState, SessionEntry, SessionPart } from "../src/types";

const theme = {
  text: "text",
  textMuted: "muted",
  error: "error",
  info: "info",
} as unknown as MiniTheme;

function state(overrides: Partial<AnswerDialogState> = {}): AnswerDialogState {
  return {
    mode: "main",
    entries: [],
    streamingAnswer: "",
    loading: false,
    scrollbarVisible: false,
    spinnerFrame: 0,
    thinkingEnabled: false,
    expandedThinkingPartIDs: {},
    footerCounter: {},
    messageModels: {},
    ...overrides,
  };
}

function userEntry(text: string, id = `user-${text}`): SessionEntry {
  return {
    info: { id, type: "user", time: { created: 0 } } as unknown as SessionEntry["info"],
    parts: [{ type: "text", text }],
  };
}

function assistantEntry(parts: SessionPart[], id = "assistant-1"): SessionEntry {
  return {
    info: {
      id,
      type: "assistant",
      time: { created: 0 },
    } as unknown as SessionEntry["info"],
    parts,
  };
}

describe("buildMiniMessages", () => {
  it("builds user and assistant messages and drops empty ones", () => {
    const messages = buildMiniMessages(
      state({
        entries: [
          userEntry("hello"),
          assistantEntry([], "empty"),
          assistantEntry([{ type: "text", text: "world" }], "a1"),
        ],
      }),
    );

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", parts: [{ type: "text", text: "hello" }] });
    expect(messages[1]).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "world" }],
    });
  });

  it("merges consecutive assistant messages and keeps the first model name", () => {
    const messages = buildMiniMessages(
      state({
        entries: [
          assistantEntry([{ type: "text", text: "one" }], "a1"),
          assistantEntry([{ type: "text", text: "two" }], "a2"),
        ],
        messageModels: { a1: "model-a", a2: "model-b" },
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]?.parts.map((part) => part.text)).toEqual(["one", "two"]);
    expect(messages[0]?.modelName).toBe("model-a");
  });

  it("formats tool parts with the input summary and title fallback", () => {
    const [message] = buildMiniMessages(
      state({
        entries: [
          assistantEntry([
            {
              type: "tool",
              name: "read",
              status: "completed",
              input: { path: "src/index.ts" },
            },
            {
              type: "tool",
              name: "grep",
              status: "running",
              title: "searching",
            },
          ]),
        ],
      }),
    );

    expect(message?.parts).toEqual([
      { type: "tool", status: "completed", text: "→ Read src/index.ts" },
      { type: "tool", status: "running", text: "→ Grep searching" },
    ]);
  });

  it("splits reasoning text on bold titles", () => {
    const [message] = buildMiniMessages(
      state({
        entries: [
          assistantEntry([
            {
              type: "reasoning",
              text: "Intro line. **First step** details. **Second step** more.",
            },
          ]),
        ],
      }),
    );

    const parts = message?.parts ?? [];
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.type === "reasoning")).toBe(true);
    expect(parts.map((part) => (part as { id: string }).id)).toEqual([
      expect.stringContaining(":0"),
      expect.stringContaining(":1"),
      expect.stringContaining(":2"),
    ]);
  });

  it("creates a streaming assistant message when none exists", () => {
    const messages = buildMiniMessages(
      state({ entries: [userEntry("hi")], streamingAnswer: "partial" }),
    );

    expect(messages.at(-1)).toMatchObject({
      id: "streaming-assistant",
      role: "assistant",
      parts: [{ type: "text", text: "partial" }],
    });
  });

  it("replaces the last text when the streaming answer is cumulative", () => {
    const [message] = buildMiniMessages(
      state({
        entries: [assistantEntry([{ type: "text", text: "hello" }])],
        streamingAnswer: "hello world",
      }),
    );

    expect(message?.parts).toEqual([{ type: "text", text: "hello world" }]);
  });

  it("appends when the streaming answer is an incremental delta", () => {
    const [message] = buildMiniMessages(
      state({
        entries: [assistantEntry([{ type: "text", text: "hello" }])],
        streamingAnswer: "!!",
      }),
    );

    expect(message?.parts).toEqual([{ type: "text", text: "hello!!" }]);
  });

  it("leaves the text untouched when the streaming answer is identical", () => {
    const [message] = buildMiniMessages(
      state({
        entries: [assistantEntry([{ type: "text", text: "hello" }])],
        streamingAnswer: "hello",
      }),
    );

    expect(message?.parts).toEqual([{ type: "text", text: "hello" }]);
  });

  it("adds a text part after reasoning unless it matches the reasoning text", () => {
    const reasoning: SessionPart = {
      type: "reasoning",
      text: "**Plan** details",
    };

    const different = buildMiniMessages(
      state({
        entries: [assistantEntry([reasoning])],
        streamingAnswer: "details",
      }),
    );
    expect(different[0]?.parts).toHaveLength(2);

    const same = buildMiniMessages(
      state({
        entries: [assistantEntry([reasoning])],
        streamingAnswer: "**Plan** details",
      }),
    );
    expect(same[0]?.parts).toHaveLength(1);
  });
});

describe("layout helpers", () => {
  it("separates reasoning and tool parts with spacing", () => {
    const parts = [
      { type: "reasoning" as const, id: "r", text: "t" },
      { type: "tool" as const, status: "completed", text: "→ Read" },
      { type: "text" as const, text: "answer" },
    ];

    expect(getMiniPartTopMargin(parts, 0, "assistant")).toBe(1);
    expect(getMiniPartTopMargin(parts, 1, "assistant")).toBe(1);
    expect(getMiniPartTopMargin(parts, 2, "assistant")).toBe(1);
    expect(getMiniPartTopMargin(parts, 2, "user")).toBe(1);
    expect(getMiniPartTopMargin([parts[2], parts[2]], 1, "assistant")).toBe(0);
  });

  it("estimates more height as content and errors grow", () => {
    const base = estimateMiniMessagesHeight([], state(), 40);
    const withError = estimateMiniMessagesHeight(
      [],
      state({ error: "boom" }),
      40,
    );
    const withNotice = estimateMiniMessagesHeight(
      [],
      state({ notice: "heads up", error: "boom" }),
      40,
    );
    const withHint = estimateMiniMessagesHeight(
      [],
      state({ error: "SessionPrompt.createUserMessage failed" }),
      40,
    );

    expect(base).toBe(1);
    expect(withError).toBeGreaterThan(base);
    expect(withNotice).toBeGreaterThan(withError);
    expect(withHint).toBeGreaterThan(withError);
  });

  it("truncates labels and measures footer counters", () => {
    expect(truncateWithEllipsis("abcdef", 6)).toBe("abcdef");
    expect(truncateWithEllipsis("abcdef", 5)).toBe("ab...");
    expect(truncateWithEllipsis("abcdef", 2)).toBe("..");
    expect(truncateWithEllipsis("abcdef", 0)).toBe("");

    expect(
      getFooterCounterWidth({
        miniSession: { text: "5.3K", warning: false, limitReached: false, usedTokens: 0 },
        copiedContext: {
          text: "main 9.0K",
          usedTokens: 0,
          totalAvailableTokens: 0,
          tokenLimit: 0,
          truncated: false,
        },
      }),
    ).toBe(4 + 9 + 3);
    expect(getFooterCounterWidth({})).toBe(0);
  });
});

describe("thinking parts", () => {
  it("formats headers with a spinner while loading and a duration when done", () => {
    const loading = formatThinkingHeader(
      { type: "reasoning", id: "r1", text: "**Plan** details", time: { created: 0 } },
      false,
      { spinnerFrame: 0 },
    );
    expect(loading.startsWith("⠋")).toBe(true);
    expect(loading).toContain("Thought: Plan");

    const done = formatThinkingHeader(
      {
        type: "reasoning",
        id: "r1",
        text: "**Plan** details",
        time: { created: 0, completed: 1500 },
      },
      false,
      { spinnerFrame: 0 },
    );
    expect(done).toBe("+ Thought: Plan · 1.5s");

    const untitled = formatThinkingHeader(
      { type: "reasoning", id: "r2", text: "just thinking" },
      true,
      { spinnerFrame: 0 },
    );
    expect(untitled).toBe("- Thought");
  });

  it("extracts the body without the bold title line", () => {
    expect(
      getThinkingBodyText({
        type: "reasoning",
        id: "r1",
        text: "**Plan**\ndetails here",
      }),
    ).toBe("details here");

    expect(
      getThinkingBodyText({ type: "reasoning", id: "r2", text: "plain text" }),
    ).toBe("plain text");
  });

  it("expands thinking parts from the preference and per-part toggles", () => {
    const part = { type: "reasoning" as const, id: "r1", text: "t" };

    expect(isThinkingPartExpanded(state(), part)).toBe(false);
    expect(isThinkingPartExpanded(state({ thinkingEnabled: true }), part)).toBe(
      true,
    );
    expect(
      isThinkingPartExpanded(
        state({ expandedThinkingPartIDs: { r1: true } }),
        part,
      ),
    ).toBe(true);
    expect(
      isThinkingPartExpanded(
        state({ thinkingEnabled: true, expandedThinkingPartIDs: { r1: true } }),
        part,
      ),
    ).toBe(false);
  });
});

describe("part colors and hints", () => {
  it("maps part states to theme colors", () => {
    expect(
      getMiniPartColor(theme, { type: "tool", status: "error", text: "x" }),
    ).toBe("error");
    expect(
      getMiniPartColor(theme, { type: "tool", status: "running", text: "x" }),
    ).toBe("info");
    expect(
      getMiniPartColor(theme, { type: "tool", status: "completed", text: "x" }),
    ).toBe("muted");
    expect(getMiniPartColor(theme, { type: "text", text: "x" })).toBe("text");
  });

  it("detects create-user-message failures", () => {
    expect(
      getCreateUserMessageHint(state({ error: "chat.message hook threw" })),
    ).toContain("Hint:");
    expect(
      getCreateUserMessageHint(
        state({ errorDetail: "SessionPrompt.createUserMessage failed" }),
      ),
    ).toContain("Hint:");
    expect(getCreateUserMessageHint(state({ error: "boom" }))).toBeUndefined();
  });
});
