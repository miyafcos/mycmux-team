import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { TEAR_OUT_DRAG_THRESHOLD_PX } from "../../lib/tearOutDiagnostics";
import {
  DETACHED_DRAG_EVENT,
  WINDOW_DRAG_EVENT,
  type DetachedDragPayload,
  type WindowDragSample,
} from "../../stores/detachedDockStore";
import XTermWrapper, { evictTerminalCache } from "../terminal/XTermWrapper";
import LauncherPane from "../workspace/LauncherPane";
import BrowserPane from "../workspace/BrowserPane";
import WebPaneController from "../workspace/WebPaneController";
import WebPaneStatusBar from "../workspace/WebPaneStatusBar";
import { useWorkspaceLayoutStore } from "../../stores/workspaceLayoutStore";
import { buildLaunchArgs } from "../workspace/TerminalPane";
import { buildThemeVars } from "./AppShell";
import { discardWindowWorkspacesAndClose } from "./SocketListener";
import { useThemeStore } from "../../stores/themeStore";
import { useUiStore } from "../../stores/uiStore";
import { usePaneMetadataStore } from "../../stores/workspaceStore";
import { getAgent, getDefaultAgent } from "../../lib/agents";
import { killSession, type SaveEditableArtifactResult } from "../../lib/ipc";
import { requiresLauncherDispatch } from "../../lib/launcherDispatch";
import { focusController } from "../../lib/focusController";
import { beforePaneClose } from "../../lib/paneCloseLifecycle";
import { confirmPaneClose } from "../../lib/paneCloseConfirmation";
import { isRestorableTab, tabHasPty } from "../../lib/tabLifecycle";
import type { DetachedWorkspace } from "../../lib/detachedPane";

