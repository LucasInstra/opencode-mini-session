import type { InputRenderable, ScrollBoxRenderable } from "@opentui/core";
import type { ModelInfo, ProviderInfo, SessionMessageInfo } from "@opencode/client";
import type { Setter } from "solid-js";
import { version } from "../package.json";
import { buildFooterCounterState } from "./counter";
import {
  buildMiniErrorDetail,
  buildMiniPromptPayload,
  buildMiniSessionCreatePayload,
  buildMiniSystemPrompt,
  formatMiniNotice,
  resolveRuntimeMiniAgent,
  type ResolvedMiniAgent,
} from "./agent";
import { buildCopiedContext, getSessionEntries } from "./context";
import { getErrorMessage } from "./diagnostics";
import {
  resolveDefaultModel,
  formatResolvedModel,
  resolveModelContextWindow,
  type ModelSource,
} from "./model";
import { getCurrentRoute, type TuiContext } from "./opencode";
import type {
  ActiveDialog,
  AnswerDialogState,
  MiniConfig,
  MiniMode,
  ModelPreferenceState,
  OverlayState,
  ResolvedModel,
  ThinkingPreferenceState,
} from "./types";

type ModelSelectValue =
  | { type: "default" }
  | {
      type: "model";
      model: NonNullable<ResolvedModel["model"]>;
      variant?: string;
    };

type ErrorPath =
  | "session.prompt throw"
  | "session.execution.failed event"
  | "session.create throw";

const SYSTEM_INSTRUCTION_KEY = "mini.system";

export function openMiniSession(
  ctx: TuiContext,
  config: MiniConfig,
  mode: MiniMode,
  setOverlay: Setter<OverlayState | undefined>,
  active: ActiveDialog,
  modelPreference: ModelPreferenceState,
  thinkingPreference: ThinkingPreferenceState,
  openPickerFn: (onAfterSelect: () => void) => void,
  getUpdateWarning?: () => string | undefined,
): boolean {
  const route = getCurrentRoute(ctx);

  if (route.kind !== "session") {
    ctx.ui.toast.show({
      variant: "error",
      message: "mini only works inside a session.",
    });
    return false;
  }

  const activeDialog = active.get();
  if (activeDialog) {
    activeDialog.show();
    return false;
  }

  const sessionID = route.sessionID;
  void startQuestion(
    ctx,
    config,
    mode,
    sessionID,
    setOverlay,
    active,
    modelPreference,
    thinkingPreference,
    openPickerFn,
    getUpdateWarning,
  );
  return true;
}

