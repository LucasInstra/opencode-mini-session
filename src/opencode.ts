import type { RGBA } from "@opentui/core";
import type { Context as TuiContext } from "@opencode/plugin/tui/context";
import type { ResolvedTheme } from "@opencode/theme/tui";

export type { TuiContext };

export type MiniTheme = {
  text: RGBA;
  textMuted: RGBA;
  primary: RGBA;
  secondary: RGBA;
  error: RGBA;
  warning: RGBA;
  info: RGBA;
  success: RGBA;
  border: RGBA;
  backgroundPanel: RGBA;
  borderSubtle: RGBA;
  markdownText: RGBA;
  markdownHeading: RGBA;
  markdownStrong: RGBA;
  markdownEmph: RGBA;
  markdownLink: RGBA;
  markdownLinkText: RGBA;
  markdownCode: RGBA;
  markdownCodeBlock: RGBA;
  markdownBlockQuote: RGBA;
  syntaxComment: RGBA;
  syntaxKeyword: RGBA;
  syntaxFunction: RGBA;
  syntaxVariable: RGBA;
  syntaxString: RGBA;
  syntaxNumber: RGBA;
  syntaxType: RGBA;
  syntaxOperator: RGBA;
  syntaxPunctuation: RGBA;
};

export function adaptTheme(theme: ResolvedTheme): MiniTheme {
  return {
    text: theme.text.default,
    textMuted: theme.text.subdued,
    primary: theme.text.action.primary.default,
    secondary: theme.text.subdued,
    error: theme.text.feedback.error.default,
    warning: theme.text.feedback.warning.default,
    info: theme.text.feedback.info.default,
    success: theme.text.feedback.success.default,
    border: theme.border.default,
    backgroundPanel: theme.background.surface.overlay,
    borderSubtle: theme.background.surface.offset,
    markdownText: theme.markdown.text,
    markdownHeading: theme.markdown.heading,
    markdownStrong: theme.markdown.strong,
    markdownEmph: theme.markdown.emphasis,
    markdownLink: theme.markdown.link,
    markdownLinkText: theme.markdown.linkText,
    markdownCode: theme.markdown.code,
    markdownCodeBlock: theme.markdown.codeBlock,
    markdownBlockQuote: theme.markdown.blockQuote,
    syntaxComment: theme.syntax.comment,
    syntaxKeyword: theme.syntax.keyword,
    syntaxFunction: theme.syntax.function,
    syntaxVariable: theme.syntax.variable,
    syntaxString: theme.syntax.string,
    syntaxNumber: theme.syntax.number,
    syntaxType: theme.syntax.type,
    syntaxOperator: theme.syntax.operator,
    syntaxPunctuation: theme.syntax.punctuation,
  };
}

export type MiniRoute =
  | { kind: "session"; sessionID: string }
  | { kind: "other" };

export function getCurrentRoute(ctx: TuiContext): MiniRoute {
  const route = ctx.ui.router.current();
  if (route.type === "session") return { kind: "session", sessionID: route.sessionID };
  return { kind: "other" };
}
