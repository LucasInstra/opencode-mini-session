import { Plugin } from "@opencode/plugin/tui";
import { createEffect, createSignal, untrack } from "solid-js";
import { createOverlaySlot } from "./components/AnswerDialog";
import { parseConfig } from "./config";
import { PLUGIN_ID } from "./constants";
import type { MiniKeybindActions } from "./keybinds";
import { getCurrentRoute } from "./opencode";
import { resolveMiniRouteAction, runMiniRouteAction } from "./routing";
import { openMiniSession, openModelPicker } from "./session";
import { startAutoUpdate } from "./update";
import type {
  ActiveDialogController,
  MiniMode,
  ModelPreference,
  OverlayState,
  ThinkingPreferenceState,
} from "./types";

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const config = parseConfig(ctx.options);
    const [overlay, setOverlay] = createSignal<OverlayState | undefined>(
      undefined,
      { equals: false },
    );
    const [selectedModel, setSelectedModel] = createSignal<ModelPreference>(
      undefined,
      { equals: false },
    );
    const [thinkingEnabled, setThinkingEnabled] = createSignal(
      config.enableThinking,
    );
    const [originSessionID, setOriginSessionID] = createSignal<
      string | undefined
    >(undefined);
    const [updateWarning, setUpdateWarning] = createSignal<
      string | undefined
    >(undefined);
    let activeDialog: ActiveDialogController | undefined;
    let activeMode: MiniMode | undefined;
    const modelPickerOpen = { value: false };
    const thinkingPreference: ThinkingPreferenceState = {
      get: thinkingEnabled,
      set: setThinkingEnabled,
    };
    const updateController = new AbortController();
    startAutoUpdate(ctx, setUpdateWarning, updateController.signal);

    const actions: MiniKeybindActions = {
      config,
      isOverlayOpen: () => Boolean(overlay()),
      onSession: () => getCurrentRoute(ctx).kind === "session",
      triggerMiniMode: (mode, source) => {
        void triggerMiniMode(mode, source);
      },
      openModelPicker: () => {
        const route = getCurrentRoute(ctx);
        if (route.kind !== "session") return;
        openPicker(route.sessionID);
      },
      hideOverlay: () => overlay()?.onHide(),
      closeOverlay: () => {
        if (modelPickerOpen.value) {
          ctx.ui.dialog.clear();
          modelPickerOpen.value = false;
        } else {
          overlay()?.onClose();
        }
      },
      continueInMainThread: () => overlay()?.onContinue(),
      toggleThinking: () => overlay()?.onToggleThinking(),
      changeModelFromPanel: () => {
        modelPickerOpen.value = true;
        overlay()?.onChangeModel();
      },
      scrollBy: (delta) => overlay()?.scrollBy(delta),
      scrollTo: (position) => overlay()?.scrollTo(position),
    };

    const unregisterSlot = ctx.ui.slot({
      append: "app",
      render: createOverlaySlot({
        ctx,
        getOverlay: overlay,
        actions,
      }),
    });

    createEffect(() => {
      const warning = updateWarning();
      const current = untrack(overlay);
      if (!current || current.state.update === warning) return;
      setOverlay({ ...current, state: { ...current.state, update: warning } });
    });

    createEffect(() => {
      const origin = originSessionID();
      if (!origin) return;
      const route = getCurrentRoute(ctx);
      if (route.kind !== "session" || route.sessionID !== origin) {
        setOriginSessionID(undefined);
        ctx.ui.toast.show({
          variant: "info",
          message: "mini session closed.",
          duration: 1000,
        });
        void activeDialog?.close();
      }
    });

    function openPicker(sessionID: string, onAfterSelect?: () => void) {
      openModelPicker(
        ctx,
        config,
        sessionID,
        { get: selectedModel, set: setSelectedModel },
        onAfterSelect,
        (open) => {
          modelPickerOpen.value = open;
        },
      );
    }

    async function triggerMiniMode(
      mode: MiniMode,
      source: "command" | "keybind",
    ) {
      const route = getCurrentRoute(ctx);
      if (route.kind !== "session") return;
      const sessionID = route.sessionID;
      const nextAction = resolveMiniRouteAction({
        source,
        requestedMode: mode,
        activeMode,
        isVisible: activeDialog?.isVisible(),
      });

      await runMiniRouteAction({
        action: nextAction,
        activeDialog,
        open: () => {
          const opened = openMiniSession(
            ctx,
            config,
            mode,
            setOverlay,
            {
              get: () => activeDialog,
              set: (dialog) => {
                activeDialog = dialog;
                if (!dialog) {
                  activeMode = undefined;
                  setOriginSessionID(undefined);
                }
              },
            },
            { get: selectedModel, set: setSelectedModel },
            thinkingPreference,
            (onAfterSelect) => openPicker(sessionID, onAfterSelect),
            () => updateWarning(),
          );
          if (opened) {
            setOriginSessionID(sessionID);
            activeMode = mode;
          }
        },
      });
    }

    return () => {
      updateController.abort();
      unregisterSlot();
      void activeDialog?.close();
    };
  },
});
