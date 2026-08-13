import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

import type { SemanticEventEnvelope } from "../../lib/livebrief";
import { MarkdownView } from "./MarkdownView";
import { toChatMessages, type ChatMessage } from "./chatModel";
import { dashboardStrings } from "./dashboardStrings";

const FOLLOW_SLACK_PX = 24;

function clockLabel(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const ChatBubble = memo(function ChatBubble({ message }: { message: ChatMessage }) {
  if (message.role === "assistant") return <div style={assistantStyle}><MessageLabel message={message} /><MarkdownView text={message.text} /></div>;
  if (message.role === "question") return <div style={questionStyle}><MessageLabel message={message} /><div style={plainTextStyle}>{message.text}</div></div>;
  if (message.role === "error") return <div style={errorStyle}><MessageLabel message={message} /><div style={plainTextStyle}>{message.text}</div></div>;
  return <div style={userStyle}><MessageLabel message={message} /><div style={plainTextStyle}>{message.text}</div></div>;
});

function MessageLabel({ message }: { message: ChatMessage }) {
  const label = message.role === "user" ? dashboardStrings.chatRoleUser : dashboardStrings.chatRoleAgent;
  return <div style={labelStyle}><span>{label}</span><span>{clockLabel(message.at)}</span></div>;
}

export function ChatTranscript({ events }: { events: readonly SemanticEventEnvelope[] }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const messages = useMemo(() => toChatMessages(events), [events]);
  const lastId = messages[messages.length - 1]?.id;

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [messages.length, lastId]);

  if (!messages.length) return <div style={emptyStyle}>{dashboardStrings.chatEmpty}</div>;
  return <div ref={scrollRef} onScroll={onScroll} role="log" aria-label={dashboardStrings.chatAriaLabel} style={scrollStyle}>
    {messages.map((message) => <ChatBubble key={message.id} message={message} />)}
  </div>;
}

const scrollStyle: CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 2 };
const labelStyle: CSSProperties = { display: "flex", justifyContent: "space-between", gap: 12, color: "var(--cmux-text-tertiary)", fontFamily: "var(--cmux-font-mono)", fontSize: "var(--cmux-font-size-xs)" };
const plainTextStyle: CSSProperties = { whiteSpace: "pre-wrap", overflowWrap: "anywhere" };
const commonBubbleStyle: CSSProperties = { display: "grid", gap: 4, maxWidth: "88%", minWidth: 0, fontSize: "var(--cmux-font-size-sm)", lineHeight: 1.75, overflowWrap: "anywhere" };
const userStyle: CSSProperties = { ...commonBubbleStyle, alignSelf: "flex-end", background: "var(--cmux-surface-raised)", border: "1px solid var(--cmux-border)", borderRadius: "var(--cmux-radius-lg)", padding: "7px 11px" };
const assistantStyle: CSSProperties = { ...commonBubbleStyle, alignSelf: "stretch", maxWidth: "100%", padding: "2px 0" };
const questionStyle: CSSProperties = { ...commonBubbleStyle, alignSelf: "stretch", background: "color-mix(in srgb, var(--status-waiting) 10%, transparent)", borderRadius: "var(--cmux-radius-sm)", color: "var(--status-waiting)", padding: "5px 8px" };
const errorStyle: CSSProperties = { ...commonBubbleStyle, alignSelf: "stretch", color: "var(--status-error)", padding: "2px 0" };
const emptyStyle: CSSProperties = { color: "var(--cmux-text-secondary)", fontSize: "var(--cmux-font-size-sm)", padding: "8px 0" };
