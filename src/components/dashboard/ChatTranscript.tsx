import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SemanticEventEnvelope } from "../../lib/livebrief";
import { DashboardLinkedText, type DashboardLinkContext } from "./DashboardLinkedText";
import { MarkdownView } from "./MarkdownView";
import { toChatTranscriptRows, type ChatMessage, type ToolTranscriptItem } from "./chatModel";
import type { DashboardAgentKind, DashboardDisplayState } from "./dashboardModel";
import { dashboardStrings } from "./dashboardStrings";
import { stateLabels } from "./stateLabels";

const FOLLOW_SLACK_PX = 24;

function clockLabel(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const ChatBubble = memo(function ChatBubble({ message, context, highlighted }: { message: ChatMessage; context: DashboardLinkContext | null; highlighted: boolean }) {
  const className = `cmux-dashboard-msg ${message.role === "assistant" ? "is-agent" : message.role === "error" ? "is-error" : "is-user"}${highlighted ? " is-source-highlighted" : ""}`;
  if (message.role === "assistant") return <div id={`dashboard-event-${message.id}`} data-dashboard-event={message.id} className={className}><MessageLabel message={message} /><MarkdownView text={message.text} context={context} /></div>;
  if (message.role === "error") return <div id={`dashboard-event-${message.id}`} data-dashboard-event={message.id} className={className}><MessageLabel message={message} /><div className="cmux-dashboard-msg-plain"><DashboardLinkedText text={message.text} context={context} /></div></div>;
  return <div id={`dashboard-event-${message.id}`} data-dashboard-event={message.id} className={className}><MessageLabel message={message} /><div className="cmux-dashboard-msg-plain"><DashboardLinkedText text={message.text} context={context} /></div></div>;
});

function MessageLabel({ message }: { message: ChatMessage }) {
  const label = message.role === "user" ? dashboardStrings.chatRoleUser : dashboardStrings.chatRoleAgent;
  return <div className="cmux-dashboard-msg-who"><span>{label}</span><span>{clockLabel(message.at)}</span></div>;
}

function toolStatus(item: ToolTranscriptItem): string {
  return item.ok === false ? "✗" : item.ok ? "✓" : "…";
}

function previewText(text: string): { preview: string; hasMore: boolean } {
  const lines = text.split("\n");
  return { preview: lines.slice(0, 3).join("\n"), hasMore: lines.length > 3 };
}

function ToolDetails({ tool, context }: { tool: ToolTranscriptItem; context: DashboardLinkContext | null }) {
  const output = tool.summary ? previewText(tool.summary) : null;
  return <div className="cmux-dashboard-toolfold-item">
    <div>{`${toolStatus(tool)} ${tool.tool}`}{tool.target ? <> (<DashboardLinkedText text={tool.target} context={context} />)</> : null}</div>
    {output ? <div className="cmux-dashboard-tool-output"><DashboardLinkedText text={output.preview} context={context} /></div> : null}
    {output?.hasMore ? <details className="cmux-dashboard-tool-fulltext">
      <summary>▸ 全文</summary>
      <div><DashboardLinkedText text={tool.summary ?? ""} context={context} /></div>
    </details> : null}
  </div>;
}

function agentLabel(kind: DashboardAgentKind): string {
  if (kind === "claude") return "Claude Code";
  if (kind === "codex") return "Codex";
  if (kind === "claude-codex") return "Claude Code / Codex";
  if (kind === "grok") return "Grok Build";
  return "セッション";
}

/** 停止側の経過表示。分未満は丸め、時間単位まで粗くする (秒は刻まない)。 */
function coarseElapsedLabel(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return "最終出力 1分未満前";
  if (minutes < 60) return `最終出力 ${minutes}分前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `最終出力 ${hours}時間前`;
  return `最終出力 ${Math.floor(hours / 24)}日前`;
}

function ChatActivityFooter({ displayState, agentKind, lastOutputAt }: {
  displayState: DashboardDisplayState;
  agentKind: DashboardAgentKind;
  lastOutputAt: number | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  const labels = stateLabels(displayState);
  const working = labels.activity === "working";

  // 秒を刻むのは動いている間だけ。止まっている相手の経過秒を毎秒書き換えても
  // 「変わらない数字が動く」だけで、目を引くわりに何も伝えない。
  useEffect(() => {
    if (!working) return;
    let disposed = false;
    let timeoutId: number | undefined;
    const schedule = () => {
      timeoutId = window.setTimeout(() => {
        if (disposed) return;
        setNow(Date.now());
        schedule();
      }, 1_000);
    };
    schedule();
    return () => {
      disposed = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [working]);

  const elapsedMs = lastOutputAt ? Math.max(0, now - lastOutputAt) : null;
  const timeLabel = elapsedMs === null
    ? "出力待ち"
    : working
      ? `最終出力 ${Math.floor(elapsedMs / 1_000)}秒前`
      : coarseElapsedLabel(elapsedMs);
  return <div className={`cmux-dashboard-chat-activity${working ? " is-working" : ""}`} aria-live="polite">
    <span className="cmux-dashboard-chat-activity-glyph" aria-hidden="true">{working ? "⋯" : "•"}</span>
    <span>{`${agentLabel(agentKind)} · ${labels.activityLabel} · ${timeLabel}`}</span>
  </div>;
}

export function ChatTranscript({
  events,
  sessionId = null,
  displayState = "idle",
  agentKind = "none",
  lastOutputAt = null,
  linkContext = null,
  targetEventId = null,
  targetEventRequest = 0,
  syntheticSource = null,
}: {
  events: readonly SemanticEventEnvelope[];
  sessionId?: string | null;
  displayState?: DashboardDisplayState;
  agentKind?: DashboardAgentKind;
  lastOutputAt?: number | null;
  linkContext?: DashboardLinkContext | null;
  targetEventId?: string | null;
  targetEventRequest?: number;
  syntheticSource?: { eventId: string; text: string; at: number } | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const [expandedToolGroups, setExpandedToolGroups] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(() => toChatTranscriptRows(events), [events]);
  const lastRow = rows.length ? rows[rows.length - 1] : undefined;
  const lastId = lastRow?.kind === "message" ? lastRow.message.id : lastRow?.id;

  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    followRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= FOLLOW_SLACK_PX;
  }, []);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node || !followRef.current) return;
    node.scrollTop = node.scrollHeight;
  }, [lastId, rows.length]);

  useEffect(() => {
    if (!targetEventId) return;
    document.getElementById(`dashboard-event-${targetEventId}`)?.scrollIntoView({ block: "nearest" });
  }, [targetEventId, targetEventRequest, rows]);

  const onToolGroupToggle = useCallback((key: string, open: boolean) => {
    setExpandedToolGroups((current) => {
      const next = new Set(current);
      if (open) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const footer = <ChatActivityFooter displayState={displayState} agentKind={agentKind} lastOutputAt={lastOutputAt} />;
  if (!rows.length && !syntheticSource) return <><div className="cmux-dashboard-chat-empty">{dashboardStrings.chatEmpty}</div>{footer}</>;
  return <div ref={scrollRef} onScroll={onScroll} role="log" aria-label={dashboardStrings.chatAriaLabel} className="cmux-dashboard-chat">
    {syntheticSource ? <div id={`dashboard-event-${syntheticSource.eventId}`} data-dashboard-event={syntheticSource.eventId} className={`cmux-dashboard-msg is-agent is-status-source${syntheticSource.eventId === targetEventId ? " is-source-highlighted" : ""}`}>
      <div className="cmux-dashboard-msg-who"><span>状態イベント</span><span>{clockLabel(syntheticSource.at)}</span></div>
      <div className="cmux-dashboard-msg-plain">{syntheticSource.text}</div>
    </div> : null}
    {rows.map((row) => row.kind === "message"
      ? row.message.role === "question" ? null : <ChatBubble key={row.message.id} message={row.message} context={linkContext} highlighted={row.message.id === targetEventId} />
      : <details key={row.id} className="cmux-dashboard-toolfold" open={expandedToolGroups.has(`${sessionId ?? "none"}:${row.id}`)} onToggle={(event) => onToolGroupToggle(`${sessionId ?? "none"}:${row.id}`, event.currentTarget.open)}>
        <summary>{`▸ ツール実行 ${row.tools.length}件`}</summary>
        {row.tools.map((tool) => <ToolDetails key={tool.id} tool={tool} context={linkContext} />)}
      </details>)}
    {footer}
  </div>;
}
