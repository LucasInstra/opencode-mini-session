/** @jsxImportSource @opentui/solid */
import {
  type InputRenderable,
  type ScrollBoxRenderable,
  SyntaxStyle,
} from "@opentui/core";
import { createMemo, Show } from "solid-js";
import { THINKING_TEXT } from "../constants";
import {
  buildGlobalCommands,
  buildPanelCommands,
  registerGlobalKeymap,
  registerPanelKeymap,
  type MiniKeybindActions,
} from "../keybinds";
import { adaptTheme, type MiniTheme, type TuiContext } from "../opencode";
import { extractAssistantText } from "../session";
import type { AnswerDialogProps, AnswerDialogState, OverlayState } from "../types";
import {
  buildMiniMessages,
  estimateMiniMessagesHeight,
  formatMiniPart,
  formatThinkingHeader,
  getCreateUserMessageHint,
  getFooterCounterWidth,
  getMiniPartColor,
  getMiniPartTopMargin,
  getThinkingBodyText,
  isThinkingPartExpanded,
  truncateWithEllipsis,
  type ThinkingMiniPart,
} from "./answer-model";
import { ActionButton } from "./ActionButton";

function buildSyntaxStyle(theme: MiniTheme): SyntaxStyle {
  return SyntaxStyle.fromStyles({
    // Markdown token styles
    "markup.heading": { fg: theme.markdownHeading, bold: true },
    "markup.strong": { fg: theme.markdownStrong, bold: true },
    "markup.italic": { fg: theme.markdownEmph, italic: true },
    "markup.link": { fg: theme.markdownLink },
    "markup.link.label": { fg: theme.markdownLinkText },
    "markup.link.url": { fg: theme.markdownLink },
    "markup.raw": { fg: theme.markdownCode },
    "markup.raw.block": { fg: theme.markdownCodeBlock },
    "markup.strikethrough": { fg: theme.markdownText },
    blockquote: { fg: theme.markdownBlockQuote },
    conceal: { fg: theme.border, dim: true },
    // Syntax highlighting in code blocks
    comment: { fg: theme.syntaxComment },
    keyword: { fg: theme.syntaxKeyword },
    function: { fg: theme.syntaxFunction },
    variable: { fg: theme.syntaxVariable },
    string: { fg: theme.syntaxString },
    number: { fg: theme.syntaxNumber },
    type: { fg: theme.syntaxType },
    operator: { fg: theme.syntaxOperator },
    punctuation: { fg: theme.syntaxPunctuation },
  });
}

