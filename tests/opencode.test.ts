import type { ResolvedTheme } from "@opencode/theme/tui";
import { describe, expect, it } from "vitest";
import { adaptTheme, getCurrentRoute } from "../src/opencode";

function theme(): ResolvedTheme {
  return {
    text: {
      default: "text.default",
      subdued: "text.subdued",
      action: {
        primary: { default: "action.primary" },
        secondary: { default: "action.secondary" },
        destructive: { default: "action.destructive" },
      },
      feedback: {
        error: { default: "feedback.error" },
        warning: { default: "feedback.warning" },
        info: { default: "feedback.info" },
        success: { default: "feedback.success" },
      },
    },
    background: {
      surface: {
        offset: "surface.offset",
        overlay: "surface.overlay",
      },
    },
    border: { default: "border.default" },
    markdown: {
      text: "md.text",
      heading: "md.heading",
      strong: "md.strong",
      emphasis: "md.emphasis",
      link: "md.link",
      linkText: "md.linkText",
      code: "md.code",
      codeBlock: "md.codeBlock",
      blockQuote: "md.blockQuote",
    },
    syntax: {
      comment: "syntax.comment",
      keyword: "syntax.keyword",
      function: "syntax.function",
      variable: "syntax.variable",
      string: "syntax.string",
      number: "syntax.number",
      type: "syntax.type",
      operator: "syntax.operator",
      punctuation: "syntax.punctuation",
    },
  } as unknown as ResolvedTheme;
}

describe("adaptTheme", () => {
  it("maps the V2 theme tokens used by the overlay components", () => {
    const adapted = adaptTheme(theme());

    expect(adapted.text).toBe("text.default");
    expect(adapted.textMuted).toBe("text.subdued");
    expect(adapted.primary).toBe("action.primary");
    expect(adapted.error).toBe("feedback.error");
    expect(adapted.warning).toBe("feedback.warning");
    expect(adapted.info).toBe("feedback.info");
    expect(adapted.success).toBe("feedback.success");
    expect(adapted.border).toBe("border.default");
    expect(adapted.backgroundPanel).toBe("surface.overlay");
    expect(adapted.borderSubtle).toBe("surface.offset");
    expect(adapted.markdownText).toBe("md.text");
    expect(adapted.markdownHeading).toBe("md.heading");
    expect(adapted.markdownEmph).toBe("md.emphasis");
    expect(adapted.markdownBlockQuote).toBe("md.blockQuote");
    expect(adapted.syntaxKeyword).toBe("syntax.keyword");
    expect(adapted.syntaxPunctuation).toBe("syntax.punctuation");
  });
});

describe("getCurrentRoute", () => {
  it("returns the session route when one is open", () => {
    expect(
      getCurrentRoute({
        ui: { router: { current: () => ({ type: "session", sessionID: "s1" }) } },
      } as any),
    ).toEqual({ kind: "session", sessionID: "s1" });
  });

  it("returns other for home and plugin routes", () => {
    expect(
      getCurrentRoute({
        ui: { router: { current: () => ({ type: "home" }) } },
      } as any),
    ).toEqual({ kind: "other" });
  });
});
