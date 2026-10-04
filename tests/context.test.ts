import { describe, expect, it } from "vitest";
import {
  buildCopiedContext,
  estimateTokens,
  formatFullContext,
  getMessageParts,
  getSessionEntries,
} from "../src/context";
import type { SessionEntry } from "../src/types";

function entry(type: "user" | "assistant", text: string): SessionEntry {
  return {
    info: {
      id: `${type}-${text}`,
      type,
      time: { created: 0 },
    } as unknown as SessionEntry["info"],
    parts: [{ type: "text", text }],
  };
}

describe("copied context", () => {
  it("returns text and estimated token usage together", () => {
    const entries = [entry("user", "hello"), entry("assistant", "world")];

    expect(buildCopiedContext(entries, 50)).toEqual({
      text: "user:\nhello\n\nassistant:\nworld",
      usedTokens:
        estimateTokens("user:\nhello") + estimateTokens("assistant:\nworld"),
      totalAvailableTokens:
        estimateTokens("user:\nhello") + estimateTokens("assistant:\nworld"),
    });
  });

  it("keeps whole-message newest-first selection behavior", () => {
    const older = entry("user", "old message that should be dropped");
    const newer = entry("assistant", "newest message stays");

    expect(
      buildCopiedContext(
        [older, newer],
        estimateTokens("assistant:\nnewest message stays"),
      ),
    ).toEqual({
      text: "assistant:\nnewest message stays",
      usedTokens: estimateTokens("assistant:\nnewest message stays"),
      totalAvailableTokens:
        estimateTokens("user:\nold message that should be dropped") +
        estimateTokens("assistant:\nnewest message stays"),
    });
  });

  it("preserves the oversized newest message edge case", () => {
    const newest = entry("assistant", "x".repeat(200));

    const result = buildCopiedContext([newest], 10);

    expect(result.text).toBe(`assistant:\n${"x".repeat(200)}`);
    expect(result.usedTokens).toBeGreaterThan(10);
    expect(result.totalAvailableTokens).toBe(result.usedTokens);
  });

  it("keeps formatFullContext behavior stable", () => {
    const entries = [entry("user", "hello")];
    expect(formatFullContext(entries, 50)).toBe("user:\nhello");
  });
});

describe("live host parts", () => {
  it("preserves both completed Thoughts across the observed two-tool, three-step turn", () => {
    const toolStep = (
      id: string,
      time: { created: number; completed: number },
      reasoningTime: { created: number; completed: number },
    ) => ({
      id, type: "assistant", time, content: [
        { type: "reasoning", text: "r".repeat(108), time: reasoningTime },
        { type: "tool", id: `call_${id}`, name: "read", state: { status: "completed", input: {}, metadata: {}, content: [] } },
      ],
    });
    // Sanitized lengths and step boundaries from the live V2.0.22 tool turn.
    const entries = getSessionEntries([
      toolStep("step-1", { created: 1791151009827, completed: 1791151012016 },
        { created: 1791151011647, completed: 1791151011982 }),
      toolStep("step-2", { created: 1791151012061, completed: 1791151015308 },
        { created: 1791151013491, completed: 1791151015271 }),
      { id: "step-3", type: "assistant", time: { created: 1791151015352, completed: 1791151016128 },
        content: [{ type: "text", text: "aa" }] },
    ] as any);
    expect(entries.map((entry) => entry.parts.map((part) => part.type))).toEqual([
      ["reasoning", "tool"], ["reasoning", "tool"], ["text"],
    ]);
    expect(entries[0].parts[0]).not.toEqual(entries[1].parts[0]);
  });

  it("keeps an empty active Thought and its identity as text arrives", () => {
    const message = {
      id: "assistant-1", type: "assistant", content: [
        { type: "reasoning", text: "", time: { created: 1791150250412 } },
      ],
    } as any;
    const started = getMessageParts(message);
    expect(started).toEqual([{
      type: "reasoning", id: "assistant-1:reasoning:0", text: "",
      time: { created: 1791150250412, completed: undefined },
    }]);
    message.content[0].text = "Thought body";
    message.content.push({ type: "text", text: "Answer" });
    const streaming = getMessageParts(message);
    expect(streaming[0]).toMatchObject({ id: "assistant-1:reasoning:0", text: "Thought body" });
    expect(streaming[1]).toEqual({ type: "text", text: "Answer" });
  });

  it("keeps matching Thought bodies in different turns independently foldable", () => {
    const parts = (id: string) => getMessageParts({
      id, type: "assistant", content: [{
        type: "reasoning", text: "Same title", time: { created: 1, completed: 2 },
      }],
    } as any);
    expect(parts("assistant-1")[0]).not.toEqual(parts("assistant-2")[0]);
  });
});
