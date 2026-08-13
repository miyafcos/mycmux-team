import { Fragment } from "react";
import type { CSSProperties, MouseEvent, ReactNode } from "react";

import { parseMarkdown, type MdBlock, type MdInline } from "./markdownModel";

function preventNavigation(event: MouseEvent<HTMLAnchorElement>) {
  event.preventDefault();
}

function InlineContent({ inline }: { inline: readonly MdInline[] }): ReactNode {
  return inline.map((part, index) => {
    const key = `${part.type}-${index}`;
    switch (part.type) {
      case "text": return <Fragment key={key}>{part.text}</Fragment>;
      case "bold": return <strong key={key}><InlineContent inline={part.children} /></strong>;
      case "italic": return <em key={key}><InlineContent inline={part.children} /></em>;
      case "code": return <code key={key} style={inlineCodeStyle}>{part.text}</code>;
      case "link": return <a key={key} role="link" tabIndex={0} title={part.url} onClick={preventNavigation} style={linkStyle}><InlineContent inline={part.label} /></a>;
    }
  });
}

function MarkdownBlock({ block }: { block: MdBlock }) {
  switch (block.type) {
    case "heading": {
      const Tag = (`h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
      return <Tag style={headingStyle[block.level] ?? headingStyle[3]}><InlineContent inline={block.inline} /></Tag>;
    }
    case "paragraph": return <p style={paragraphStyle}><InlineContent inline={block.inline} /></p>;
    case "list": {
      const Tag = block.ordered ? "ol" : "ul";
      return <Tag style={listStyle}>{block.items.map((item, index) => <li key={index}><InlineContent inline={item} /></li>)}</Tag>;
    }
    case "code": return <pre style={codeBlockStyle}><code>{block.text}</code></pre>;
    case "quote": return <blockquote style={quoteStyle}><InlineContent inline={block.inline} /></blockquote>;
  }
}

export function MarkdownView({ text }: { text: string }) {
  return <div style={rootStyle}>{parseMarkdown(text).map((block, index) => <MarkdownBlock key={index} block={block} />)}</div>;
}

const rootStyle: CSSProperties = { display: "grid", gap: 8, minWidth: 0, fontSize: "var(--cmux-font-size-sm)", lineHeight: 1.75, overflowWrap: "anywhere" };
const paragraphStyle: CSSProperties = { margin: 0, whiteSpace: "pre-wrap" };
const listStyle: CSSProperties = { margin: 0, paddingLeft: 22, display: "grid", gap: 2 };
const codeBlockStyle: CSSProperties = { margin: 0, background: "var(--cmux-bg-solid)", border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-md)", padding: 10, fontFamily: "var(--cmux-font-mono)", fontSize: "var(--cmux-font-size-xs)", lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre" };
const inlineCodeStyle: CSSProperties = { background: "var(--cmux-hover)", border: "1px solid var(--cmux-border-hairline)", borderRadius: "var(--cmux-radius-sm)", padding: "0 4px", fontFamily: "var(--cmux-font-mono)" };
const quoteStyle: CSSProperties = { margin: 0, borderLeft: "3px solid var(--cmux-border)", paddingLeft: 10, color: "var(--cmux-text-secondary)", whiteSpace: "pre-wrap" };
const linkStyle: CSSProperties = { color: "var(--cmux-accent)", cursor: "pointer", textDecoration: "underline" };
const headingStyle: Record<number, CSSProperties> = {
  1: { margin: 0, fontSize: 15, fontWeight: 700 },
  2: { margin: 0, fontSize: 14, fontWeight: 700 },
  3: { margin: 0, fontSize: 13, fontWeight: 700 },
  4: { margin: 0, fontSize: 13, fontWeight: 700 },
  5: { margin: 0, fontSize: 13, fontWeight: 700 },
  6: { margin: 0, fontSize: 13, fontWeight: 700 },
};
