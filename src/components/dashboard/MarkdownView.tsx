import { Fragment } from "react";
import type { CSSProperties, ReactNode } from "react";

import { parseMarkdown, type MdBlock, type MdInline } from "./markdownModel";
import { DashboardLinkedText, DashboardUrlLink, type DashboardLinkContext } from "./DashboardLinkedText";

function InlineContent({ inline, context, linksEnabled = true }: { inline: readonly MdInline[]; context: DashboardLinkContext | null; linksEnabled?: boolean }): ReactNode {
  return inline.map((part, index) => {
    const key = `${part.type}-${index}`;
    switch (part.type) {
      case "text": return <Fragment key={key}><DashboardLinkedText text={part.text} context={context} linksEnabled={linksEnabled} /></Fragment>;
      case "bold": return <strong key={key}><InlineContent inline={part.children} context={context} linksEnabled={linksEnabled} /></strong>;
      case "italic": return <em key={key}><InlineContent inline={part.children} context={context} linksEnabled={linksEnabled} /></em>;
      case "code": return <code key={key} style={inlineCodeStyle}><DashboardLinkedText text={part.text} context={context} linksEnabled={linksEnabled} /></code>;
      case "link": return <DashboardUrlLink key={key} url={part.url} context={context}><InlineContent inline={part.label} context={context} linksEnabled={false} /></DashboardUrlLink>;
    }
  });
}

function MarkdownBlock({ block, context }: { block: MdBlock; context: DashboardLinkContext | null }) {
  switch (block.type) {
    case "heading": {
      const Tag = (`h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
      return <Tag style={headingStyle[block.level] ?? headingStyle[3]}><InlineContent inline={block.inline} context={context} /></Tag>;
    }
    case "paragraph": return <p style={paragraphStyle}><InlineContent inline={block.inline} context={context} /></p>;
    case "list": {
      return <MarkdownList block={block} context={context} />;
    }
    case "code": return <pre style={codeBlockStyle}><code><DashboardLinkedText text={block.text} context={context} /></code></pre>;
    case "quote": return <blockquote style={quoteStyle}><InlineContent inline={block.inline} context={context} /></blockquote>;
    case "hr": return <hr className="cmux-dashboard-markdown-rule" />;
    case "table": return <div className="cmux-dashboard-markdown-table-scroll" tabIndex={0} aria-label="Markdown table">
      <table className="cmux-dashboard-markdown-table">
        <thead><tr>{block.header.map((cell, index) => <th key={index} scope="col" data-align={block.align[index]} data-numeric={block.numeric[index] || undefined}><InlineContent inline={cell} context={context} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex} data-align={block.align[columnIndex]} data-numeric={block.numeric[columnIndex] || undefined}><InlineContent inline={cell} context={context} /></td>)}</tr>)}</tbody>
      </table>
    </div>;
  }
}

function MarkdownList({ block, context }: { block: Extract<MdBlock, { type: "list" }>; context: DashboardLinkContext | null }) {
  const Tag = block.ordered ? "ol" : "ul";
  return <Tag className={`cmux-dashboard-markdown-list${block.items.some((item) => item.checked !== null) ? " is-checklist" : ""}`} style={listStyle}>
    {block.items.map((item, index) => <li key={index} className={item.checked === null ? undefined : "cmux-dashboard-markdown-checkitem"}>
      {item.checked === null ? null : <span className={`cmux-dashboard-markdown-check ${item.checked ? "is-checked" : ""}`} role="img" aria-label={item.checked ? "完了" : "未完了"}>{item.checked ? "✓" : ""}</span>}
      <InlineContent inline={item.inline} context={context} />
      {item.children.map((child, childIndex) => <MarkdownList key={childIndex} block={child} context={context} />)}
    </li>)}
  </Tag>;
}

export function MarkdownView({ text, context = null }: { text: string; context?: DashboardLinkContext | null }) {
  return <div className="cmux-dashboard-markdown" style={rootStyle}>{parseMarkdown(text).map((block, index) => <MarkdownBlock key={index} block={block} context={context} />)}</div>;
}

const rootStyle: CSSProperties = { display: "grid", gap: 8, minWidth: 0, fontSize: "var(--cmux-font-size-sm)", lineHeight: 1.75, overflowWrap: "anywhere" };
const paragraphStyle: CSSProperties = { margin: 0, whiteSpace: "pre-wrap" };
const listStyle: CSSProperties = { margin: 0, paddingLeft: 22, display: "grid", gap: 2 };
const codeBlockStyle: CSSProperties = { margin: 0, background: "var(--cmux-bg-solid)", border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-md)", padding: 10, fontFamily: "var(--cmux-dash-body-font)", fontSize: "var(--cmux-font-size-xs)", lineHeight: 1.6, overflowX: "auto", whiteSpace: "pre" };
const inlineCodeStyle: CSSProperties = { background: "var(--cmux-hover)", border: "1px solid var(--cmux-border-hairline)", borderRadius: "var(--cmux-radius-sm)", padding: "0 4px", fontFamily: "var(--cmux-dash-body-font)" };
const quoteStyle: CSSProperties = { margin: 0, borderLeft: "3px solid var(--cmux-border)", paddingLeft: 10, color: "var(--cmux-text-secondary)", whiteSpace: "pre-wrap" };
const headingStyle: Record<number, CSSProperties> = {
  1: { margin: 0, fontSize: 15, fontWeight: 700 },
  2: { margin: 0, fontSize: 14, fontWeight: 700 },
  3: { margin: 0, fontSize: 13, fontWeight: 700 },
  4: { margin: 0, fontSize: 13, fontWeight: 700 },
  5: { margin: 0, fontSize: 13, fontWeight: 700 },
  6: { margin: 0, fontSize: 13, fontWeight: 700 },
};
