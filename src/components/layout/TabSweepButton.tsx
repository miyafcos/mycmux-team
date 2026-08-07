import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { usePaneMetadataStore, useWorkspaceListStore } from "../../stores/workspaceStore";
import {
  countUnseenSweepTabs,
  scanTabs,
  summarizeSweepReport,
  TAB_SWEEP_OPEN_EVENT,
  type SweepNoticeSummary,
  type SweepReport,
} from "./tabSweep";
import { TabSweepPanel } from "./TabSweepPanel";

const EMPTY_SUMMARY: SweepNoticeSummary = { dead: 0, candidates: 0, unnamed: 0, keys: [] };

export function TabSweepButton() {
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const terminalSessionIds = useMemo(() => workspaces.flatMap((workspace) =>
    workspace.panes.flatMap((pane) => pane.tabs
      .filter((tab) => tab.type === undefined || tab.type === "terminal")
      .map((tab) => tab.sessionId))), [workspaces]);
  const agentStatusFingerprint = usePaneMetadataStore((state) => terminalSessionIds
    .map((sessionId) => `${sessionId}:${state.metadata[sessionId]?.agentStatus ?? ""}`)
    .join("|"));
  const [open, setOpen] = useState(false);
  const openRef = useRef(false);
  const [summary, setSummary] = useState<SweepNoticeSummary>(EMPTY_SUMMARY);
  const [acknowledgedKeys, setAcknowledgedKeys] = useState<Set<string>>(() => new Set());
  const scanInFlightRef = useRef(false);
  const scanQueuedRef = useRef(false);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);

  const handleReport = useCallback((report: SweepReport) => {
    const next = summarizeSweepReport(report);
    setSummary(next);
    setAcknowledgedKeys((current) => {
      const activeKeys = new Set(next.keys);
      const retained = new Set([...current].filter((key) => activeKeys.has(key)));
      if (openRef.current) next.keys.forEach((key) => retained.add(key));
      return retained;
    });
  }, []);

  const refreshSummary = useCallback(async () => {
    if (openRef.current) return;
    if (scanInFlightRef.current) {
      scanQueuedRef.current = true;
      return;
    }
    scanInFlightRef.current = true;
    try {
      handleReport(await scanTabs());
    } catch {
      setSummary(EMPTY_SUMMARY);
    } finally {
      scanInFlightRef.current = false;
      if (scanQueuedRef.current) {
        scanQueuedRef.current = false;
        window.setTimeout(() => void refreshSummary(), 0);
      }
    }
  }, [handleReport]);

  const openPanel = useCallback(() => {
    openRef.current = true;
    setAcknowledgedKeys(new Set(summary.keys));
    setOpen(true);
  }, [summary.keys]);

  const closePanel = useCallback(() => {
    openRef.current = false;
    setOpen(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSummary(), 900);
    return () => window.clearTimeout(timer);
  }, [workspaces, agentStatusFingerprint, refreshSummary]);

  useEffect(() => {
    const timer = window.setInterval(() => void refreshSummary(), 60_000);
    return () => window.clearInterval(timer);
  }, [refreshSummary]);

  useEffect(() => {
    const handleOpen = () => openPanel();
    window.addEventListener(TAB_SWEEP_OPEN_EVENT, handleOpen);
    return () => window.removeEventListener(TAB_SWEEP_OPEN_EVENT, handleOpen);
  }, [openPanel]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    void Promise.all(terminalSessionIds.map((sessionId) =>
      listen(`pty-exit-${sessionId}`, () => {
        window.setTimeout(() => void refreshSummary(), 100);
      })
    )).then((registered) => {
      if (disposed) registered.forEach((unlisten) => unlisten());
      else unlisteners.push(...registered);
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [refreshSummary, terminalSessionIds]);

  const unseenCount = countUnseenSweepTabs(summary, acknowledgedKeys);
  const hasUnseenDead = summary.keys.some((key) => key.startsWith("dead:") && !acknowledgedKeys.has(key));
  const accessibleLabel = unseenCount > 0
    ? `タブ掃除、未確認 ${unseenCount} 件（即掃除 ${summary.dead}、判定候補 ${summary.candidates}、無名 ${summary.unnamed}）`
    : "タブ掃除";
  return (
    <div style={{ position: "relative", height: 24, display: "flex", alignItems: "center" }}>
      <button
        type="button"
        className="cmux-title-btn"
        title={accessibleLabel}
        aria-label={accessibleLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls="tab-sweep-panel"
        onClick={() => open ? closePanel() : openPanel()}
        style={{
          background: "none",
          border: "none",
          color: "var(--cmux-text-secondary)",
          cursor: "pointer",
          padding: "3px 6px",
          borderRadius: 3,
          display: "flex",
          alignItems: "center",
        }}
      >
        <span aria-hidden="true" style={{ fontSize: 13, lineHeight: 1 }}>🧹</span>
      </button>
      {unseenCount > 0 && (
        <span
          aria-hidden="true"
          style={{
            position: "absolute",
            top: -3,
            right: -3,
            minWidth: 13,
            height: 13,
            padding: "0 3px",
            boxSizing: "border-box",
            borderRadius: 999,
            background: hasUnseenDead ? "var(--cmux-red)" : "var(--cmux-accent)",
            color: "var(--cmux-on-error)",
            fontSize: 9,
            lineHeight: "13px",
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {unseenCount}
        </span>
      )}
      <TabSweepPanel
        open={open}
        visible={mounted}
        closing={closing}
        onClose={closePanel}
        onReportChange={handleReport}
      />
    </div>
  );
}