export function AnswerDialog(props: AnswerDialogProps) {
  const theme = adaptTheme(props.api.theme);
  const mdSyntaxStyle = buildSyntaxStyle(theme);
  let scroller: ScrollBoxRenderable | undefined;
  let input: InputRenderable | undefined;
  let inputValue = "";

  const screenWidth = props.api.renderer.width;
  const screenHeight = props.api.renderer.height;
  const panelWidth = Math.min(100, Math.floor(screenWidth * 0.85));
  const panelHeight = Math.max(
    14,
    Math.min(screenHeight - 6, Math.floor(screenHeight * 0.68)),
  );
  const transcriptWidth = Math.max(20, panelWidth - 6);
  const promptContentWidth = Math.max(10, transcriptWidth - 6);
  const transcriptHeight = Math.max(1, panelHeight - 13);
  const transcriptContentWidth = Math.max(20, transcriptWidth - 5);

  const messages = createMemo(() => buildMiniMessages(props.state));
  const estimatedContentHeight = createMemo(
    () =>
      estimateMiniMessagesHeight(
        messages(),
        props.state,
        transcriptContentWidth,
      ) + 4,
  );
  const contentOverflows = createMemo(
    () => estimatedContentHeight() > transcriptHeight - 2,
  );
  const showScrollbar = createMemo(
    () => props.state.scrollbarVisible || contentOverflows(),
  );
  const canContinue = createMemo(
    () =>
      !props.state.loading &&
      (props.continueOnError || !props.state.error) &&
      Boolean(
        extractAssistantText(props.state.entries) ||
        props.state.streamingAnswer.trim(),
      ),
  );
  const createUserMessageHint = createMemo(() =>
    getCreateUserMessageHint(props.state),
  );
  const footerCounter = createMemo(() => props.state.footerCounter);
  const hasFooterCounter = createMemo(
    () => Boolean(footerCounter().miniSession || footerCounter().copiedContext),
  );
  const footerModelName = createMemo(() =>
    truncateWithEllipsis(
      props.modelName,
      Math.max(
        0,
        promptContentWidth -
          getFooterCounterWidth(footerCounter()) -
          (hasFooterCounter() ? 3 : 0),
      ),
    ),
  );

  return (
    <box
      position="absolute"
      top={0}
      left={0}
      width={screenWidth}
      height={screenHeight}
      justifyContent="center"
      alignItems="center"
    >
      <box
        position="absolute"
        top={0}
        left={0}
        width={screenWidth}
        height={screenHeight}
        backgroundColor="#000000"
        opacity={0.65}
      />
      <box
        width={panelWidth}
        height={panelHeight}
        flexDirection="column"
        backgroundColor={theme.backgroundPanel}
      >
        {/* header */}
        <box
          paddingTop={1}
          paddingLeft={3}
          paddingRight={3}
          flexDirection="row"
          justifyContent="flex-start"
          alignItems="center"
          marginBottom={1}
        >
          <box flexDirection="row" gap={1}>
            <text fg={theme.text}>
              <b>{props.title}</b>
            </text>
            <Show when={props.version}>
              {(version) => <text fg={theme.textMuted}>{version()}</text>}
            </Show>
          </box>
        </box>
        {/* transcript */}
        <box paddingLeft={3} paddingRight={3}>
          <scrollbox
            ref={(node) => {
              scroller = node;
              props.onScroller?.(node);
            }}
            height={transcriptHeight}
            width={transcriptWidth}
            scrollY
            stickyScroll
            stickyStart="bottom"
            verticalScrollbarOptions={{ visible: showScrollbar() }}
          >
            <box flexDirection="column" gap={1} width={transcriptContentWidth}>
              {props.state.notice ? (
                <text fg={theme.warning}>Warning: {props.state.notice}</text>
              ) : null}
              {props.state.update ? (
                <text fg={theme.warning}>{props.state.update}</text>
              ) : null}
              {messages().length > 0 ? (
                messages().map((message) => (
                  <box flexDirection="column" gap={0}>
                    <text
                      fg={
                        message.role === "assistant"
                          ? theme.primary
                          : theme.secondary
                      }
                    >
                      <b>
                        {message.role === "assistant"
                          ? `assistant [${message.modelName ?? props.modelName}]`
                          : message.role}
                      </b>
                    </text>
                    {message.parts.map((part, index) => (
                      <box
                        marginTop={getMiniPartTopMargin(
                          message.parts,
                          index,
                          message.role,
                        )}
                      >
                        {part.type === "reasoning" ? (
                          <ThinkingPart
                            theme={theme}
                            part={part}
                            expanded={isThinkingPartExpanded(
                              props.state,
                              part,
                            )}
                            spinnerFrame={props.state.spinnerFrame}
                            onToggle={() => props.onToggleThinkingPart(part.id)}
                          />
                        ) : message.role === "assistant" &&
                        part.type === "text" &&
                        !props.state.loading ? (
                          <markdown
                            content={part.text}
                            syntaxStyle={mdSyntaxStyle}
                            fg={theme.markdownText}
                            streaming={props.state.loading}
                            width={transcriptContentWidth}
                          />
                        ) : (
                          <text fg={getMiniPartColor(theme, part)}>
                            {formatMiniPart(part)}
                          </text>
                        )}
                      </box>
                    ))}
                  </box>
                ))
              ) : props.state.loading ? (
                <text fg={theme.textMuted}>{THINKING_TEXT}</text>
              ) : (
                <text fg={theme.textMuted}>Ask a side question below.</text>
              )}
              {props.state.error ? (
                <text fg={theme.error}>Error: {props.state.error}</text>
              ) : null}
              {props.state.errorDetail ? (
                <text fg={theme.textMuted}>{props.state.errorDetail}</text>
              ) : null}
              {createUserMessageHint() ? (
                <text fg={theme.warning}>{createUserMessageHint()}</text>
              ) : null}
              {props.state.loading && messages().length > 0 ? (
                <text fg={theme.textMuted}>{THINKING_TEXT}</text>
              ) : null}
            </box>
          </scrollbox>
        </box>
        <box
          paddingLeft={3}
          paddingRight={3}
          paddingBottom={1}
          flexDirection="column"
          gap={1}
          marginTop={1}
        >
          <box
            width={transcriptWidth}
            height={6}
            backgroundColor={theme.borderSubtle}
            flexDirection="column"
            paddingTop={1}
            paddingLeft={2}
            paddingRight={2}
            paddingBottom={1}
            justifyContent="space-between"
          >
            <input
              ref={(node) => {
                input = node;
                props.onInput?.(node);
              }}
              width={promptContentWidth}
              placeholder={
                props.state.inputPlaceholder ??
                (props.state.loading
                  ? "Waiting for response..."
                  : "Ask a question...")
              }
              textColor={theme.text}
              placeholderColor={theme.textMuted}
              backgroundColor={theme.borderSubtle}
              focusedTextColor={theme.text}
              cursorColor={theme.primary}
              focusedBackgroundColor={theme.borderSubtle}
              onInput={(value) => {
                inputValue = value;
              }}
              onSubmit={() => {
                const submitted = (input?.value || inputValue).trim();
                if (!submitted || props.state.loading) return;
                if (!props.onSubmit(submitted)) return;
                inputValue = "";
                if (input) input.value = "";
              }}
            />
            <box
              flexDirection="row"
              justifyContent="space-between"
              alignItems="center"
              width={promptContentWidth}
              gap={3}
            >
              <text fg={theme.text}>{footerModelName()}</text>
              <Show when={hasFooterCounter()}>
                <FooterCounter theme={theme} state={footerCounter()} />
              </Show>
            </box>
          </box>
          <box
            flexDirection="row"
            justifyContent="flex-end"
            alignItems="center"
            width={transcriptWidth}
            gap={2}
          >
            <Show when={props.state.error && !props.state.loading}>
              <ActionButton
                api={props.api}
                label="Retry"
                onPress={props.onRetry}
              />
            </Show>
            <Show when={canContinue()}>
              <ActionButton
                api={props.api}
                label={props.continueLabel}
                keybind="shift+enter"
                onPress={props.onContinue}
              />
            </Show>
            <ActionButton
              api={props.api}
              label="Toggle"
              keybind={props.hideKey || undefined}
              onPress={props.onHide}
            />
            <ActionButton
              api={props.api}
              label="Thinking"
              keybind={props.toggleThinkingKeybind || undefined}
              onPress={props.onToggleThinking}
            />
            <ActionButton
              api={props.api}
              label="Model"
              keybind="tab"
              onPress={props.onChangeModel}
            />
          </box>
        </box>
      </box>
    </box>
  );
}