export async function startQuestion(
  ctx: TuiContext,
  config: MiniConfig,
  mode: MiniMode,
  sessionID: string,
  setOverlay: Setter<OverlayState | undefined>,
  active: ActiveDialog,
  modelPreference: ModelPreferenceState,
  thinkingPreference: ThinkingPreferenceState,
  openPickerFn: (onAfterSelect: () => void) => void,
  getUpdateWarning?: () => string | undefined,
) {
  const [messages, models, providers, defaultModelResult] = await Promise.all([
    fetchSessionMessages(ctx, sessionID),
    fetchModels(ctx),
    fetchProviders(ctx),
    fetchDefaultModel(ctx),
  ]);
  const entries = getSessionEntries(messages);
  const copiedContext =
    mode === "main"
      ? buildCopiedContext(entries, config.tokenLimit)
      : { text: "", usedTokens: undefined, totalAvailableTokens: undefined };
  const context = copiedContext.text;
  const defaultResolvedModel = resolveDefaultModel(
    models,
    config.model,
    config.variant,
    entries,
    defaultModelResult,
  );
  const getResolvedModel = () =>
    modelPreference.get() ?? defaultResolvedModel.model;
  const getModelName = () => formatResolvedModel(getResolvedModel());
  const hideKey = mode === "fresh" ? config.freshKeybind : config.keybind;
  const hiddenCommand = mode === "fresh" ? "/mini-fresh" : "/mini";
  const title = mode === "fresh" ? "mini fresh" : "mini session";
  const previousFocus = ctx.renderer.currentFocusedRenderable;
  let resolvedAgent: ResolvedMiniAgent;
  let system = "";

  const dialogState: AnswerDialogState = {
    mode,
    entries: [],
    streamingAnswer: "",
    loading: false,
    scrollbarVisible: false,
    spinnerFrame: 0,
    copiedContextTokens: copiedContext.usedTokens,
    copiedContextTotalTokens: copiedContext.totalAvailableTokens,
    lastCompletedMiniInputTokens: undefined,
    modelContextWindow: undefined,
    footerCounter: {},
    inputPlaceholder: undefined,
    thinkingEnabled: thinkingPreference.get(),
    expandedThinkingPartIDs: {},
    update: getUpdateWarning?.(),
    notice: undefined,
    errorDetail: undefined,
    messageModels: {},
  };

  const submissionModelQueue: string[] = [];

  const unsubscribers: Array<() => void> = [];
  let tempSessionID: string | undefined;
  let closed = false;
  let hidden = false;
  let continuing = false;
  let renderTimer: ReturnType<typeof setTimeout> | undefined;
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let scrollTimer: ReturnType<typeof setTimeout> | undefined;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let overlayInput: InputRenderable | undefined;
  let overlayScroller: ScrollBoxRenderable | undefined;
  let followStreamingToBottom = true;
  let forceScrollToBottom = true;
  let pendingScrollToBottom = false;
  let lastScrollTop = 0;
  let lastScrollHeight = 0;
  let currentTokenMessageID: string | undefined;
  const incrementedTokenMessageIDs = new Set<string>();
  let sessionModelKey = formatSessionModelKey(defaultResolvedModel.model);

  const syncCounterState = () => {
    dialogState.modelContextWindow = resolveModelContextWindow(
      models,
      getResolvedModel(),
    );
    dialogState.footerCounter = buildFooterCounterState({
      mode: dialogState.mode,
      copiedContextTokens: dialogState.copiedContextTokens,
      copiedContextTotalTokens: dialogState.copiedContextTotalTokens,
      tokenLimit: config.tokenLimit,
      lastCompletedMiniInputTokens: dialogState.lastCompletedMiniInputTokens,
      modelContextWindow: dialogState.modelContextWindow,
    });
    dialogState.inputPlaceholder = dialogState.footerCounter.placeholder;
  };

  const clearScrollTimer = () => {
    pendingScrollToBottom = false;
    if (!scrollTimer) return;
    clearTimeout(scrollTimer);
    scrollTimer = undefined;
  };

  const clearFocusTimer = () => {
    if (!focusTimer) return;
    clearTimeout(focusTimer);
    focusTimer = undefined;
  };

  const clearSpinnerTimer = () => {
    if (!spinnerTimer) return;
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  };

  const clearRefreshTimer = () => {
    if (!refreshTimer) return;
    clearTimeout(refreshTimer);
    refreshTimer = undefined;
  };

  const startSpinnerTimer = () => {
    if (spinnerTimer || closed || hidden || !dialogState.loading) return;
    spinnerTimer = setInterval(() => {
      if (closed || hidden || !dialogState.loading) {
        clearSpinnerTimer();
        return;
      }
      dialogState.spinnerFrame = (dialogState.spinnerFrame + 1) % 10;
      renderOverlay();
    }, 80);
  };

  const scheduleInputFocus = () => {
    if (closed || hidden) return;
    clearFocusTimer();
    focusTimer = setTimeout(() => {
      focusTimer = undefined;
      if (closed || hidden) return;
      overlayInput?.focus();
      ctx.renderer.requestRender();
    }, 0);
  };

  const isScrollerAtBottom = () => {
    if (!overlayScroller) return true;
    const maxScrollTop = Math.max(
      0,
      overlayScroller.scrollHeight - overlayScroller.viewport.height,
    );
    return overlayScroller.scrollTop >= maxScrollTop - 1;
  };

  const updateScrollSnapshot = () => {
    lastScrollTop = overlayScroller?.scrollTop ?? 0;
    lastScrollHeight = overlayScroller?.scrollHeight ?? 0;
  };

  const scheduleScrollToBottom = () => {
    if (closed || hidden) return;
    clearScrollTimer();
    pendingScrollToBottom = true;
    scrollTimer = setTimeout(() => {
      scrollTimer = undefined;
      if (closed || hidden) {
        pendingScrollToBottom = false;
        return;
      }
      overlayScroller?.scrollTo(Number.MAX_SAFE_INTEGER);
      updateScrollSnapshot();
      pendingScrollToBottom = false;
      ctx.renderer.requestRender();
    }, 0);
  };

  const scrollBy = (delta: number) => {
    followStreamingToBottom = false;
    forceScrollToBottom = false;
    pendingScrollToBottom = false;
    clearScrollTimer();
    overlayScroller?.scrollBy(delta);
    updateScrollSnapshot();
  };

  const scrollTo = (position: number) => {
    followStreamingToBottom = position === Number.MAX_SAFE_INTEGER;
    forceScrollToBottom = position === Number.MAX_SAFE_INTEGER;
    pendingScrollToBottom = false;
    if (position !== Number.MAX_SAFE_INTEGER) clearScrollTimer();
    overlayScroller?.scrollTo(position);
    updateScrollSnapshot();
  };

  const restorePreviousFocus = () => {
    setTimeout(() => {
      if (previousFocus && !previousFocus.isDestroyed) {
        previousFocus.focus();
      }
      ctx.renderer.requestRender();
    }, 0);
  };

  const hide = () => {
    if (closed || hidden) return;
    hidden = true;
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
    clearScrollTimer();
    clearFocusTimer();
    clearSpinnerTimer();
    clearRefreshTimer();
    setOverlay(undefined);
    restorePreviousFocus();
    ctx.ui.toast.show({
      variant: "info",
      message: hideKey
        ? `mini hidden. Press ${hideKey} to show it.`
        : `mini hidden. Run ${hiddenCommand} to show it.`,
      duration: 1000,
    });
  };

  const closeFromUser = async () => {
    ctx.ui.toast.show({
      variant: "info",
      message: "mini session closed.",
      duration: 1000,
    });
    await cleanup();
  };

  const cleanup = async () => {
    if (closed) return;
    closed = true;
    if (active.get() === controller) active.set(undefined);
    while (unsubscribers.length > 0) {
      try {
        unsubscribers.pop()?.();
      } catch {}
    }
    if (renderTimer) clearTimeout(renderTimer);
    clearScrollTimer();
    clearFocusTimer();
    clearSpinnerTimer();
    clearRefreshTimer();
    setOverlay(undefined);
    restorePreviousFocus();
    if (!tempSessionID) return;
    const ephemeralSessionID = tempSessionID;
    tempSessionID = undefined;
    try {
      await ctx.client.session.interrupt({ sessionID: ephemeralSessionID });
    } catch {}
    try {
      await ctx.client.session.remove({ sessionID: ephemeralSessionID });
    } catch {}
  };

  const continueInMainThread = async () => {
    const transcript = buildMiniSessionTranscript(dialogState);
    if (continuing || dialogState.loading || dialogState.error || !transcript)
      return;
    continuing = true;

    try {
      await ctx.client.session.prompt({
        sessionID,
        text: buildContinuePrompt(transcript),
        delivery: "queue",
      });
      ctx.ui.toast.show({
        variant: "success",
        message: "Side answer queued in the main session.",
      });
      await cleanup();
    } catch (cause) {
      ctx.ui.toast.show({
        variant: "error",
        message: `Failed to continue in main thread: ${getErrorMessage(cause)}`,
      });
    } finally {
      continuing = false;
    }
  };

  const toggleThinking = () => {
    dialogState.thinkingEnabled = !dialogState.thinkingEnabled;
    thinkingPreference.set(dialogState.thinkingEnabled);
    dialogState.expandedThinkingPartIDs = {};
    renderOverlay();
  };

  const toggleThinkingPart = (partID: string) => {
    if (dialogState.expandedThinkingPartIDs[partID]) {
      delete dialogState.expandedThinkingPartIDs[partID];
    } else {
      dialogState.expandedThinkingPartIDs[partID] = true;
    }
    renderOverlay();
  };

  const renderOverlay = (options: { focusInput?: boolean } = {}) => {
    if (closed) return;
    syncCounterState();
    const streamingActive =
      dialogState.loading || Boolean(dialogState.streamingAnswer);
    const currentScrollTop = overlayScroller?.scrollTop ?? 0;
    const currentScrollHeight = overlayScroller?.scrollHeight ?? 0;
    if (streamingActive && !forceScrollToBottom && !pendingScrollToBottom) {
      if (isScrollerAtBottom()) {
        followStreamingToBottom = true;
      } else if (
        currentScrollTop < lastScrollTop ||
        currentScrollHeight <= lastScrollHeight
      ) {
        followStreamingToBottom = false;
      }
    }
    const shouldScrollToBottom =
      forceScrollToBottom || (streamingActive && followStreamingToBottom);
    forceScrollToBottom = false;
    updateScrollSnapshot();
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = undefined;
    }
    if (hidden) return;
    setOverlay({
      api: ctx,
      title,
      version,
      modelName: getModelName(),
      hideKey,
      toggleThinkingKeybind: config.toggleThinkingKeybind,
      state: dialogState,
      onScroller: (scroller) => {
        overlayScroller = scroller;
      },
      onInput: (input) => {
        overlayInput = input;
      },
      onHide: () => hide(),
      onClose: () => void closeFromUser(),
      onContinue: () => void continueInMainThread(),
      onChangeModel: () =>
        openPickerFn(() => renderOverlay({ focusInput: true })),
      onToggleThinking: toggleThinking,
      onToggleThinkingPart: toggleThinkingPart,
      onSubmit: submitPrompt,
      scrollBy,
      scrollTo,
      submit: () => {
        const value = (overlayInput?.value || "").trim();
        if (value && !dialogState.loading && submitPrompt(value)) {
          if (overlayInput) overlayInput.value = "";
        }
      },
    });
    if (options.focusInput) scheduleInputFocus();
    if (dialogState.loading) startSpinnerTimer();
    else clearSpinnerTimer();
    if (shouldScrollToBottom) scheduleScrollToBottom();
  };

  const setPromptError = (path: ErrorPath, cause: unknown) => {
    dialogState.error = getErrorMessage(cause);
    dialogState.errorDetail = buildMiniErrorDetail({
      path,
      sessionID: tempSessionID,
      resolvedModel: getResolvedModel(),
      resolvedAgent,
    });
    dialogState.loading = false;
    clearSpinnerTimer();
  };

  const show = () => {
    if (closed) return;
    hidden = false;
    renderOverlay({ focusInput: true });
  };

  const controller = {
    close: cleanup,
    hide,
    show,
    isVisible: () => !hidden,
  };

  const scheduleRenderOverlay = () => {
    if (closed || renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = undefined;
      renderOverlay();
    }, 50);
  };

  active.set(controller);
  renderOverlay({ focusInput: true });

  try {
    resolvedAgent = await resolveRuntimeMiniAgent(ctx, config);
  } catch (cause) {
    if (closed) return;
    ctx.ui.toast.show({
      variant: "error",
      message: `Failed to open mini session: ${getErrorMessage(cause)}`,
    });
    await cleanup();
    return;
  }

  if (closed) return;
  system = buildMiniSystemPrompt(
    context,
    resolvedAgent,
    mode,
    ctx.location?.directory,
  );
  dialogState.notice = formatMiniNotice(
    defaultResolvedModel.notice,
    ...resolvedAgent.notices,
  );
  renderOverlay();

  function submitPrompt(value: string) {
    const prompt = value.trim();
    if (!prompt || closed) return false;
    if (dialogState.loading) {
      ctx.ui.toast.show({
        variant: "warning",
        message: "Wait for the current response.",
      });
      return false;
    }
    if (!tempSessionID) {
      ctx.ui.toast.show({
        variant: "warning",
        message: "mini session is still opening.",
      });
      return false;
    }
    const promptSessionID = tempSessionID;

    dialogState.error = undefined;
    dialogState.errorDetail = undefined;
    dialogState.loading = true;
    dialogState.spinnerFrame = 0;
    dialogState.streamingAnswer = "";
    followStreamingToBottom = true;
    forceScrollToBottom = true;
    submissionModelQueue.push(getModelName());

    renderOverlay({ focusInput: true });

    void (async () => {
      try {
        const resolvedModel = getResolvedModel();
        const nextModelKey = formatSessionModelKey(resolvedModel);
        if (nextModelKey !== sessionModelKey) {
          await ctx.client.session.switchModel({
            sessionID: promptSessionID,
            model: {
              id: resolvedModel.model?.modelID ?? "",
              providerID: resolvedModel.model?.providerID ?? "",
              ...(resolvedModel.variant ? { variant: resolvedModel.variant } : {}),
            },
          });
          sessionModelKey = nextModelKey;
        }
        await ctx.client.session.prompt(
          buildMiniPromptPayload({
            sessionID: promptSessionID,
            prompt,
          }),
        );
      } catch (cause) {
        if (closed) return;
        setPromptError("session.prompt throw", cause);
        renderOverlay();
      }
    })();

    return true;
  }

  try {
    const created = await ctx.client.session.create(
      buildMiniSessionCreatePayload(resolvedAgent, {
        title: "mini session",
        ...(ctx.location?.directory
          ? { location: { directory: ctx.location.directory } }
          : {}),
        ...(defaultResolvedModel.model.model
          ? {
              model: {
                id: defaultResolvedModel.model.model.modelID,
                providerID: defaultResolvedModel.model.model.providerID,
                ...(defaultResolvedModel.model.variant
                  ? { variant: defaultResolvedModel.model.variant }
                  : {}),
              },
            }
          : {}),
      }),
    );
    tempSessionID = created.id;
    const ephemeralSessionID = tempSessionID;

    if (system.trim()) {
      try {
        await ctx.client.session.instructions.entry.put({
          sessionID: ephemeralSessionID,
          key: SYSTEM_INSTRUCTION_KEY,
          value: system,
        });
      } catch (cause) {
        if (closed) return;
        ctx.ui.toast.show({
          variant: "warning",
          message: `Failed to attach mini instructions: ${getErrorMessage(cause)}`,
        });
      }
    }

    const refreshLastCompletedMiniInputTokens = () => {
      const latest = getLastCompletedMiniInputUsage(dialogState.entries);
      if (!latest) return;

      const current = dialogState.lastCompletedMiniInputTokens;
      if (current === undefined || latest.totalTokens > current) {
        dialogState.lastCompletedMiniInputTokens = latest.totalTokens;
        currentTokenMessageID = latest.messageID;
        return;
      }

      if (latest.messageID === currentTokenMessageID) {
        return;
      }

      if (incrementedTokenMessageIDs.has(latest.messageID)) {
        return;
      }

      incrementedTokenMessageIDs.add(latest.messageID);
      dialogState.lastCompletedMiniInputTokens = current + latest.inputTokens;
      currentTokenMessageID = latest.messageID;
    };

    const refreshSession = async () => {
      if (closed || !tempSessionID) return;
      const messages = await fetchSessionMessages(ctx, tempSessionID);
      if (closed) return;
      dialogState.entries = getSessionEntries(messages);
      dialogState.streamingAnswer = "";
      refreshLastCompletedMiniInputTokens();
    };

    const scheduleSessionRefresh = (delay = 50) => {
      if (closed || refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        void refreshSession()
          .then(() => renderOverlay())
          .catch(() => {});
      }, delay);
    };

    const finishResponse = () => {
      if (closed || !dialogState.loading) return;
      const usedModel = submissionModelQueue.shift();
      if (usedModel) {
        for (const entry of dialogState.entries) {
          if (
            entry.info.type === "assistant" &&
            !dialogState.messageModels[entry.info.id]
          ) {
            dialogState.messageModels[entry.info.id] = usedModel;
          }
        }
      }
      if (
        !extractAssistantText(dialogState.entries) &&
        !dialogState.streamingAnswer
      ) {
        dialogState.streamingAnswer = "No response generated.";
      }
      dialogState.loading = false;
      clearSpinnerTimer();
    };

    if (closed) {
      try {
        await ctx.client.session.remove({ sessionID: ephemeralSessionID });
      } catch {}
      return;
    }

    unsubscribers.push(
      ctx.data.on("session.idle", (event) => {
        if (event.data.sessionID !== tempSessionID) return;
        void refreshSession()
          .then(() => {
            finishResponse();
            renderOverlay();
          })
          .catch(() => {});
      }),
    );

    unsubscribers.push(
      ctx.data.on("session.execution.succeeded", (event) => {
        if (event.data.sessionID !== tempSessionID) return;
        void refreshSession()
          .then(() => {
            finishResponse();
            renderOverlay();
          })
          .catch(() => {});
      }),
    );

    unsubscribers.push(
      ctx.data.on("session.execution.failed", (event) => {
        if (event.data.sessionID !== tempSessionID) return;
        setPromptError("session.execution.failed event", event.data.error);
        renderOverlay();
      }),
    );

    unsubscribers.push(
      ctx.data.on("session.text.delta", (event) => {
        if (event.data.sessionID !== tempSessionID) return;
        dialogState.streamingAnswer += event.data.delta;
        scheduleRenderOverlay();
      }),
    );

    unsubscribers.push(
      ctx.data.on("session.reasoning.delta", (event) => {
        if (event.data.sessionID !== tempSessionID) return;
        scheduleSessionRefresh(200);
      }),
    );

    unsubscribers.push(
      ctx.data.on("session.text.ended", (event) => {
        if (event.data.sessionID !== tempSessionID) return;
        scheduleSessionRefresh(0);
      }),
    );

    for (const toolEvent of [
      "session.tool.called",
      "session.tool.success",
      "session.tool.failed",
    ] as const) {
      unsubscribers.push(
        ctx.data.on(toolEvent, (event) => {
          if (event.data.sessionID !== tempSessionID) return;
          scheduleSessionRefresh(50);
        }),
      );
    }
  } catch (cause) {
    if (closed) return;
    setPromptError("session.create throw", cause);
    renderOverlay();
  }
}

