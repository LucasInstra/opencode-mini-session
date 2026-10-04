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

import { openMiniSession, startQuestion } from "../src/session";
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

function config(): MiniConfig {
  return {
    model: null,
    variant: null,
    agent: null,
    tokenLimit: 50_000,
    keybind: "alt+b",
    freshKeybind: "alt+n",
    enableThinking: false,
    toggleThinkingKeybind: "ctrl+t",
  };
}

function fakeCtx() {
  return {
    location: { directory: "/tmp/project" },
    renderer: {
      currentFocusedRenderable: undefined,
      requestRender: vi.fn(),
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
      listen: vi.fn(() => () => {}),
      session: { message: { list: vi.fn(() => []) } },
    },
  } as any;
}

function captureHandlers(ctx: ReturnType<typeof fakeCtx>) {
  const handlers: Record<string, (event: any) => void> = {};
  let listener: (event: any) => void = () => {};
  ctx.data.listen.mockImplementation((handler: (event: any) => void) => {
    listener = handler;
    return () => {};
  });
  ctx.data.on.mockImplementation(
    (name: string, handler: (event: any) => void) => {
      handlers[name] = handler;
      return () => {};
    },
  );
  return new Proxy(handlers, {
    get: (_, name: string) => (event: any) => {
      listener({ details: { type: name, ...event } });
      handlers[name]?.(event);
    },
  });
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
      fakeCtx(),
      config(),
      "main",
      vi.fn(),
      { get: () => activeDialog, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    expect(opened).toBe(false);
    expect(activeDialog.show).toHaveBeenCalledOnce();
  });

  it("returns true after creating a new dialog", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    let activeDialog: ActiveDialogController | undefined;

    const opened = openMiniSession(
      fakeCtx(),
      config(),
      "main",
      vi.fn(),
      {
        get: () => activeDialog,
        set: (dialog: ActiveDialogController | undefined) => {
          activeDialog = dialog;
        },
      },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    expect(opened).toBe(true);
    await flushMicrotasks();
    expect(activeDialog).toBeDefined();
  });
});