/** The child uses App's persistence/show lifecycle, with only one pane on screen. */
export default function DetachedPaneShell({ workspace }: { workspace: DetachedWorkspace }) {
  const bandRef = useRef<HTMLDivElement>(null);
  const themeState = useThemeStore();
  const activeSessionId = useUiStore((state) => state.activePaneId);
  const [error, setError] = useState<string | null>(null);
  const pane = workspace.panes[0];
  const tab = pane.tabs.find((candidate) => candidate.id === pane.activeTabId) ?? pane.tabs[0];
  const title = tab.label || pane.label || workspace.name;
  const setBrowserTabDirty = useWorkspaceLayoutStore((state) => state.setBrowserTabDirty);
  const refreshBrowserTabPreview = useWorkspaceLayoutStore((state) => state.refreshBrowserTabPreview);
  const handleBrowserDirtyChange = useCallback((isDirty: boolean) => {
    setBrowserTabDirty(workspace.id, pane.id, tab.id, isDirty);
  }, [workspace.id, pane.id, tab.id, setBrowserTabDirty]);
  const handleBrowserSaved = useCallback((result: SaveEditableArtifactResult) => {
    refreshBrowserTabPreview(workspace.id, pane.id, tab.id, {
      previewPath: result.previewPath,
      sourcePath: result.sourcePath,
      sourceKind: tab.sourceKind ?? "html",
    });
  }, [workspace.id, pane.id, tab.id, tab.sourceKind, refreshBrowserTabPreview]);

  const launch = useMemo(() => {
    const launchThroughLauncher = !tab.commandArgv?.length
      && requiresLauncherDispatch(tab.launchEnv ?? pane.launchEnv);
    const agent = launchThroughLauncher ? getDefaultAgent() : getAgent(tab.agentId) ?? getDefaultAgent();
    const savedSession = tab.agentKind && tab.agentSessionId
      ? { kind: tab.agentKind, sessionId: tab.agentSessionId }
      : tab.claudeSessionId ? { kind: "claude" as const, sessionId: tab.claudeSessionId } : null;
    const args = tab.commandArgv?.length ? tab.commandArgv.slice(1) : buildLaunchArgs(
      agent.command, agent.args, tab.agentId, savedSession, tab.id, tab.cwd ?? pane.cwd, tab.initialPrompt,
    );
    const launchEnv: Record<string, string> = {
      ...(tab.launchEnv ?? pane.launchEnv),
      MYCMUX_PANE_SESSION_ID: tab.sessionId,
      MYCMUX_TAB_ID: tab.id,
    };
    if (launchThroughLauncher || tab.agentId === "shell-starter") launchEnv.__CMUX_LAUNCHER_DONE = "1";
    if (savedSession && !launchEnv.MYCMUX_HANDOFF) {
      launchEnv.MYCMUX_AGENT_KIND = savedSession.kind;
      launchEnv.MYCMUX_SESSION_ID = savedSession.sessionId;
      launchEnv.MYCMUX_RESUME = savedSession.kind;
    } else if (tab.agentId === "claude-code") {
      launchEnv.MYCMUX_AGENT_KIND = "claude";
    }
    return { agent, savedSession, args, launchEnv };
  }, [pane.cwd, pane.launchEnv, tab]);

  const themeVars = useMemo(() => buildThemeVars({
    ...themeState,
    background: themeState.themeTweaks.background,
    mediaActive: false,
  }), [themeState]);

  // The OS window is undecorated, so its taskbar entry is the only place the
  // pane can still name itself.
  useEffect(() => {
    document.title = title;
    void getCurrentWindow().setTitle(title).catch(() => { /* title is cosmetic */ });
  }, [title]);

  // Opening a window to type in it and having to click first is a papercut.
  useEffect(() => {
    focusController.request("programmatic", { sessionId: tab.sessionId, focus: true });
  }, [tab.sessionId]);

  useEffect(() => {
    const band = bandRef.current!;
    const child = getCurrentWindow();
    type Point = { x: number; y: number };
    let dragging = false;
    let unlisten: UnlistenFn | undefined;
    let events = Promise.resolve();
    const broadcast = (phase: DetachedDragPayload["phase"], point: Point) => {
      const payload: DetachedDragPayload = { label: child.label, workspaceId: workspace.id,
        sessionId: tab.sessionId, tabId: tab.id, screenX: point.x, screenY: point.y, phase };
      events = events.then(() => emit(DETACHED_DRAG_EVENT, payload))
        .catch((reason) => setError(String(reason)));
    };

    /*
     * Windows moves the window itself, so its edge snap is the real one - no
     * imitation matches it, and a hand-rolled version read as wrong however
     * closely it was tuned (2026-09-16). The cost is that no pointer events
     * reach this page for the rest of the drag, so the backend polls the cursor
     * and sends it back. Chromium does exactly this for a torn-out tab.
     *
     * Where that poll is unavailable (macOS, until Core Graphics is a
     * dependency) the window is moved from pointer events as before: no OS
     * snap, but dropping it back into the main window still works.
     */
    let manual: { pointerId: number; start: Point; latest: Point; origin?: Point; offset?: Point } | null = null;
    let frame: number | null = null;
    let moves = Promise.resolve();
    const position = (point: Point) => {
      moves = moves.then(() => child.setPosition(new LogicalPosition(point.x, point.y)))
        .catch((reason) => setError(String(reason)));
    };
    const flushManual = () => {
      frame = null;
      if (!manual?.offset) return;
      position({ x: manual.latest.x - manual.offset.x, y: manual.latest.y - manual.offset.y });
      broadcast("move", manual.latest);
    };
    const finishManual = (cancel: boolean) => {
      if (!manual) return;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (cancel && manual.origin) position(manual.origin);
      broadcast(cancel ? "cancel" : "end", manual.latest);
      const pointerId = manual.pointerId;
      manual = null;
      dragging = false;
      try {
        if (band.hasPointerCapture(pointerId)) band.releasePointerCapture(pointerId);
      } catch {
        // Capture can already be gone when the pointer left with the window.
      }
    };
    const beginManual = (event: PointerEvent) => {
      const current = { pointerId: event.pointerId,
        start: { x: event.screenX, y: event.screenY }, latest: { x: event.screenX, y: event.screenY } };
      manual = current;
      try {
        band.setPointerCapture(event.pointerId);
      } catch {
        // Non-critical; the window follows the cursor, so the band keeps
        // receiving the move stream even without capture.
      }
      void Promise.all([child.outerPosition(), child.scaleFactor()]).then(([outer, scale]) => {
        if (manual !== current) return;
        manual.origin = { x: outer.x / scale, y: outer.y / scale };
        manual.offset = { x: current.start.x - manual.origin.x, y: current.start.y - manual.origin.y };
        if (frame === null) frame = requestAnimationFrame(flushManual);
      }).catch((reason) => { if (manual === current) finishManual(true); setError(String(reason)); });
    };

    const stopWatching = () => {
      unlisten?.();
      unlisten = undefined;
      dragging = false;
    };
    const down = (event: PointerEvent) => {
      if (dragging || event.button !== 0 || (event.target as Element).closest("button")) return;
      event.preventDefault();
      dragging = true;
      const start = { x: event.screenX, y: event.screenY };
      broadcast("start", start);
      void listen<WindowDragSample>(WINDOW_DRAG_EVENT, ({ payload }) => {
        if (!dragging || manual) return;
        if (payload.done) {
          // A click on the band is not a drag. Without this floor, pressing the
          // header while the window happens to overlap the main one docks it
          // instantly, because the button comes up before anything has moved.
          const moved = Math.hypot(payload.x - start.x, payload.y - start.y);
          broadcast(moved >= TEAR_OUT_DRAG_THRESHOLD_PX ? "end" : "cancel",
            { x: payload.x, y: payload.y });
          stopWatching();
          return;
        }
        broadcast("move", { x: payload.x, y: payload.y });
      }).then((off) => {
        if (dragging) unlisten = off;
        else off();
      }).catch((reason) => setError(String(reason)));
      // Start the poll before the move loop: once the OS owns the drag this
      // page stops being scheduled reliably, and a command issued then can sit
      // unsent until the button comes up.
      void invoke<boolean>("watch_window_drag")
        .then((tracked) => {
          if (!dragging) return;
          if (!tracked) {
            stopWatching();
            dragging = true;
            beginManual(event);
            return;
          }
          return child.startDragging();
        })
        .catch((reason) => {
          broadcast("cancel", start);
          stopWatching();
          setError(String(reason));
        });
    };
    const move = (event: PointerEvent) => {
      if (manual?.pointerId !== event.pointerId) return;
      manual.latest = { x: event.screenX, y: event.screenY };
      if (frame === null) frame = requestAnimationFrame(flushManual);
    };
    const up = (event: PointerEvent) => {
      if (manual?.pointerId !== event.pointerId) return;
      manual.latest = { x: event.screenX, y: event.screenY };
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      if (manual.offset) position({ x: manual.latest.x - manual.offset.x, y: manual.latest.y - manual.offset.y });
      finishManual(false);
    };
    const cancel = (event: PointerEvent) => {
      if (manual?.pointerId === event.pointerId) finishManual(true);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && manual) { event.preventDefault(); finishManual(true); }
    };
    band.addEventListener("pointerdown", down);
    band.addEventListener("pointermove", move);
    band.addEventListener("pointerup", up);
    band.addEventListener("pointercancel", cancel);
    band.addEventListener("lostpointercapture", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      if (manual) finishManual(true);
      else if (dragging) broadcast("cancel", { x: 0, y: 0 });
      stopWatching();
      band.removeEventListener("pointerdown", down);
      band.removeEventListener("pointermove", move);
      band.removeEventListener("pointerup", up);
      band.removeEventListener("pointercancel", cancel);
      band.removeEventListener("lostpointercapture", cancel);
      window.removeEventListener("keydown", escape);
    };
  }, [workspace.id, tab.id, tab.sessionId]);

  // × closes the pane, the way it does in the main window's tab strip — the way
  // back is to drag the window onto a tab strip. Closing the window itself
  // (Alt+F4, the taskbar) still hands the pane to main: an OS close means "put
  // this window away", not "end what is running in it".
  const closePane = async () => {
    if (!await confirmPaneClose([pane], "pane")) return;
    try {
      beforePaneClose(pane);
      for (const candidate of pane.tabs) {
        if (!tabHasPty(candidate)) continue;
        evictTerminalCache(candidate.sessionId);
        void killSession(candidate.sessionId).catch((reason) =>
          console.warn("[mycmux] killSession failed", candidate.sessionId, reason));
        usePaneMetadataStore.getState().removeMetadata(candidate.sessionId);
      }
      await discardWindowWorkspacesAndClose();
    } catch (reason) {
      setError(String(reason));
    }
  };

  return (
    <div data-detached-pane-shell="true" data-cmux-themed-root="true" style={{
      ...themeVars, width: "100vw", height: "100vh", display: "flex", flexDirection: "column",
      overflow: "hidden", background: "var(--cmux-bg-solid)", color: "var(--cmux-text)",
    }}>
      <div ref={bandRef} style={{
        height: 30, flex: "0 0 30px", display: "flex", alignItems: "center", gap: 8,
        padding: "0 6px 0 10px", background: "var(--cmux-surface)", userSelect: "none",
        borderBottom: "1px solid var(--cmux-border-hairline)", cursor: "default", touchAction: "none",
      }}>
        <span title={title} style={{
          flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          fontSize: 12, color: "var(--cmux-text-secondary)", pointerEvents: "none",
        }}>
          {title}
        </span>
        <button
          type="button"
          onClick={() => { void closePane(); }}
          aria-label="このペインを閉じる"
          title="このペインを閉じます（元の窓へ戻すには、この帯を掴んでタブのつまみ列へ）"
          style={{
            height: 22, width: 22, display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 13, lineHeight: 1, color: "var(--cmux-text-secondary)", background: "transparent",
            border: "none", borderRadius: "var(--cmux-radius-sm)", cursor: "pointer",
          }}
          onPointerEnter={(event) => { event.currentTarget.style.background = "var(--cmux-hover)"; }}
          onPointerLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
        >
          ×
        </button>
      </div>
      {error && <div role="alert" style={{ padding: "4px 10px", fontSize: 12, color: "var(--cmux-red)" }}>{error}</div>}
      <div data-session-id={tab.sessionId} style={{ flex: 1, minHeight: 0, position: "relative" }}
        onPointerDown={() => focusController.request("pointer", { sessionId: tab.sessionId, focus: true })}>
        {tab.type === "browser" && tab.htmlPath ? (
          <BrowserPane htmlPath={tab.htmlPath} sourcePath={tab.sourcePath} sourceKind={tab.sourceKind}
            previewPath={tab.previewPath ?? tab.htmlPath} reloadKey={tab.reloadCounter ?? 0}
            isDirty={tab.isDirty ?? false} onDirtyChange={handleBrowserDirtyChange} onSaved={handleBrowserSaved} />
        ) : tab.type === "web" ? (
          <div data-web-pane-content="true"
            style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <WebPaneController />
            <WebPaneStatusBar tabId={tab.id} presetId={tab.presetId ?? ""} />
            <div data-web-pane-host-tab-id={tab.id} data-web-pane-preset-id={tab.presetId}
              style={{ flex: 1, minHeight: 0 }} />
          </div>
        ) : tab.type === "launcher" ? (
          <LauncherPane workspaceId={workspace.id} paneId={pane.id} tabId={tab.id}
            sessionId={tab.sessionId} isActive={activeSessionId === tab.sessionId} cwd={tab.cwd ?? pane.cwd} />
        ) : tab.type !== "browser" && isRestorableTab(tab) ? (
          <XTermWrapper key={tab.sessionId} workspaceId={workspace.id} sessionId={tab.sessionId}
            command={tab.commandArgv?.[0] ?? launch.agent.command} args={launch.args} agentId={tab.agentId}
            agentKind={launch.savedSession?.kind ?? tab.agentKind} cwd={tab.cwd ?? pane.cwd}
            initialReplay={tab.terminalSnapshot} launchEnv={launch.launchEnv} />
        ) : <div style={{ padding: 12, fontSize: 12 }}>まだ起動していません</div>}
      </div>
    </div>
  );
}