export function openModelPicker(
  ctx: TuiContext,
  config: MiniConfig,
  sessionID: string,
  modelPreference: ModelPreferenceState,
  onAfterSelect?: () => void,
  onOpenChange?: (open: boolean) => void,
) {
  onOpenChange?.(true);
  void (async () => {
    try {
      const [messages, models, providers, defaultModelResult] = await Promise.all([
        fetchSessionMessages(ctx, sessionID),
        fetchModels(ctx),
        fetchProviders(ctx),
        fetchDefaultModel(ctx),
      ]);
      const entries = getSessionEntries(messages);
      const { model: defaultModel } = resolveDefaultModel(
        models,
        config.model,
        config.variant,
        entries,
        defaultModelResult,
      );
      const options = buildModelOptions(
        models,
        providers,
        defaultModel,
        defaultModelResult,
      );

      const selected = await ctx.ui.dialog.select<ModelSelectValue>({
        title: "Mini session model",
        placeholder: "Select model for future mini-session questions",
        options,
      });

      if (selected === undefined) return;
      if (selected.type === "default") {
        modelPreference.set(undefined);
        ctx.ui.toast.show({
          variant: "success",
          message: "mini model reset to default.",
        });
      } else {
        modelPreference.set({
          model: selected.model,
          variant: selected.variant,
        });
        ctx.ui.toast.show({
          variant: "success",
          message: `mini model set to ${formatResolvedModel({
            model: selected.model,
            variant: selected.variant,
          })}.`,
        });
      }
      onAfterSelect?.();
    } catch (cause) {
      ctx.ui.toast.show({
        variant: "error",
        message: `Failed to change mini model: ${getErrorMessage(cause)}`,
      });
    } finally {
      onOpenChange?.(false);
    }
  })();
}