describe("startQuestion", () => {
  it("renders the observed V2 host projection without merging overlapping ordinals", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());
    const context = await vi.importActual<typeof import("../src/context")>("../src/context");
    getSessionEntries.mockImplementation(context.getSessionEntries as any);
    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    let overlay: OverlayState | undefined;
    await startQuestion(
      ctx, config(), "fresh", "session-1",
      ((next: OverlayState | undefined) => { overlay = next; }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() }, vi.fn(),
    );
    expect(overlay?.onSubmit("question")).toBe(true);
    expect(overlay?.state.waitingForResponse).toBe(true);
    const user = { id: "user-1", type: "user", text: "question", time: { created: 1791150249711 } };
    const assistant = {
      id: "msg_108dfd6f9001BMVOxknuBqqCE4", type: "assistant",
      time: { created: 1791150249742 } as { created: number; completed?: number },
      content: [] as any[],
    };
    ctx.data.session.message.list.mockReturnValue([user]);
    handlers["session.inbox.enqueued"]({ data: { sessionID: "mini-session" } });
    await flushTimers();
    expect(overlay?.state.entries[0].parts).toEqual([{ type: "text", text: "question" }]);
    expect(overlay?.state.waitingForResponse).toBe(true);

    // Metadata observed in V2.0.22, not a reducer simulated from ordinals.
    // The host's reasoning and text parts both received ordinal 0; text.started
    // preceded reasoning.ended. Bodies below are non-sensitive stand-ins.
    assistant.content = [{ type: "reasoning", text: "", time: { created: 1791150250412 } }];
    ctx.data.session.message.list.mockReturnValue([user, assistant]);
    const emit = async (type: string, created: number, delta?: string) => {
      handlers[type]({ created, data: {
        sessionID: "mini-session", assistantMessageID: assistant.id, ordinal: 0, delta,
      } });
      await flushStreamingRender();
    };
    await emit("session.reasoning.started", 1791150250412);
    expect(overlay?.state.waitingForResponse).toBe(false);
    expect(overlay?.state.entries[1].parts[0]).toMatchObject({ type: "reasoning", text: "" });
    assistant.content[0].text = "r".repeat(388);
    await emit("session.reasoning.delta", 1791150252155, "r".repeat(61));
    expect(overlay?.state.entries[1].parts[0]).toMatchObject({ type: "reasoning", text: "r".repeat(388) });
    assistant.content.push({ type: "text", text: "" });
    await emit("session.text.started", 1791150252196);
    assistant.content[0].time.completed = 1791150252223;
    await emit("session.reasoning.ended", 1791150252223);
    assistant.content[1].text = "a".repeat(69);
    await emit("session.text.delta", 1791150252227, "a".repeat(69));
    await emit("session.text.ended", 1791150252229);
    assistant.time.completed = 1791150252237;
    await emit("session.step.ended", 1791150252237);
    expect(overlay?.state.waitingForResponse).toBe(false);
    await emit("session.execution.succeeded", 1791150252244);
    expect(overlay?.state.loading).toBe(false);
    expect(overlay?.state.entries[1].parts).toEqual([
      { type: "reasoning", id: `${assistant.id}:reasoning:0`, text: "r".repeat(388),
        time: { created: 1791150250412, completed: 1791150252223 } },
      { type: "text", text: "a".repeat(69) },
    ]);
    expect(ctx.client.session.context).toHaveBeenCalledTimes(1);
    expect(overlay?.onSubmit("follow-up")).toBe(true);
    expect(overlay?.state.waitingForResponse).toBe(true);
    handlers["session.usage.updated"]({ data: { sessionID: "mini-session" } });
    await flushTimers();
    expect(overlay?.state.waitingForResponse).toBe(true);

    // A fast text-only response may already be complete by the render tick.
    // Its owning event, not the previous answer, removes the pending spinner.
    ctx.data.session.message.list.mockReturnValue([
      user, assistant,
      { id: "user-2", type: "user", text: "follow-up", time: { created: 10 } },
      { id: "assistant-2", type: "assistant", time: { created: 11, completed: 12 },
        content: [{ type: "text", text: "Follow-up answer" }] },
    ]);
    handlers["session.text.ended"]({ data: {
      sessionID: "mini-session", assistantMessageID: "assistant-2", ordinal: 0,
    } });
    await flushTimers();
    expect(overlay?.state.waitingForResponse).toBe(false);
    overlay?.onClose();
    await flushMicrotasks();
  });

  it.each([
    ["session.execution.succeeded", "session.idle"],
    ["session.idle", "session.execution.succeeded"],
  ])(
    "keeps a follow-up active when %s finishes before the queued %s callback",
    async (firstEvent, delayedEvent) => {
      vi.useFakeTimers();
      resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());
      (getSessionEntries as any).mockImplementation((messages: any) => messages);

      const ctx = fakeCtx();
      const handlers = captureHandlers(ctx);
      const firstEntries = [
        assistantEntry({ id: "assistant-1", text: "first answer", completed: true }),
      ];
      const secondEntries = [
        ...firstEntries,
        assistantEntry({ id: "assistant-2", text: "second answer", completed: true }),
      ];
      let overlay: OverlayState | undefined;
      let followUp = false;

      await startQuestion(
        ctx,
        config(),
        "main",
        "session-1",
        ((next: OverlayState | undefined) => {
          overlay = next;
          if (followUp && next && !next.state.loading) {
            followUp = false;
            next.onSubmit("second question");
          }
        }) as any,
        { get: () => undefined, set: vi.fn() },
        { get: () => undefined, set: vi.fn() },
        { get: () => false, set: vi.fn() },
        vi.fn(),
      );

      expect(overlay?.onSubmit("first question")).toBe(true);
      ctx.data.session.message.list.mockReturnValue(firstEntries);
      const event = { data: { sessionID: "mini-session" } };
      followUp = true;
      handlers[firstEvent](event);
      handlers[delayedEvent](event);
      await flushMicrotasks();
      expect(overlay?.state.loading).toBe(true);
      const streamingEntries = [
        ...firstEntries,
        assistantEntry({ id: "assistant-2", text: "second answer streaming" }),
      ];
      ctx.data.session.message.list.mockReturnValue(streamingEntries);
      handlers["session.text.delta"]({
        data: { sessionID: "mini-session", delta: "second answer streaming" },
      });
      await flushStreamingRender();

      expect(overlay?.state.loading).toBe(true);
      expect(overlay?.state.entries).toEqual(streamingEntries);
      expect(overlay?.onSubmit("third question")).toBe(false);

      ctx.data.session.message.list.mockReturnValue(secondEntries);
      handlers[firstEvent](event);
      await flushMicrotasks();
      expect(overlay?.state.loading).toBe(false);
      expect(overlay?.state.entries).toEqual(secondEntries);
      expect(overlay?.state.messageModels["assistant-2"]).toBe(
        overlay?.state.messageModels["assistant-1"],
      );
      expect(overlay?.state.messageModels["assistant-2"]).toBeDefined();
      overlay?.onClose();
      await flushMicrotasks();
    },
  );

  it.each(["scheduled", "queued-render"])(
    "ignores a %s transcript refresh from the previous question",
    async (phase) => {
      vi.useFakeTimers();
      resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());
      (getSessionEntries as any).mockImplementation((messages: any) => messages);

      const ctx = fakeCtx();
      const handlers = captureHandlers(ctx);
      const firstEntries = [
        assistantEntry({ id: "assistant-1", text: "first answer", completed: true }),
      ];
      let overlay: OverlayState | undefined;
      let followUp = false;
      let renders = 0;

      await startQuestion(
        ctx,
        config(),
        "main",
        "session-1",
        ((next: OverlayState | undefined) => {
          overlay = next;
          renders++;
          if (followUp && next && !next.state.loading) {
            followUp = false;
            next.onSubmit("second question");
          }
        }) as any,
        { get: () => undefined, set: vi.fn() },
        { get: () => undefined, set: vi.fn() },
        { get: () => false, set: vi.fn() },
        vi.fn(),
      );

      expect(overlay?.onSubmit("first question")).toBe(true);
      const event = { data: { sessionID: "mini-session" } };
      handlers["session.reasoning.delta"](event);
      ctx.data.session.message.list.mockReturnValue(firstEntries);
      handlers["session.execution.succeeded"](event);
      const beforeCompletion = renders;
      if (phase === "queued-render") {
        // Queue the old timer's render after completion, then submit the next
        // question from the completion render before that old callback runs.
        vi.advanceTimersByTime(50);
        followUp = true;
      }
      await flushMicrotasks();
      if (phase === "scheduled") {
        expect(overlay?.state.loading).toBe(false);
        expect(overlay?.onSubmit("second question")).toBe(true);
      } else {
        expect(overlay?.state.loading).toBe(true);
        expect(renders - beforeCompletion).toBe(2);
      }
      const streamingEntries = [
        ...firstEntries,
        assistantEntry({ id: "assistant-2", text: "second answer streaming" }),
      ];
      ctx.data.session.message.list.mockReturnValue(streamingEntries);
      handlers["session.text.delta"]({
        data: { sessionID: "mini-session", delta: "second answer streaming" },
      });
      const contextCalls = ctx.client.session.context.mock.calls.length;
      await vi.advanceTimersByTimeAsync(250);
      await flushMicrotasks();

      expect(ctx.client.session.context).toHaveBeenCalledTimes(contextCalls);
      expect(overlay?.state.loading).toBe(true);
      expect(overlay?.state.entries).toEqual(streamingEntries);
      expect(overlay?.onSubmit("third question")).toBe(false);
      overlay?.onClose();
      await flushMicrotasks();
    },
  );

  it("forces bottom scroll and follows streaming after submitting a prompt", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    const handlers = captureHandlers(ctx);
    let overlay: OverlayState | undefined;
    const scroller = fakeScroller({
      scrollTop: 30,
      scrollHeight: 40,
      viewportHeight: 10,
    });

    await startQuestion(
      ctx,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    overlay?.onScroller?.(scroller as any);
    expect(overlay?.onSubmit("hello")).toBe(true);
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
    let overlay: OverlayState | undefined;
    const scroller = fakeScroller({
      scrollTop: 30,
      scrollHeight: 40,
      viewportHeight: 10,
    });

    await startQuestion(
      ctx,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    overlay?.onScroller?.(scroller as any);
    expect(overlay?.onSubmit("hello")).toBe(true);
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
      ctx,
      config(),
      "main",
      "session-1",
      vi.fn(),
      active,
      modelPreference,
      thinkingPreference,
      vi.fn(),
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
      fakeCtx(),
      config(),
      "fresh",
      "session-1",
      vi.fn(),
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    await flushMicrotasks();
    expect(buildCopiedContext).not.toHaveBeenCalled();

    agentResolution.resolve(resolvedAgent());

    await opening;
  });

  it("shows copied-context usage when main mini opens", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    let overlay: OverlayState | undefined;

    await startQuestion(
      fakeCtx(),
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    expect(overlay?.state.footerCounter).toEqual({
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

    let overlay: OverlayState | undefined;

    await startQuestion(
      fakeCtx(),
      config(),
      "fresh",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    expect(overlay?.state.footerCounter).toEqual({
      copiedContext: undefined,
      miniSession: undefined,
      placeholder: undefined,
    });
  });

  it("shows the update warning passed by the plugin", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    let overlay: OverlayState | undefined;

    await startQuestion(
      fakeCtx(),
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
      () => "New version available: 9.9.9.",
    );

    expect(overlay?.state.update).toBe("New version available: 9.9.9.");
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
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
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
      ctx,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();

    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(11_240);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("11.2K (6%)");
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
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
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
      ctx,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      vi.fn(),
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

    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(11_240);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("11.2K (6%)");
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
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
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
      ctx,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      vi.fn(),
    );

    handlers["session.idle"]({ data: { sessionID: "mini-session" } });
    await flushMicrotasks();

    expect(overlay?.state.footerCounter.miniSession?.text).toBe("5.2K (3%)");

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

    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_334);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("5.3K (3%)");
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
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
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
      ctx,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      vi.fn(),
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

    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_334);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("5.3K (3%)");
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
      let overlay: OverlayState | undefined;
      const modelPreference: any = {
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
        ctx,
        config(),
        mode,
        "session-1",
        ((next: OverlayState | undefined) => {
          overlay = next;
        }) as any,
        { get: () => undefined, set: vi.fn() },
        modelPreference,
        { get: () => false, set: vi.fn() },
        vi.fn(),
      );

      handlers["session.idle"]({ data: { sessionID: "mini-session" } });
      await flushMicrotasks();
      expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_240);

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

      expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_334);
      expect(overlay?.state.footerCounter.miniSession?.text).toBe("5.3K (3%)");
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
      let overlay: OverlayState | undefined;
      const modelPreference: any = {
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
        ctx,
        config(),
        mode,
        "session-1",
        ((next: OverlayState | undefined) => {
          overlay = next;
        }) as any,
        { get: () => undefined, set: vi.fn() },
        modelPreference,
        { get: () => false, set: vi.fn() },
        vi.fn(),
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

      expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_334);
      expect(overlay?.state.footerCounter.miniSession?.text).toBe("5.3K (3%)");
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
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
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
      ctx,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      vi.fn(),
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
    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_334);

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

    expect(overlay?.state.lastCompletedMiniInputTokens).toBe(5_994);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("6.0K (3%)");
  });

  it("recalculates percentages immediately after a model change", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    };

    await startQuestion(
      ctx,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      (onAfterSelect) => {
        if (!overlay) return;
        overlay.state.lastCompletedMiniInputTokens = 100_000;
        modelPreference.get.mockReturnValue({
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4.6",
          },
          variant: "fast",
        });
        onAfterSelect();
      },
    );

    overlay?.onChangeModel();

    expect(overlay?.state.modelContextWindow).toBe(200_000);
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("100.0K (50%)");
  });

  it("changes the placeholder only after the exact mini-session value crosses the limit threshold", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    };

    await startQuestion(
      ctx,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      (onAfterSelect) => {
        if (!overlay) return;
        overlay.state.lastCompletedMiniInputTokens = 196_000;
        modelPreference.get.mockReturnValue({
          model: {
            providerID: "anthropic",
            modelID: "claude-sonnet-4.6",
          },
          variant: "fast",
        });
        onAfterSelect();
      },
    );

    expect(overlay?.state.inputPlaceholder).toBeUndefined();

    overlay?.onChangeModel();

    expect(overlay?.state.inputPlaceholder).toBe(
      "Session context limit reached...",
    );
  });

  it("hides percentages and threshold effects when the model context window is unknown", async () => {
    vi.useFakeTimers();
    resolveRuntimeMiniAgent.mockResolvedValue(resolvedAgent());

    const ctx = fakeCtx();
    let overlay: OverlayState | undefined;
    const modelPreference: any = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
    };

    await startQuestion(
      ctx,
      config(),
      "main",
      "session-1",
      ((next: OverlayState | undefined) => {
        overlay = next;
      }) as any,
      { get: () => undefined, set: vi.fn() },
      modelPreference,
      { get: () => false, set: vi.fn() },
      (onAfterSelect) => {
        if (!overlay) return;
        overlay.state.lastCompletedMiniInputTokens = 196_000;
        modelPreference.get.mockReturnValue({
          model: {
            providerID: "openai",
            modelID: "gpt-5",
          },
        });
        onAfterSelect();
      },
    );

    overlay?.onChangeModel();

    expect(overlay?.state.modelContextWindow).toBeUndefined();
    expect(overlay?.state.footerCounter.miniSession?.text).toBe("196.0K");
    expect(overlay?.state.footerCounter.miniSession?.warning).toBe(false);
    expect(overlay?.state.inputPlaceholder).toBeUndefined();
  });

  it("uses the fresh keybind in the hide toast", async () => {
    vi.useFakeTimers();
    const agentResolution = deferred<any>();
    resolveRuntimeMiniAgent.mockReturnValue(agentResolution.promise);

    const ctx = fakeCtx();
    let activeDialog: ActiveDialogController | undefined;

    const opening = startQuestion(
      ctx,
      config(),
      "fresh",
      "session-1",
      vi.fn(),
      {
        get: () => activeDialog,
        set: (dialog: ActiveDialogController | undefined) => {
          activeDialog = dialog;
        },
      },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
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
      ctx,
      config(),
      "main",
      "session-1",
      vi.fn(),
      {
        get: () => activeDialog,
        set: (dialog: ActiveDialogController | undefined) => {
          activeDialog = dialog;
        },
      },
      { get: () => undefined, set: vi.fn() },
      { get: () => false, set: vi.fn() },
      vi.fn(),
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
