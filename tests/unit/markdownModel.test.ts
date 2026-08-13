import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../../src/components/dashboard/markdownModel";

describe("parseMarkdown", () => {
  it("parses headings, lists, quotes, and paragraphs without losing line breaks", () => {
    expect(parseMarkdown("# Title\n\n- one\n- two\n\n1. first\n2. second\n\n> note\n\nline one\nline two")).toMatchObject([
      { type: "heading", level: 1 },
      { type: "list", ordered: false },
      { type: "list", ordered: true },
      { type: "quote" },
      { type: "paragraph", inline: [{ type: "text", text: "line one\nline two" }] },
    ]);
  });

  it("parses fenced code and keeps an unclosed fence as code through the end", () => {
    expect(parseMarkdown("```ts\nconst x = 1;\n```\n\n```\nunfinished")).toEqual([
      { type: "code", lang: "ts", text: "const x = 1;" },
      { type: "code", lang: null, text: "unfinished" },
    ]);
  });

  it("parses inline strong, emphasis, code, and links while preserving unsupported text", () => {
    expect(parseMarkdown("**bold** *italic* `code` [site](https://example.test) <raw>")).toEqual([{ type: "paragraph", inline: [
      { type: "bold", children: [{ type: "text", text: "bold" }] },
      { type: "text", text: " " },
      { type: "italic", children: [{ type: "text", text: "italic" }] },
      { type: "text", text: " " },
      { type: "code", text: "code" },
      { type: "text", text: " " },
      { type: "link", label: [{ type: "text", text: "site" }], url: "https://example.test" },
      { type: "text", text: " <raw>" },
    ] }]);
  });

  it("is safe for empty and malformed input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(() => parseMarkdown("**unclosed [link](")).not.toThrow();
  });
});