function buildModelOptions(
  models: ModelInfo[],
  providers: ProviderInfo[],
  defaultModel: ResolvedModel,
  fallbackModel: ResolvedModel | undefined,
): { title: string; value: ModelSelectValue; description?: string; category?: string }[] {
  const providerName = (providerID: string) =>
    providers.find((provider) => provider.id === providerID)?.name ?? providerID;

  const defaultModelName = defaultModel.model
    ? models.find(
        (model) =>
          model.providerID === defaultModel.model!.providerID &&
          model.id === defaultModel.model!.modelID,
      )?.name ?? defaultModel.model.modelID
    : fallbackModel?.model?.modelID ?? "default";

  const sortedModels = [...models].sort((left, right) => {
    const providerCompare = providerName(left.providerID).localeCompare(
      providerName(right.providerID),
    );
    if (providerCompare !== 0) return providerCompare;
    return left.name.localeCompare(right.name);
  });

  const options: {
    title: string;
    value: ModelSelectValue;
    description?: string;
    category?: string;
  }[] = [
    {
      title:
        defaultModelName +
        (defaultModel.variant ? ` (${defaultModel.variant})` : ""),
      value: { type: "default" },
      description: formatResolvedModel(defaultModel),
      category: "Default",
    },
  ];

  for (const model of sortedModels) {
    const resolved = {
      providerID: model.providerID,
      modelID: model.id,
    };
    const category = providerName(model.providerID);
    options.push({
      title: model.name || model.id,
      value: { type: "model", model: resolved },
      description: `${model.providerID}/${model.id}`,
      category,
    });

    for (const variant of model.variants
      .map((candidate) => candidate.id)
      .sort()) {
      options.push({
        title: `${model.name || model.id} (${variant})`,
        value: { type: "model", model: resolved, variant },
        description: `${model.providerID}/${model.id}`,
        category,
      });
    }
  }

  return options;
}

