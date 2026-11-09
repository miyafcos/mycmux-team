import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useWorkspaceListStore } from "../../stores/workspaceListStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { useLiveBriefStore } from "../../stores/liveBriefStore";
import { useStallStore } from "../../stores/stallStore";
import { getAgentTabCards } from "./agentTabCards";
import { TerminalTranscriptPanel } from "./TerminalTranscriptPanel";
import "../dashboard/DashboardView.css";
import "./AgentTabConversation.css";

/** Reuse the dashboard model and composer without mounting the dashboard. */
export function AgentTabConversation({ sessionId, tabId, agentKind, visible, active, inputRef, focusRequest, onTerminal, onEscape, onVisible }: {
  sessionId: string; tabId: string; agentKind: string; visible: boolean; active: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>; focusRequest?: number;
  onTerminal: () => void; onEscape: () => void; onVisible: (visible: boolean) => void;
}) {
  const dashboardOpen = useDashboardViewStore(s => s.open);
  const [documentVisible, setDocumentVisible] = useState(!document.hidden);
  useEffect(() => {
    const changed = () => setDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  const live = visible && !dashboardOpen && documentVisible;
  const anchor = useRef<HTMLSpanElement>(null);
  const [surface, setSurface] = useState<Element | null>(null);
  const [surfaceTop, setSurfaceTop] = useState(0);
  useLayoutEffect(() => {
    setSurface(anchor.current?.closest("[data-agent-tab-surface]") ?? anchor.current?.parentElement ?? null);
    if (!live) return;
    const content = anchor.current?.closest<HTMLElement>("[data-agent-tab-content]");
    const measure = () => setSurfaceTop(content?.offsetTop ?? 0);
    measure();
    const observer = content && typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    if (content) observer?.observe(content);
    return () => observer?.disconnect();
  }, [live]);
  const workspaces = useWorkspaceListStore(s => s.workspaces);
  const metadata = usePaneMetadataStore(useShallow(s => ({
    metadataBySession: s.metadata, volatileMetadataBySession: s.volatileMetadata, lastLogBySession: s.lastLog, lastLogAtBySession: s.lastLogAt,
  })));
  const attention = useSessionAttentionStore(useShallow(s => ({
    attentionBySession: s.attentionBySession, statusSignalsBySession: s.statusSignalsBySession,
    dormantCompletionsBySession: s.dormantCompletionsBySession, seenAttentionByTab: s.seenAttentionByTab, doneMarkByTab: s.doneMarkByTab,
  })));
  const briefsBySession = useLiveBriefStore(s => s.briefsBySession);
  const observationsBySession = useLiveBriefStore(s => s.observationsBySession);
  const stallsBySession = useStallStore(s => s.entries);
  const cards = useMemo(() => live ? getAgentTabCards(workspaces, {
    ...metadata, ...attention, briefsBySession, observationsBySession, stallsBySession,
  }) : [], [live, workspaces, metadata, attention, briefsBySession, observationsBySession, stallsBySession]);
  const card = cards.find(candidate => candidate.tab.id === tabId && candidate.tab.sessionId === sessionId) ?? null;
  return <><span hidden ref={anchor} />{surface && live ? createPortal(<TerminalTranscriptPanel
    sessionId={sessionId} tabId={tabId} agentKind={agentKind} visible={visible} focusRequest={focusRequest} onClose={onTerminal}
    fullTab={{ card, cards, active, inputRef, onEscape, onVisible, top: surfaceTop }}
  />, surface) : null}</>;
}
