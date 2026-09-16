import { afterEach, describe, expect, it, vi } from "vitest";

const { buildCopiedContext, getSessionEntries, resolveRuntimeMiniAgent } =
  vi.hoisted(() => ({
    buildCopiedContext: vi.fn(() => ({
      text: "main context",
      usedTokens: 31_000,
      totalAvailableTokens: 31_000,
    })),
    getSessionEntries: vi.fn(() => []),
    resolveRuntimeMiniAgent: vi.fn(),
  }));

vi.mock("../src/agent", async () => {
  const actual = await vi.importActual<typeof import("../src/agent")>(
    "../src/agent",
  );
  return {
    ...actual,
    resolveRuntimeMiniAgent,
  };
});

vi.mock("../src/context", () => ({
  getSessionEntries,
  buildCopiedContext,
}));

import {
  openMiniSession,
  startQuestion,
  clampInstructionValue,
  type MiniSessionOptions,
} from "../src/session";
import type {
  ActiveDialogController,
  MiniConfig,
  ModelPreferenceState,
  OverlayState,
  SessionEntry,
  ThinkingPreferenceState,
} from "../src/types";

const MODEL = {
  id: "claude-sonnet-4.6",
  modelID: "claude-sonnet-4.6",
  providerID: "anthropic",
  name: "Claude Sonnet 4.6",
  limit: { context: 200_000, output: 8_000 },
  variants: [{ id: "fast" }],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function config(overrides: Partial<MiniConfig> = {}): MiniConfig {
  return {
    model: null,
    variant: null,
    agent: null,
    tokenLimit: 50_000,
    keybind: "alt+b",
    freshKeybind: "alt+n",
    enableThinking: false,
    toggleThinkingKeybind: "ctrl+t",
    tools: ["read", "glob", "grep", "webfetch"],
    continueAction: "queue",
    cleanupStaleSessions: true,
    ...overrides,
  };
}

function fakeCtx() {
  return {
    location: { directory: "/tmp/project" },
    renderer: {
      currentFocusedRenderable: undefined,
      requestRender: vi.fn(),
      isOsc52Supported: vi.fn(() => true),
      copyToClipboardOSC52: vi.fn(() => true),
    },
    ui: {
      toast: { show: vi.fn() },
      router: {
        current: () => ({ type: "session", sessionID: "session-1" }),
      },
    },
    client: {
      session: {
        context: vi.fn(async () => []),
        create: vi.fn(async () => ({ id: "mini-session" })),
        remove: vi.fn(async () => {}),
        interrupt: vi.fn(async () => ({})),
        prompt: vi.fn(async () => ({})),
        switchModel: vi.fn(async () => {}),
        instructions: { entry: { put: vi.fn(async () => {}) } },
      },
      model: {
        list: vi.fn(async () => ({ data: [MODEL] })),
        default: vi.fn(async () => ({ data: MODEL })),
      },
      provider: {
        list: vi.fn(async () => ({
          data: [{ id: "anthropic", name: "Anthropic" }],
        })),
      },
    },
    data: {
      on: vi.fn(() => () => {}),
    },
  } as any;
}

function startOptions(
  overrides: Partial<MiniSessionOptions> = {},
): MiniSessionOptions {
  return {
    ctx: fakeCtx(),
    config: config(),
    mode: "main",
    sessionID: "session-1",
    setOverlay: vi.fn(),
    active: { get: () => undefined, set: vi.fn() },
    modelPreference: { get: () => undefined, set: vi.fn() },
    thinkingPreference: { get: () => false, set: vi.fn() },
    openPickerFn: vi.fn(),
    ...overrides,
  };
}

function captureHandlers(ctx: ReturnType<typeof fakeCtx>) {
  const handlers: Record<string, (event: any) => void> = {};
  ctx.data.on.mockImplementation(
    (name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    },
  );
  return handlers;
}

function assistantEntry(options: {
  id: string;
  text: string;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  completed?: boolean;
}): SessionEntry {
  return {
    info: {
      id: options.id,
      type: "assistant",
      agent: "build",
      model: { id: "claude-sonnet-4.6", providerID: "anthropic", variant: "fast" },
      time: options.completed
        ? { created: 0, completed: Date.now() }
        : { created: 0 },
      tokens:
        options.inputTokens !== undefined
          ? {
              input: options.inputTokens,
              output: 0,
              reasoning: 0,
              cache: {
                read: options.cacheReadTokens ?? 0,
                write: options.cacheWriteTokens ?? 0,
              },
            }
          : undefined,
    },
    parts: [{ type: "text", text: options.text }],
  } as unknown as SessionEntry;
}

function resolvedAgent() {
  return {
    mode: "plugin-managed",
    requestedAgent: null,
    agent: null,
    permission: [],
    permissionSource: "plugin-managed",
    tools: ["read", "glob", "grep", "webfetch"],
    notices: [],
  };
}

function fakeScroller(
  options: {
    scrollTop?: number;
    scrollHeight?: number;
    viewportHeight?: number;
  } = {},
) {
  const scroller = {
    scrollTop: options.scrollTop ?? 0,
    scrollHeight: options.scrollHeight ?? 20,
    viewport: { height: options.viewportHeight ?? 10 },
    scrollTo: vi.fn((position: number) => {
      scroller.scrollTop =
        position === Number.MAX_SAFE_INTEGER
          ? Math.max(0, scroller.scrollHeight - scroller.viewport.height)
          : position;
    }),
    scrollBy: vi.fn((delta: number) => {
      scroller.scrollTop = Math.max(
        0,
        Math.min(
          scroller.scrollTop + delta,
          Math.max(0, scroller.scrollHeight - scroller.viewport.height),
        ),
      );
    }),
  };
  return scroller;
}

async function flushMicrotasks(times = 20) {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

async function flushTimers() {
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks();
}

async function flushScrollTimer() {
  await vi.advanceTimersByTimeAsync(0);
}

async function flushStreamingRender() {
  await vi.advanceTimersByTimeAsync(51);
  await flushScrollTimer();
}

function captureOverlay() {
  let overlay: OverlayState | undefined;
  return {
    get: () => overlay,
    set: ((next: OverlayState | undefined) => {
      overlay = next;
    }) as any,
  };
}

afterEach(() => {
  vi.useRealTimers();
  buildCopiedContext.mockClear();
  getSessionEntries.mockReset();
  getSessionEntries.mockReturnValue([]);
  resolveRuntimeMiniAgent.mockReset();
});

describe("openMiniSession", () => {
  it("returns false and shows the active dialog when one is already open", () => {
    vi.useFakeTimers();
    const activeDialog = {
      show: vi.fn(),
    } as any;

    const opened = openMiniSession(
      startOptions({
        active: { get: () => activeDialog, set: vi.fn() },
      }),
    );

    expect(opened).toBe(false);
    expect(activeDialog.show).toHaveBeenCalledOnce();
  });

  it("returns true after creating a new dialog", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    let activeDialog: ActiveDialogController | undefined;

    const opened = openMiniSession(
      startOptions({
        active: {
          get: () => activeDialog,
          set: (dialog: ActiveDialogController | undefined) => {
            activeDialog = dialog;
          },
        },
      }),
    );

    expect(opened).toBe(true);
    await flushMicrotasks();
    expect(activeDialog).toBeDefined();
  });
});

describe("startQuestion", () => {
  it("forces bottom scroll and follows streaming after submitting a prompt", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    const overlay = captureOverlay();
    const scroller = fakeScroller({
      scrollTop: 30,
      scrollHeight: 40,
      viewportHeight: 10,
    });

    await startQuestion(
      startOptions({ ctx, setOverlay: overlay.set }),
    );

    overlay.get()?.onScroller?.(scroller as any);
    expect(overlay.get()?.onSubmit("hello")).toBe(true);
    await flushScrollTimer();

    expect(scroller.scrollTo).toHaveBeenCalledWith(Number.MAX_SAFE_INTEGER);

    scroller.scrollHeight += 20;
    handlers["session.text.delta"]({
      data: { sessionID: "mini-session", delta: "answer" },
    });
    await flushStreamingRender();

    expect(scroller.scrollTo).toHaveBeenCalledTimes(2);
    expect(scroller.scrollTop).toBe(50);
  });

  it("stops following streaming after the user scrolls up", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    const overlay = captureOverlay();
    const scroller = fakeScroller({
      scrollTop: 30,
      scrollHeight: 40,
      viewportHeight: 10,
    });

    await startQuestion(
      startOptions({ ctx, setOverlay: overlay.set }),
    );

    overlay.get()?.onScroller?.(scroller as any);
    expect(overlay.get()?.onSubmit("hello")).toBe(true);
    await flushScrollTimer();

    scroller.scrollTop = 25;
    scroller.scrollHeight += 20;
    handlers["session.text.delta"]({
      data: { sessionID: "mini-session", delta: "answer" },
    });
    await flushStreamingRender();

    expect(scroller.scrollTo).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(25);
  });

  it("registers an active controller before agent resolution completes", async () => {
    vi.useFakeTimers();
    const agentResolution = deferred<any>();
    resolveRuntimeMiniAgent.mockReturnValue(agentResolution.promise);

    const ctx = fakeCtx();
    let activeDialog: ActiveDialogController | undefined;
    const active = {
      get: () => activeDialog,
      set: (dialog: ActiveDialogController | undefined) => {
        activeDialog = dialog;
      },
    };
    const modelPreference: ModelPreferenceState = {
      get: () => undefined,
      set: vi.fn(),
    };
    const thinkingPreference: ThinkingPreferenceState = {
      get: () => false,
      set: vi.fn(),
    };

    const opening = startQuestion(
      startOptions({
        ctx,
        active,
        modelPreference,
        thinkingPreference,
      }),
    );

    await flushMicrotasks();
    expect(activeDialog).toBeDefined();

    await activeDialog?.close();
    agentResolution.resolve(resolvedAgent());

    await opening;
    expect(activeDialog).toBeUndefined();
  });

  it("skips copied context formatting in fresh mode", async () => {
    vi.useFakeTimers();
    const agentResolution = deferred<any>();
    resolveRuntimeMiniAgent.mockReturnValue(agentResolution.promise);

    const opening = startQuestion(
      startOptions({ mode: "fresh" }),
    );

    await flushMicrotasks();
    expect(buildCopiedContext).not.toHaveBeenCalled();

    agentResolution.resolve(resolvedAgent());

    await opening;
  });

  it("shows copied-context usage when main mini opens", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const overlay = captureOverlay();

    await startQuestion(
      startOptions({ setOverlay: overlay.set }),
    );

    expect(overlay.get()?.state.footerCounter).toEqual({
      copiedContext: {
        usedTokens: 31_000,
        totalAvailableTokens: 31_000,
        tokenLimit: 50_000,
        text: "main 31.0K",
        truncated: false,
      },
      miniSession: undefined,
      placeholder: undefined,
    });
  });

  it("shows no counter when fresh mini opens", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const overlay = captureOverlay();

    await startQuestion(
      startOptions({ mode: "fresh", setOverlay: overlay.set }),
    );

    expect(overlay.get()?.state.footerCounter).toEqual({
      copiedContext: undefined,
      miniSession: undefined,
      placeholder: undefined,
    });
  });

  it("shows the update warning passed by the plugin", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const overlay = captureOverlay();

    await startQuestion(
      startOptions({
        setOverlay: overlay.set,
        getUpdateWarning: () => "New version available: 9.9.9.",
      }),
    );

    expect(overlay.get()?.state.update).toBe("New version available: 9.9.9.");
  });

  it("marks the ephemeral session with cleanup metadata", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();

    await startQuestion(startOptions({ ctx }));

    expect(ctx.client.session.create).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { opencodeMiniSession: true } }),
    );
  });

  it("submits the initial question passed by the slash command", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();

    await startQuestion(
      startOptions({ ctx, initialQuestion: "explain this" }),
    );

    expect(ctx.client.session.prompt).toHaveBeenCalledWith({
      sessionID: "mini-session",
      text: "explain this",
    });
  });

  it("retries the last prompt after a failure", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    ctx.client.session.prompt.mockRejectedValueOnce(new Error("boom"));
    const overlay = captureOverlay();

    await startQuestion(
      startOptions({ ctx, setOverlay: overlay.set }),
    );

    expect(overlay.get()?.onSubmit("hello")).toBe(true);
    await flushMicrotasks();
    expect(overlay.get()?.state.error).toContain("boom");

    overlay.get()?.onRetry();
    await flushMicrotasks();

    expect(ctx.client.session.prompt).toHaveBeenCalledTimes(2);
    expect(ctx.client.session.prompt).toHaveBeenLastCalledWith({
      sessionID: "mini-session",
      text: "hello",
    });
    expect(overlay.get()?.state.error).toBeUndefined();
  });

  it("copies the transcript to the clipboard in clipboard mode", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({ id: "assistant-1", text: "answer" }),
    ]);
    const overlay = captureOverlay();

    await startQuestion(
      startOptions({
        ctx,
        config: config({ continueAction: "clipboard" }),
        setOverlay: overlay.set,
      }),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();
    expect(overlay.get()?.continueLabel).toBe("Copy");

    overlay.get()?.onContinue();
    await flushMicrotasks();

    expect(ctx.renderer.copyToClipboardOSC52).toHaveBeenCalledWith(
      expect.stringContaining("[Context from a mini session]"),
    );
    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    expect(ctx.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Side answer copied to clipboard." }),
    );
  });

  it("copies only the last assistant answer in handoff mode", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({ id: "assistant-1", text: "first answer" }),
      assistantEntry({ id: "assistant-2", text: "HANDOFF DOC" }),
    ]);
    const overlay = captureOverlay();

    await startQuestion(
      startOptions({
        ctx,
        setOverlay: overlay.set,
        handoff: true,
        initialQuestion: "write handoff",
      }),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();
    expect(overlay.get()?.continueLabel).toBe("Copy handoff");

    overlay.get()?.onContinue();
    await flushMicrotasks();

    expect(ctx.renderer.copyToClipboardOSC52).toHaveBeenCalledWith("HANDOFF DOC");
    expect(ctx.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Handoff copied to clipboard." }),
    );
  });

  it("copies the handoff document even after a failed follow-up", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({ id: "assistant-1", text: "HANDOFF DOC" }),
    ]);
    const overlay = captureOverlay();

    await startQuestion(
      startOptions({
        ctx,
        setOverlay: overlay.set,
        handoff: true,
        initialQuestion: "write handoff",
      }),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();

    ctx.client.session.prompt.mockRejectedValueOnce(new Error("boom"));
    expect(overlay.get()?.onSubmit("make it shorter")).toBe(true);
    await flushMicrotasks();
    expect(overlay.get()?.state.error).toContain("boom");

    overlay.get()?.onContinue();
    await flushMicrotasks();

    expect(ctx.renderer.copyToClipboardOSC52).toHaveBeenCalledWith(
      "HANDOFF DOC",
    );
  });

  it("does not continue when there is nothing to send", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const overlay = captureOverlay();

    await startQuestion(startOptions({ ctx, setOverlay: overlay.set }));

    overlay.get()?.onContinue();
    await flushMicrotasks();

    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
    expect(ctx.renderer.copyToClipboardOSC52).not.toHaveBeenCalled();
  });

  it("warns when retry has nothing to resend", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    ctx.client.session.create.mockRejectedValueOnce(new Error("offline"));
    const overlay = captureOverlay();

    await startQuestion(startOptions({ ctx, setOverlay: overlay.set }));
    expect(overlay.get()?.state.error).toContain("offline");

    overlay.get()?.onRetry();
    await flushMicrotasks();

    expect(ctx.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Nothing to retry yet. Close and reopen the mini session.",
      }),
    );
    expect(ctx.client.session.prompt).not.toHaveBeenCalled();
  });

  it("clamps oversized instruction values", () => {
    const clamped = clampInstructionValue("x".repeat(300_000));

    expect(clamped).toContain(
      "[Session context truncated to fit the instruction limit.]",
    );
    expect(new TextEncoder().encode(clamped).length).toBeLessThan(300_000);
    expect(clampInstructionValue("small")).toBe("small");
  });

  it("aborts before creating a session when the plugin is disposed", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();

    await startQuestion(startOptions({ ctx, isDisposed: () => true }));

    expect(ctx.client.session.create).not.toHaveBeenCalled();
    expect(ctx.data.on).not.toHaveBeenCalled();
  });

  it("exposes an empty-submit copy action only for copy modes", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();

    const handoffOverlay = captureOverlay();
    await startQuestion(
      startOptions({ ctx, setOverlay: handoffOverlay.set, handoff: true }),
    );
    expect(typeof handoffOverlay.get()?.onEmptySubmit).toBe("function");

    const queueOverlay = captureOverlay();
    await startQuestion(startOptions({ ctx, setOverlay: queueOverlay.set }));
    expect(queueOverlay.get()?.onEmptySubmit).toBeUndefined();

    const clipboardOverlay = captureOverlay();
    await startQuestion(
      startOptions({
        ctx,
        config: config({ continueAction: "clipboard" }),
        setOverlay: clipboardOverlay.set,
      }),
    );
    expect(typeof clipboardOverlay.get()?.onEmptySubmit).toBe("function");
  });

  it("warns when continuing while a response is still loading", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const overlay = captureOverlay();

    await startQuestion(startOptions({ ctx, setOverlay: overlay.set }));
    expect(overlay.get()?.onSubmit("hello")).toBe(true);

    overlay.get()?.onContinue();
    await flushMicrotasks();

    expect(ctx.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Wait for the response to finish." }),
    );
    expect(ctx.client.session.prompt).toHaveBeenCalledTimes(1);
  });

  it("warns when the handoff has no document yet", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const overlay = captureOverlay();

    await startQuestion(
      startOptions({ ctx, setOverlay: overlay.set, handoff: true }),
    );

    overlay.get()?.onContinue();
    await flushMicrotasks();

    expect(ctx.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ message: "No handoff document yet." }),
    );
  });

  it("keeps the dialog open when the clipboard is unsupported", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    ctx.renderer.isOsc52Supported.mockReturnValue(false);
    const handlers = captureHandlers(ctx);
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({ id: "assistant-1", text: "answer" }),
    ]);
    const overlay = captureOverlay();

    await startQuestion(
      startOptions({
        ctx,
        config: config({ continueAction: "clipboard" }),
        setOverlay: overlay.set,
      }),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();

    overlay.get()?.onContinue();
    await flushMicrotasks();

    expect(ctx.renderer.copyToClipboardOSC52).not.toHaveBeenCalled();
    expect(ctx.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({ variant: "error" }),
    );
  });

  it("stores exact completed input tokens after session idle", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 11_240,
        completed: true,
      }),
    ]);

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    const overlay = captureOverlay();
    const modelPreference = {
      get: () => ({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
      set: vi.fn(),
    };

    await startQuestion(
      startOptions({ ctx, setOverlay: overlay.set, modelPreference }),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();

    expect(overlay.get()?.state.lastCompletedMiniInputTokens).toBe(11_240);
    expect(overlay.get()?.state.footerCounter.miniSession?.text).toBe(
      "11.2K (6%)",
    );
  });

  it("keeps the last completed exact value while a later response streams", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 11_240,
        completed: true,
      }),
    ]);
    const overlay = captureOverlay();
    const modelPreference = {
      get: () => ({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
      set: vi.fn(),
    };

    await startQuestion(
      startOptions({ ctx, setOverlay: overlay.set, modelPreference }),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 11_240,
        completed: true,
      }),
      assistantEntry({ id: "assistant-2", text: "streaming" }),
    ]);

    handlers["session.text.delta"]({
      data: { sessionID: "mini-session", delta: "more" },
    });
    await flushStreamingRender();

    expect(overlay.get()?.state.lastCompletedMiniInputTokens).toBe(11_240);
    expect(overlay.get()?.state.footerCounter.miniSession?.text).toBe(
      "11.2K (6%)",
    );
  });

  it("includes cached input tokens after later completed responses", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
    ]);
    const overlay = captureOverlay();
    const modelPreference = {
      get: () => ({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
      set: vi.fn(),
    };

    await startQuestion(
      startOptions({ ctx, setOverlay: overlay.set, modelPreference }),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();

    expect(overlay.get()?.state.footerCounter.miniSession?.text).toBe(
      "5.2K (3%)",
    );

    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
      assistantEntry({
        id: "assistant-2",
        text: "follow up",
        inputTokens: 94,
        cacheReadTokens: 5_240,
        completed: true,
      }),
    ]);

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();

    expect(overlay.get()?.state.lastCompletedMiniInputTokens).toBe(5_334);
    expect(overlay.get()?.state.footerCounter.miniSession?.text).toBe(
      "5.3K (3%)",
    );
  });

  it("treats a lower later input value as a one-time incremental delta", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
    ]);
    const overlay = captureOverlay();
    const modelPreference = {
      get: () => ({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
      set: vi.fn(),
    };

    await startQuestion(
      startOptions({ ctx, setOverlay: overlay.set, modelPreference }),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
      assistantEntry({
        id: "assistant-2",
        text: "follow up",
        inputTokens: 94,
        completed: true,
      }),
    ]);

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();
    handlers["session.text.ended"]({ data: { sessionID: "mini-session" } });
    await flushTimers();

    expect(overlay.get()?.state.lastCompletedMiniInputTokens).toBe(5_334);
    expect(overlay.get()?.state.footerCounter.miniSession?.text).toBe(
      "5.3K (3%)",
    );
  });

  it.each(["main", "fresh"] as const)(
    "increments the second completed response once in %s mode when updated before idle",
    async (mode) => {
      vi.useFakeTimers();
      resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

      const ctx = fakeCtx();
      const handlers = captureHandlers(ctx);
      (getSessionEntries as any).mockReturnValue([
        assistantEntry({
          id: "assistant-1",
          text: "answer",
          inputTokens: 5_240,
          completed: true,
        }),
      ]);
      const overlay = captureOverlay();
      const modelPreference = {
        get: () => ({
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4.6",
          },
          variant: "fast",
        }),
        set: vi.fn(),
      };

      await startQuestion(
        startOptions({ ctx, mode, setOverlay: overlay.set, modelPreference }),
      );

      handlers["session.idle"]({ data: { sessionID: "mini-session" } });
      await flushMicrotasks();
      expect(overlay.get()?.state.lastCompletedMiniInputTokens).toBe(5_240);

      (getSessionEntries as any).mockReturnValue([
        assistantEntry({
          id: "assistant-1",
          text: "answer",
          inputTokens: 5_240,
          completed: true,
        }),
        assistantEntry({
          id: "assistant-2",
          text: "follow up",
          inputTokens: 94,
          completed: true,
        }),
      ]);

      handlers["session.text.ended"]({ data: { sessionID: "mini-session" } });
      await flushTimers();
      handlers["session.idle"]({ data: { sessionID: "mini-session" } });
      await flushMicrotasks();

      expect(overlay.get()?.state.lastCompletedMiniInputTokens).toBe(5_334);
      expect(overlay.get()?.state.footerCounter.miniSession?.text).toBe(
        "5.3K (3%)",
      );
    },
  );

  it.each(["main", "fresh"] as const)(
    "increments the second completed response once in %s mode when its total equals the previous counter",
    async (mode) => {
      vi.useFakeTimers();
      resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

      const ctx = fakeCtx();
      const handlers = captureHandlers(ctx);
      (getSessionEntries as any).mockReturnValue([
        assistantEntry({
          id: "assistant-1",
          text: "answer",
          inputTokens: 5_240,
          completed: true,
        }),
      ]);
      const overlay = captureOverlay();
      const modelPreference = {
        get: () => ({
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4.6",
          },
          variant: "fast",
        }),
        set: vi.fn(),
      };

      await startQuestion(
        startOptions({ ctx, mode, setOverlay: overlay.set, modelPreference }),
      );

      handlers["session.idle"]({ data: { sessionID: "mini-session" } });
      await flushMicrotasks();
      (getSessionEntries as any).mockReturnValue([
        assistantEntry({
          id: "assistant-1",
          text: "answer",
          inputTokens: 5_240,
          completed: true,
        }),
        assistantEntry({
          id: "assistant-2",
          text: "follow up",
          inputTokens: 94,
          cacheReadTokens: 5_146,
          completed: true,
        }),
      ]);

      handlers["session.text.ended"]({ data: { sessionID: "mini-session" } });
      await flushTimers();
      handlers["session.idle"]({ data: { sessionID: "mini-session" } });
      await flushMicrotasks();

      expect(overlay.get()?.state.lastCompletedMiniInputTokens).toBe(5_334);
      expect(overlay.get()?.state.footerCounter.miniSession?.text).toBe(
        "5.3K (3%)",
      );
    },
  );

  it("updates completed input tokens when cache metadata arrives after idle", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
    ]);
    const overlay = captureOverlay();
    const modelPreference = {
      get: () => ({
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4.6",
        },
        variant: "fast",
      }),
      set: vi.fn(),
    };

    await startQuestion(
      startOptions({ ctx, setOverlay: overlay.set, modelPreference }),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();
    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
      assistantEntry({
        id: "assistant-2",
        text: "follow up",
        inputTokens: 94,
        completed: true,
      }),
    ]);

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();
    expect(overlay.get()?.state.lastCompletedMiniInputTokens).toBe(5_334);

    (getSessionEntries as any).mockReturnValue([
      assistantEntry({
        id: "assistant-1",
        text: "answer",
        inputTokens: 5_240,
        completed: true,
      }),
      assistantEntry({
        id: "assistant-2",
        text: "follow up",
        inputTokens: 94,
        cacheReadTokens: 5_900,
        completed: true,
      }),
    ]);

    handlers["session.text.ended"]({ data: { sessionID: "mini-session" } });
    await flushTimers();

    expect(overlay.get()?.state.lastCompletedMiniInputTokens).toBe(5_994);
    expect(overlay.get()?.state.footerCounter.miniSession?.text).toBe(
      "6.0K (3%)",
    );
  });

  it("recalculates percentages immediately after a model change", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const overlay = captureOverlay();
    const modelPreference: any = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    };

    await startQuestion(
      startOptions({
        ctx,
        setOverlay: overlay.set,
        modelPreference,
        openPickerFn: (onAfterSelect) => {
          if (!overlay.get()) return;
          overlay.get()!.state.lastCompletedMiniInputTokens = 100_000;
          modelPreference.get.mockReturnValue({
            model: {
              providerID: "anthropic",
              modelID: "claude-sonnet-4.6",
            },
            variant: "fast",
          });
          onAfterSelect();
        },
      }),
    );

    overlay.get()?.onChangeModel();

    expect(overlay.get()?.state.modelContextWindow).toBe(200_000);
    expect(overlay.get()?.state.footerCounter.miniSession?.text).toBe(
      "100.0K (50%)",
    );
  });

  it("changes the placeholder only after the exact mini-session value crosses the limit threshold", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const overlay = captureOverlay();
    const modelPreference: any = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    };

    await startQuestion(
      startOptions({
        ctx,
        setOverlay: overlay.set,
        modelPreference,
        openPickerFn: (onAfterSelect) => {
          if (!overlay.get()) return;
          overlay.get()!.state.lastCompletedMiniInputTokens = 196_000;
          modelPreference.get.mockReturnValue({
            model: {
              providerID: "anthropic",
              modelID: "claude-sonnet-4.6",
            },
            variant: "fast",
          });
          onAfterSelect();
        },
      }),
    );

    expect(overlay.get()?.state.inputPlaceholder).toBeUndefined();

    overlay.get()?.onChangeModel();

    expect(overlay.get()?.state.inputPlaceholder).toBe(
      "Session context limit reached...",
    );
  });

  it("hides percentages and threshold effects when the model context window is unknown", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const overlay = captureOverlay();
    const modelPreference: any = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    };

    await startQuestion(
      startOptions({
        ctx,
        setOverlay: overlay.set,
        modelPreference,
        openPickerFn: (onAfterSelect) => {
          if (!overlay.get()) return;
          overlay.get()!.state.lastCompletedMiniInputTokens = 196_000;
          modelPreference.get.mockReturnValue({
            model: {
              providerID: "openai",
              modelID: "gpt-5",
            },
          });
          onAfterSelect();
        },
      }),
    );

    overlay.get()?.onChangeModel();

    expect(overlay.get()?.state.modelContextWindow).toBeUndefined();
    expect(overlay.get()?.state.footerCounter.miniSession?.text).toBe("196.0K");
    expect(overlay.get()?.state.footerCounter.miniSession?.warning).toBe(false);
    expect(overlay.get()?.state.inputPlaceholder).toBeUndefined();
  });

  it("uses the fresh keybind in the hide toast", async () => {
    vi.useFakeTimers();
    const agentResolution = deferred<any>();
    resolveRuntimeMiniAgent.mockReturnValue(agentResolution.promise);

    const ctx = fakeCtx();
    let activeDialog: ActiveDialogController | undefined;

    const opening = startQuestion(
      startOptions({
        ctx,
        mode: "fresh",
        active: {
          get: () => activeDialog,
          set: (dialog: ActiveDialogController | undefined) => {
            activeDialog = dialog;
          },
        },
      }),
    );

    await flushMicrotasks();
    activeDialog?.hide();

    expect(ctx.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "mini hidden. Press alt+n to show it.",
      }),
    );

    agentResolution.resolve(resolvedAgent());

    await opening;
  });

  it("closes and shows an error if agent resolution fails", async () => {
    vi.useFakeTimers();
    const ctx = fakeCtx();
    let activeDialog: ActiveDialogController | undefined;

    resolveRuntimeMiniAgent.mockRejectedValue(new Error("agent lookup failed"));

    const opening = startQuestion(
      startOptions({
        ctx,
        active: {
          get: () => activeDialog,
          set: (dialog: ActiveDialogController | undefined) => {
            activeDialog = dialog;
          },
        },
      }),
    );

    await opening;

    expect(activeDialog).toBeUndefined();
    expect(ctx.ui.toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: "error",
        message: "Failed to open mini session: agent lookup failed",
      }),
    );
  });
});