export function extractAssistantText(
  entries: AnswerDialogState["entries"],
): string {
  const chunks: string[] = [];
  for (const entry of entries) {
    if (entry.info.type !== "assistant") continue;
    for (const part of entry.parts) {
      if (part.type === "text" && part.text.trim()) chunks.push(part.text);
    }
  }
  return chunks.join("\n\n").trim();
}

function buildMiniSessionTranscript(state: AnswerDialogState) {
  const lines: string[] = [];

  for (const entry of state.entries) {
    const chunks: string[] = [];
    for (const part of entry.parts) {
      if (part.type === "text" && part.text.trim())
        chunks.push(part.text.trim());
    }
    if (chunks.length > 0)
      lines.push(`${entry.info.type}:\n${chunks.join("\n\n")}`);
  }

  if (state.streamingAnswer.trim()) {
    lines.push(`assistant:\n${state.streamingAnswer.trim()}`);
  }

  return lines.join("\n\n").trim();
}

function buildContinuePrompt(transcript: string) {
  return ["[Context from a mini session]", transcript, "---\n"].join("\n\n");
}

function getLastCompletedMiniInputUsage(entries: AnswerDialogState["entries"]) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const info = entries[index]?.info;
    if (info.type !== "assistant") continue;
    if (!info.time?.completed) continue;
    if (info.tokens) {
      return {
        messageID: info.id,
        inputTokens: info.tokens.input,
        totalTokens: getAssistantInputTokens(info.tokens),
      };
    }
  }
  return undefined;
}

