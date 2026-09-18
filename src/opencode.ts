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

/**
 * The resolved theme shape changes between OpenCode releases (2.0.8 replaced
 * `background.surface` with `background.raised`), and the plugin renders inside
 * a slot where a throw takes the whole overlay down. Read every token
 * defensively and fall back to related colors so a theme change degrades
 * instead of crashing.
 */
type ThemeToken = unknown;

type MiniThemeSource = {
  text?: {
    default?: ThemeToken;
    subdued?: ThemeToken;
    action?: { primary?: { default?: ThemeToken } };
    feedback?: Record<string, { default?: ThemeToken } | undefined>;
  };
  background?: {
    default?: ThemeToken;
    raised?: { base?: ThemeToken; high?: ThemeToken };
    /** OpenCode <= 2.0.7 */
    surface?: { offset?: ThemeToken; overlay?: ThemeToken };
  };
  border?: { default?: ThemeToken };
  markdown?: Record<string, ThemeToken>;
  syntax?: Record<string, ThemeToken>;
};

export function adaptTheme(theme: ResolvedTheme): MiniTheme {
  const source = theme as unknown as MiniThemeSource;
  const text = source?.text;
  const background = source?.background;
  const raised = background?.raised;
  const surface = background?.surface;
  const markdown = source?.markdown;
  const syntax = source?.syntax;

  const fallbackText = (text?.default ?? "#ffffff") as RGBA;
  const pick = (...candidates: unknown[]): RGBA => {
    for (const candidate of candidates) {
      if (candidate !== undefined && candidate !== null) return candidate as RGBA;
    }
    return fallbackText;
  };

  return {
    text: pick(text?.default),
    textMuted: pick(text?.subdued, text?.default),
    primary: pick(text?.action?.primary?.default, text?.default),
    secondary: pick(text?.subdued, text?.default),
    error: pick(text?.feedback?.error?.default, text?.default),
    warning: pick(text?.feedback?.warning?.default, text?.default),
    info: pick(text?.feedback?.info?.default, text?.default),
    success: pick(text?.feedback?.success?.default, text?.default),
    border: pick(source?.border?.default, text?.subdued, text?.default),
    backgroundPanel: pick(
      surface?.overlay,
      raised?.high,
      raised?.base,
      background?.default,
      text?.default,
    ),
    borderSubtle: pick(
      surface?.offset,
      raised?.base,
      source?.border?.default,
      text?.subdued,
      text?.default,
    ),
    markdownText: pick(markdown?.text, text?.default),
    markdownHeading: pick(markdown?.heading, text?.default),
    markdownStrong: pick(markdown?.strong, text?.default),
    markdownEmph: pick(markdown?.emphasis, text?.default),
    markdownLink: pick(markdown?.link, text?.default),
    markdownLinkText: pick(markdown?.linkText, text?.default),
    markdownCode: pick(markdown?.code, text?.default),
    markdownCodeBlock: pick(markdown?.codeBlock, text?.default),
    markdownBlockQuote: pick(markdown?.blockQuote, text?.default),
    syntaxComment: pick(syntax?.comment, text?.subdued, text?.default),
    syntaxKeyword: pick(syntax?.keyword, text?.default),
    syntaxFunction: pick(syntax?.function, text?.default),
    syntaxVariable: pick(syntax?.variable, text?.default),
    syntaxString: pick(syntax?.string, text?.default),
    syntaxNumber: pick(syntax?.number, text?.default),
    syntaxType: pick(syntax?.type, text?.default),
    syntaxOperator: pick(syntax?.operator, text?.default),
    syntaxPunctuation: pick(syntax?.punctuation, text?.default),
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