function ThinkingPart(props: {
  theme: MiniTheme;
  part: ThinkingMiniPart;
  expanded: boolean;
  spinnerFrame: number;
  onToggle: () => void;
}) {
  const header = () =>
    formatThinkingHeader(props.part, props.expanded, props);
  const body = () => getThinkingBodyText(props.part);

  return (
    <box flexDirection="column" gap={0} opacity={props.expanded ? 0.65 : 1}>
      <box onMouseUp={props.onToggle}>
        <text fg={props.theme.warning}>
          <Show when={!props.expanded} fallback={header()}>
            <b>{header()}</b>
          </Show>
        </text>
      </box>
      <Show when={props.expanded && body()}>
        <box marginLeft={2} marginTop={1}>
          <text fg={props.theme.markdownBlockQuote}>{body()}</text>
        </box>
      </Show>
    </box>
  );
}

function FooterCounter(props: {
  theme: MiniTheme;
  state: AnswerDialogState["footerCounter"];
}) {
  if (!props.state.miniSession && !props.state.copiedContext) return <text />;

  return (
    <box flexDirection="row" gap={1}>
      <Show when={props.state.miniSession}>
        {(miniSession) => (
          <text
            fg={
              miniSession().warning ? props.theme.warning : props.theme.textMuted
            }
          >
            {miniSession().text}
          </text>
        )}
      </Show>
      <Show when={props.state.miniSession && props.state.copiedContext}>
        <text fg={props.theme.textMuted}>·</text>
      </Show>
      <Show when={props.state.copiedContext}>
        {(copiedContext) => (
          <text
            fg={
              copiedContext().truncated
                ? props.theme.warning
                : props.theme.textMuted
            }
          >
            {copiedContext().text}
          </text>
        )}
      </Show>
    </box>
  );
}

export function createOverlaySlot(options: {
  ctx: TuiContext;
  getOverlay: () => OverlayState | undefined;
  actions: MiniKeybindActions;
}) {
  return () => {
    registerPanelKeymap(
      options.ctx.keymap,
      buildPanelCommands(options.actions),
      () => Boolean(options.getOverlay()),
    );
    registerGlobalKeymap(options.ctx.keymap, buildGlobalCommands(options.actions));

    return (
      <Show when={options.getOverlay()}>
        {(current) => (
          <AnswerDialog
            api={current().api}
            title={current().title}
            version={current().version}
            modelName={current().modelName}
            hideKey={current().hideKey}
            toggleThinkingKeybind={current().toggleThinkingKeybind}
            continueLabel={current().continueLabel}
            continueOnError={current().continueOnError}
            state={current().state}
            onScroller={current().onScroller}
            onInput={current().onInput}
            onHide={current().onHide}
            onClose={current().onClose}
            onContinue={current().onContinue}
            onRetry={current().onRetry}
            onChangeModel={current().onChangeModel}
            onToggleThinking={current().onToggleThinking}
            onToggleThinkingPart={current().onToggleThinkingPart}
            onSubmit={current().onSubmit}
          />
        )}
      </Show>
    );
  };
}