function getAssistantInputTokens(tokens: {
  input: number;
  cache?: { read?: number; write?: number };
}) {
  return tokens.input + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0);
}

function formatSessionModelKey(resolved: ResolvedModel) {
  if (!resolved.model) return "";
  return `${resolved.model.providerID}/${resolved.model.modelID}${resolved.variant ? `#${resolved.variant}` : ""}`;
}

async function fetchSessionMessages(
  ctx: TuiContext,
  sessionID: string,
): Promise<SessionMessageInfo[]> {
  try {
    return await ctx.client.session.context({ sessionID });
  } catch {
    return ctx.data.session.message.list(sessionID);
  }
}

async function fetchModels(ctx: TuiContext): Promise<ModelInfo[]> {
  try {
    const result = await ctx.client.model.list();
    if (Array.isArray(result.data)) return result.data;
  } catch {}
  return [];
}

async function fetchProviders(ctx: TuiContext): Promise<ProviderInfo[]> {
  try {
    const result = await ctx.client.provider.list();
    if (Array.isArray(result.data)) return result.data;
  } catch {}
  return [];
}

async function fetchDefaultModel(
  ctx: TuiContext,
): Promise<ResolvedModel | undefined> {
  try {
    const result = await ctx.client.model.default();
    const model = result.data;
    if (model) {
      return {
        model: { providerID: model.providerID, modelID: model.id },
      };
    }
  } catch {}
  return undefined;
}
