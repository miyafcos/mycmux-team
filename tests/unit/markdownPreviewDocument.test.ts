// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyMarkdownPreviewAppearance,
  buildMarkdownPreviewSrcDoc,
  classifyPreviewLink,
  findAnchorElement,
  type MarkdownPreviewAppearance,
} from "../../src/lib/markdownPreviewDocument";

const APPEARANCE: MarkdownPreviewAppearance = {
  palette: {
    scheme: "dark",
    vars: { "--md-bg": "#2e3440", "--md-text": "#d8dee9", "--md-link": "#88c0d0" },
  },
  monoFont: "'UDEV Gothic NF', monospace",
};

const LOCAL_IMAGE = "C:\\docs\\img\\a.png";

const PREVIEW = [
  '<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>body{margin:0}</style></head>',
  "<body><p>本文</p>",
  `<img data-mycmux-local-src="${LOCAL_IMAGE}" loading="lazy">`,
  "<script>alert(1)</script>",
  "</body></html>",
].join("");

const toAssetUrl = (path: string) => `http://asset.localhost/${encodeURIComponent(path)}`;

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}

function anchorIn(html: string): Element {
  const anchor = parse(`<body>${html}</body>`).querySelector("a");
  if (!anchor) throw new Error("the fixture has no anchor");
  return anchor;
}

describe("buildMarkdownPreviewSrcDoc", () => {
  it("paints the theme onto the document and points images at the asset protocol", () => {
    const srcDoc = buildMarkdownPreviewSrcDoc(PREVIEW, APPEARANCE, toAssetUrl);

    expect(srcDoc.startsWith("<!doctype html>\n<html")).toBe(true);
    expect(srcDoc).toContain('data-scheme="dark"');
    expect(srcDoc).toContain("--md-bg: #2e3440");
    expect(srcDoc).toContain("--md-text: #d8dee9");
    expect(srcDoc).toContain("--md-font-mono:");
    expect(srcDoc).toContain(`src="${toAssetUrl(LOCAL_IMAGE)}"`);
    // The renderer never writes one, and a <base> would send `#heading` links
    // to another URL instead of scrolling the page.
    expect(srcDoc).not.toContain("<base");
    expect(srcDoc).not.toContain("<script");
  });

  it("drops the font override when the reader's font cannot be used", () => {
    const srcDoc = buildMarkdownPreviewSrcDoc(PREVIEW, { ...APPEARANCE, monoFont: null }, toAssetUrl);

    expect(srcDoc).not.toContain("--md-font-mono");
    expect(srcDoc).toContain("--md-bg: #2e3440");
  });
});

describe("applyMarkdownPreviewAppearance", () => {
  it("lands on the same document twice over", () => {
    const doc = parse(PREVIEW);

    applyMarkdownPreviewAppearance(doc, APPEARANCE);
    const once = doc.documentElement.outerHTML;
    applyMarkdownPreviewAppearance(doc, APPEARANCE);

    expect(doc.documentElement.outerHTML).toBe(once);
  });

  it("removes the font override when the appearance no longer carries one", () => {
    const doc = parse(PREVIEW);

    applyMarkdownPreviewAppearance(doc, APPEARANCE);
    expect(doc.documentElement.getAttribute("style")).toContain("--md-font-mono");

    applyMarkdownPreviewAppearance(doc, { ...APPEARANCE, monoFont: null });
    expect(doc.documentElement.getAttribute("style")).not.toContain("--md-font-mono");
    expect(doc.documentElement.getAttribute("style")).toContain("--md-bg");
  });
});

describe("classifyPreviewLink", () => {
  it("sends a local path to the pane even when the href says otherwise", () => {
    const anchor = anchorIn(
      '<a href="other.md" data-mycmux-local-path="C:\\docs\\other.md">文書</a>',
    );

    expect(classifyPreviewLink(anchor)).toEqual({ kind: "local", path: "C:\\docs\\other.md" });
  });

  it("decodes the id of a link into the same document", () => {
    expect(classifyPreviewLink(anchorIn('<a href="#4-%E6%A4%9C">見出しへ</a>'))).toEqual({
      kind: "fragment",
      id: "4-検",
    });
    // A half-written escape is an id spelled exactly like that, not an error.
    expect(classifyPreviewLink(anchorIn('<a href="#%E4%B8">壊れた</a>'))).toEqual({
      kind: "fragment",
      id: "%E4%B8",
    });
    expect(classifyPreviewLink(anchorIn('<a href="#">先頭へ</a>'))).toEqual({
      kind: "fragment",
      id: "",
    });
  });

  it("recognises a web link whatever case it is written in", () => {
    expect(classifyPreviewLink(anchorIn('<a href="HTTPS://example.com/x">外</a>'))).toEqual({
      kind: "external",
      url: "HTTPS://example.com/x",
    });
    expect(classifyPreviewLink(anchorIn('<a href="mailto:a@example.com">mail</a>'))).toEqual({
      kind: "external",
      url: "mailto:a@example.com",
    });
  });

  it("does nothing for a target the pane must not follow", () => {
    expect(classifyPreviewLink(anchorIn('<a href="javascript:alert(1)">js</a>'))).toEqual({
      kind: "none",
    });
    expect(classifyPreviewLink(anchorIn("<a>裸のリンク</a>"))).toEqual({ kind: "none" });
  });
});

describe("findAnchorElement", () => {
  it("finds the link a click landed inside", () => {
    const doc = parse('<body><p><a href="#x"><span><strong>入れ子</strong></span></a> 外</p></body>');
    const anchor = doc.querySelector("a");
    const strong = doc.querySelector("strong");
    const text = strong?.firstChild ?? null;

    expect(findAnchorElement(strong)).toBe(anchor);
    expect(findAnchorElement(text)).toBe(anchor);
    expect(findAnchorElement(doc.querySelector("p"))).toBeNull();
    expect(findAnchorElement(null)).toBeNull();
  });
});
