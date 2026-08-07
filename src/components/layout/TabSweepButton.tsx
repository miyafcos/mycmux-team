import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useState } from "react";
import { OVERLAY_EXIT_MS, useDeferredUnmount } from "../../hooks/useDeferredUnmount";
import { usePaneMetadataStore, useWorkspaceListStore } from "../../stores/workspaceStore";
import { countDeadTabs } from "./tabSweep";
import { TabSweepPanel } from "./TabSweepPanel";

export function TabSweepButton() {
  const workspaces = useWorkspaceListStore((state) => state.workspaces);
  const metadata = usePaneMetadataStore((state) => state.metadata);
  const [open, setOpen] = useState(false);
  const [deadCount, setDeadCount] = useState(0);
  const { mounted, closing } = useDeferredUnmount(open, OVERLAY_EXIT_MS);
  const refreshDeadCount = useCallback(() => {
    void countDeadTabs()
      .then(setDeadCount)
      .catch(() => setDeadCount(0));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(refreshDeadCount, 150);
    return () => window.clearTimeout(timer);
  }, [workspaces, metadata, refreshDeadCount]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];
    const terminalSessionIds = workspaces.flatMap((workspace) =>
      workspace.panes.flatMap((pane) =>
        pane.tabs
          .filter((tab) => tab.type === undefined || tab.type === "terminal")
          .map((tab) => tab.sessionId)
      )
    );
    void Promise.all(terminalSessionIds.map((sessionId) =>
      listen(`pty-exit-${sessionId}`, () => {
        window.setTimeout(refreshDeadCount, 100);
      })
    )).then((registered) => {
      if (disposed) registered.forEach((unlisten) => unlisten());
      else unlisteners.push(...registered);
    }).catch(() => {});
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [workspaces, refreshDeadCount]);

  const accessibleLabel = deadCount > 0
    ? `タブ掃除、即掃除 ${deadCount} 件`
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
        onClick={() => setOpen((value) => !value)}
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
      {deadCount > 0 && (
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
            background: "var(--cmux-red)",
            color: "var(--cmux-on-error)",
            fontSize: 9,
            lineHeight: "13px",
            textAlign: "center",
            pointerEvents: "none",
          }}
        >
          {deadCount}
        </span>
      )}
      {mounted && (
        <TabSweepPanel
          closing={closing}
          onClose={() => setOpen(false)}
          onDeadCountChange={setDeadCount}
        />
      )}
    </div>
  );
}
