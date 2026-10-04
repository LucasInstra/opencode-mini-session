import type { ModelInfo } from "@opencode/client";
import { describe, expect, it } from "vitest";
import { resolveDefaultModel, resolveModelContextWindow } from "../src/model";
import type { SessionEntry } from "../src/types";

function models(): ModelInfo[] {
  return [
    {
      id: "claude-sonnet-4.6",
      modelID: "claude-sonnet-4.6",
      providerID: "anthropic",
      name: "Claude Sonnet 4.6",
      limit: {
        context: 200_000,
        output: 8_000,
      },
      variants: [{ id: "fast" }, { id: "thinking" }],
    },
  ] as unknown as ModelInfo[];
}

function sessionEntries(): SessionEntry[] {
  return [
    {
      info: {
        id: "assistant-1",
        type: "assistant",
        time: { created: 0 },
        agent: "build",
        model: { id: "gpt-5", providerID: "openai", variant: "default" },
        content: [],
      },
      parts: [],
    },
  ] as unknown as SessionEntry[];
}

describe("default model resolution", () => {
  it("includes configured variants when available", () => {
    const resolved = resolveDefaultModel(
      models(),
      "anthropic/claude-sonnet-4.6",
      "fast",
      sessionEntries(),
    );

    expect(resolved.source).toBe("config");
    expect(resolved.model).toEqual({
      model: {
        providerID: "anthropic",
        modelID: "claude-sonnet-4.6",
      },
      variant: "fast",
    });
    expect(resolved.notice).toBeUndefined();
  });

  it("falls back to the session model when the configured variant is unavailable", () => {
    const resolved = resolveDefaultModel(
      models(),
      "anthropic/claude-sonnet-4.6",
      "missing",
      sessionEntries(),
    );

    expect(resolved.source).toBe("session");
    expect(resolved.model).toEqual({
      model: {
        providerID: "openai",
        modelID: "gpt-5",
      },
      variant: "default",
    });
    expect(resolved.notice).toContain(
      "Configured mini model anthropic/claude-sonnet-4.6 (missing) was not found.",
    );
  });

  it("falls back to the provided default model when the session has none", () => {
    const resolved = resolveDefaultModel(
      models(),
      null,
      null,
      [],
      { model: { providerID: "anthropic", modelID: "claude-sonnet-4.6" } },
    );

    expect(resolved.source).toBe("default");
    expect(resolved.model).toEqual({
      model: { providerID: "anthropic", modelID: "claude-sonnet-4.6" },
    });
  });

  it("resolves a selected model context window from model metadata", () => {
    expect(
      resolveModelContextWindow(models(), {
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
    ).toBe(200_000);
  });

  it("returns undefined when the selected model is missing", () => {
    expect(
      resolveModelContextWindow(models(), {
        model: {
          providerID: "openai",
          modelID: "gpt-5",
        },
      }),
    ).toBeUndefined();
  });
});
