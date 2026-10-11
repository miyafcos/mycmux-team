import { useEffect, useRef, useState, type RefObject } from "react";
import type { Terminal, IMarker } from "@xterm/xterm";
import { useSettingsStore } from "../../stores/settingsStore";
import { usePaneMetadataStore } from "../../stores/paneMetadataStore";
import { useSessionAttentionStore } from "../../stores/sessionAttentionStore";
import { connectLiveBriefStore, useLiveBriefStore } from "../../stores/liveBriefStore";
import { useDashboardViewStore } from "../../stores/dashboardViewStore";
import { useUiStore } from "../../stores/uiStore";
import { TranscriptHistoryReader, descriptorKey } from "../../stores/transcriptHistoryStore";
import { useArchiveDescriptor } from "../dashboard/useTranscriptHistory";
import { ConversationHistoryArbiter, explicitHistorySafe, type HistorySafety } from "./conversationHistoryAdmission";

export function useTerminalArchiveEntry(sessionId: string, tabId: string | null, container: RefObject<HTMLDivElement | null>, term: RefObject<Terminal | null>, panelOpen: boolean, openAccepted: () => boolean, paneVisible = true) {
  const dashboardOpen = useDashboardViewStore(s => s.open);
  const mode = useSettingsStore((s) => s.conversationHistoryMode);
  const liveKind = usePaneMetadataStore((s) => s.volatileMetadata[sessionId]?.liveAgentKind);
  const alive = usePaneMetadataStore((s) => s.volatileMetadata[sessionId]?.ptyAlive);
  const [visible, setVisible] = useState(false);
  const descriptor = useArchiveDescriptor(sessionId, tabId, visible && mode !== "legacy");
  const [prepared, setPrepared] = useState<TranscriptHistoryReader | null>(null);
  const preparedRef = useRef<TranscriptHistoryReader | null>(null);
  const arbiter = useRef(new ConversationHistoryArbiter());
  const current = useRef({ descriptor, visible, mode, panelOpen }); current.current = { descriptor, visible, mode, panelOpen };
  const saved = useRef<{ term: Terminal; type: string; marker: IMarker | null } | null>(null);
  const visibilityContext=useRef({paneVisible,dashboardOpen});visibilityContext.current={paneVisible,dashboardOpen};
  const refreshVisibility=useRef<()=>void>(()=>{});
  useEffect(() => {
    const node = container.current; if (!node) return;
    let stopped=false;
    const refresh = () => {
      if(stopped)return;
      const {paneVisible,dashboardOpen}=visibilityContext.current;
      let painted = paneVisible && !dashboardOpen && !document.hidden && node.isConnected && node.clientWidth > 0 && node.clientHeight > 0;
      for (let parent:HTMLElement|null = node; painted && parent; parent=parent.parentElement) {
        const style=window.getComputedStyle(parent); if(style.display==="none" || style.visibility==="hidden" || style.visibility==="collapse") painted=false;
      }
      setVisible(painted);
    };
    refreshVisibility.current=refresh;refresh(); const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(refresh) : null; observer?.observe(node);
    document.addEventListener("visibilitychange", refresh); window.addEventListener("mycmux:workspace-visibility-change", refresh);
    return () => { stopped=true;refreshVisibility.current=()=>{};observer?.disconnect(); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("mycmux:workspace-visibility-change", refresh); };
  }, [sessionId, container]);
  useEffect(()=>refreshVisibility.current(),[paneVisible,dashboardOpen]);
  useEffect(() => {
    if (visible && (mode === "boundary" || mode === "agent-wheel") && alive && (liveKind === "claude" || liveKind === "claude-codex" || liveKind === "codex")) return connectLiveBriefStore([sessionId]);
  }, [sessionId, visible, mode, alive, liveKind]);
  useEffect(() => {
    const old = preparedRef.current;
    if (panelOpen && mode !== "legacy") { old?.setVisible(visible); if (old && visible && descriptor && descriptorKey(old.snapshot.descriptor) !== descriptorKey(descriptor)) old.freeze(); return; }
    const automatic = mode === "boundary" || mode === "agent-wheel";
    const currentAgent = !!descriptor && alive && liveKind === descriptor.expectedAgentKind;
    if (!visible || mode === "legacy" || !descriptor || automatic && !currentAgent) { old?.dispose(); preparedRef.current = null; setPrepared(null); return; }
    if (old && descriptorKey(old.snapshot.descriptor) === descriptorKey(descriptor) && old.snapshot.status !== "closed") { old.setVisible(true); return; }
    old?.dispose(); const next = new TranscriptHistoryReader(descriptor); preparedRef.current = next; setPrepared(next);
  }, [descriptor, visible, mode, panelOpen, liveKind, alive]);
  useEffect(() => () => { preparedRef.current?.dispose(); saved.current?.marker?.dispose(); saved.current = null; }, [sessionId]);
  const capture = () => {
    const t = term.current; if (!t || saved.current) return; const b = t.buffer.active;
    const marker = b.type === "normal" ? t.registerMarker(b.viewportY - b.baseY - b.cursorY) ?? null : null;
    saved.current = { term: t, type: b.type, marker };
  };
  useEffect(() => { if (panelOpen) capture(); }, [panelOpen]);
  const safety = (t: Terminal, interaction: { composing: boolean; dragging: boolean }, overlay: boolean): HistorySafety => {
    const c = current.current, p = preparedRef.current, volatile = usePaneMetadataStore.getState().volatileMetadata[sessionId];
    const attention = useSessionAttentionStore.getState(); const selection = window.getSelection();
    const ready = !!p && p.snapshot.status === "ready" && !!p.snapshot.readerId && !!p.snapshot.sourceGeneration && (!!p.snapshot.newerCursor || p.snapshot.items.length > 0) && !!c.descriptor && descriptorKey(p.snapshot.descriptor) === descriptorKey(c.descriptor);
    const node = container.current;
    return { active: useUiStore.getState().activePaneId === sessionId, visible: c.visible && !document.hidden && !!node && node.clientWidth > 0 && node.clientHeight > 0, disposed: term.current !== t, composing: interaction.composing, selecting: t.hasSelection() || !!selection && !selection.isCollapsed, dragging: interaction.dragging, overlay: overlay || c.panelOpen, liveAgentKind: volatile?.liveAgentKind, ptyAlive: volatile?.ptyAlive, descriptor: c.descriptor, ready, attention: attention.attentionBySession[sessionId], signals: attention.statusSignalsBySession[sessionId], brief: useLiveBriefStore.getState().briefsBySession[sessionId], observation: useLiveBriefStore.getState().observationsBySession[sessionId], now: Date.now() };
  };
  const accept = () => { capture(); return openAccepted(); };
  const wheel = (event: WheelEvent, t: Terminal, interaction: { composing: boolean; dragging: boolean }, overlay: boolean) => arbiter.current.wheel(event, current.current.mode, t.buffer.active, safety(t, interaction, overlay), accept);
  const boundary = (t: Terminal, interaction: { composing: boolean; dragging: boolean }, overlay: boolean) => arbiter.current.boundary(current.current.mode, t.buffer.active, safety(t, interaction, overlay), accept);
  const explicit = (t: Terminal, interaction: { composing: boolean; dragging: boolean }, overlay: boolean) => current.current.mode !== "legacy" && explicitHistorySafe(safety(t, interaction, overlay)) && accept();
  const close = (): boolean => {
    arbiter.current.noteClose(); const s = saved.current; saved.current = null; if (!s) return true;
    const t = term.current; let restored = true;
    if (t === s.term && t.buffer.active.type === s.type) {
      if (s.type === "normal" && s.marker && !s.marker.isDisposed) t.scrollToLine(s.marker.line);
      else if (s.type === "normal") restored = false;
    } else restored = false;
    s.marker?.dispose(); return restored;
  };
  return { reader: prepared ?? undefined, wheel, boundary, explicit, close };
}
