import { Fragment } from "react";
import type { ReactNode } from "react";
import "./MarkdownView.css";

import { parseMarkdown, type MdBlock, type MdInline } from "./markdownModel";
import { DashboardLinkedText, DashboardUrlLink, type DashboardLinkContext } from "./DashboardLinkedText";

function InlineContent({ inline, context, linksEnabled = true }: { inline: readonly MdInline[]; context: DashboardLinkContext | null; linksEnabled?: boolean }): ReactNode {
  return inline.map((part, index) => {
    const key = `${part.type}-${index}`;
    switch (part.type) {
      case "text": return <Fragment key={key}><DashboardLinkedText text={part.text} context={context} linksEnabled={linksEnabled} /></Fragment>;
      case "bold": return <strong key={key}><InlineContent inline={part.children} context={context} linksEnabled={linksEnabled} /></strong>;
      case "italic": return <em key={key}><InlineContent inline={part.children} context={context} linksEnabled={linksEnabled} /></em>;
      case "code": return <code key={key} className="cmux-dashboard-markdown-inline-code"><DashboardLinkedText text={part.text} context={context} linksEnabled={linksEnabled} /></code>;
      case "link": return <DashboardUrlLink key={key} url={part.url} context={context}><InlineContent inline={part.label} context={context} linksEnabled={false} /></DashboardUrlLink>;
    }
  });
}

function MarkdownBlock({ block, context }: { block: MdBlock; context: DashboardLinkContext | null }) {
  switch (block.type) {
    case "heading": {
      const Tag = (`h${block.level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6");
      return <Tag><InlineContent inline={block.inline} context={context} /></Tag>;
    }
    case "paragraph": return <p className="cmux-dashboard-markdown-paragraph"><InlineContent inline={block.inline} context={context} /></p>;
    case "list": {
      return <MarkdownList block={block} context={context} />;
    }
    case "code": return <pre className="cmux-dashboard-markdown-code"><code><DashboardLinkedText text={block.text} context={context} /></code></pre>;
    case "quote": return <blockquote className="cmux-dashboard-markdown-quote"><InlineContent inline={block.inline} context={context} /></blockquote>;
    case "hr": return <hr className="cmux-dashboard-markdown-rule" />;
    case "table": return <div className="cmux-dashboard-markdown-table-scroll" tabIndex={0} aria-label="表">
      <table className="cmux-dashboard-markdown-table">
        <thead><tr>{block.header.map((cell, index) => <th key={index} scope="col" data-align={block.align[index]} data-numeric={block.numeric[index] || undefined}><InlineContent inline={cell} context={context} /></th>)}</tr></thead>
        <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex} data-align={block.align[columnIndex]} data-numeric={block.numeric[columnIndex] || undefined}><InlineContent inline={cell} context={context} /></td>)}</tr>)}</tbody>
      </table>
    </div>;
  }
}

function MarkdownList({ block, context }: { block: Extract<MdBlock, { type: "list" }>; context: DashboardLinkContext | null }) {
  const Tag = block.ordered ? "ol" : "ul";
  return <Tag className={`cmux-dashboard-markdown-list${block.items.some((item) => item.checked !== null) ? " is-checklist" : ""}`}>
    {block.items.map((item, index) => <li key={index} className={item.checked === null ? undefined : "cmux-dashboard-markdown-checkitem"}>
      {item.checked === null ? null : <span className={`cmux-dashboard-markdown-check ${item.checked ? "is-checked" : ""}`} role="img" aria-label={item.checked ? "完了" : "未完了"}>{item.checked ? "✓" : ""}</span>}
      <InlineContent inline={item.inline} context={context} />
      {item.children.map((child, childIndex) => <MarkdownList key={childIndex} block={child} context={context} />)}
    </li>)}
  </Tag>;
}

export function MarkdownView({ text, context = null }: { text: string; context?: DashboardLinkContext | null }) {
  return <div className="cmux-dashboard-markdown">{parseMarkdown(text).map((block, index) => <MarkdownBlock key={index} block={block} context={context} />)}</div>;
}
