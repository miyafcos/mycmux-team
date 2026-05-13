import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  useWorkspaceListStore,
  useWorkspaceLayoutStore,
  usePaneMetadataStore
} from "./stores/workspaceStore";
import { useWorkspacePersist, persistLoaded } from "./components/layout/SocketListener";
import {
  preloadTerminalConfig,
  onPtyMetadata,
  onPtyWorkDone,
  isDirectory,
  writeToSession,
  getLaunchCwd,
  revealMainWindow,
  readAgentSessionMappings,
} from "./lib/ipc";
import { useUiStore } from "./stores/uiStore";
import { isShellProcess } from "./lib/notificationStatus";
import type { AgentSessionKind, Pane, PaneTab } from "./types";
import {
  STARTUP_RESTORE_COMPLETE_EVENT,
  getStartupSessionGateSnapshot,
  prepareStartupSessionGate,
  waitForStartupSessionGate,
} from "./lib/startupSessionGate";
import AppShell from "./components/layout/AppShell";
import ErrorBoundary from "./components/common/ErrorBoundary";
import { initDefaultShell } from "./lib/agents";

// Kick off config fetch immediately — will be cached by the time terminals mount
preloadTerminalConfig();

// Prevent unhandled promise rejections from crashing the app
window.addEventListener("unhandledrejection", (e) => {
  console.warn("[mycmux] unhandled rejection:", e.reason);
  e.preventDefault();
});

function inferAgentKindFromProcessTitle(processTitle?: string): AgentSessionKind | null {
  const lowerTitle = processTitle?.toLowerCase() ?? "";
  if (lowerTitle.includes("claude-codex")) return "claude-codex";
  if (lowerTitle.includes("claude")) return "claude";
  if (lowerTitle.includes("codex")) return "codex";
  return null;
}

function inferAgentKindFromTab(sessionId: string): AgentSessionKind | null {
  const { workspaces } = useWorkspaceListStore.getState();
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      for (const tab of pane.tabs) {
        if (tab.sessionId !== sessionId) continue;
        if (tab.agentKind) return tab.agentKind;
        if (tab.agentId === "claude-code") return "claude";
        if (tab.agentId === "codex") return "codex";
        if (tab.agentId === "claude-codex") return "claude-codex";
      }
    }
  }
  return null;
}

function tabHasRestorableAgentSession(tab: PaneTab): boolean {
  return Boolean((tab.agentKind && tab.agentSessionId) || tab.claudeSessionId);
}

function paneHasRestorableAgentSession(pane: Pane): boolean {
  return Boolean(
    (pane.agentKind && pane.agentSessionId)
    || pane.claudeSessionId
    || pane.tabs.some(tabHasRestorableAgentSession),
  );
}

async function applyAgentSessionMappings(): Promise<void> {
  const mappings = await readAgentSessionMappings();
  for (const [sessionId, mapping] of Object.entries(mappings)) {
    const current = usePaneMetadataStore.getState().metadata[sessionId];
    if (current?.processIsShell) {
      continue;
    }
    const processKind = inferAgentKindFromProcessTitle(current?.processTitle);
    const tabKind = inferAgentKindFromTab(sessionId);
    const kind = mapping.agent_kind ?? processKind ?? tabKind;
    if (!kind) {
      continue;
    }
    if (!processKind && tabKind && tabKind !== kind) {
      continue;
    }
    usePaneMetadataStore.getState().setMetadata(sessionId, {
      agentKind: kind,
      agentSessionId: mapping.session_id,
      claudeSessionId: kind === "claude" ? mapping.session_id : current?.claudeSessionId,
    });
    // Also push into workspaceListStore so the next persistence snapshot
    // captures the live mapping (paneMetadataStore alone is not read by
    // toConfig fallback chain at the lowest priority — covered, but mirroring
    // here lets restore-on-restart hit the highest-precedence Pane.* fields).
    useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(sessionId, {
      claudeSessionId: kind === "claude"
        ? mapping.session_id
        : (current?.claudeSessionId ?? undefined),
      agentKind: kind,
      agentSessionId: mapping.session_id,
    });
  }
}

function App() {
  const [ready, setReady] = useState(false);
  const [startupMaskVisible, setStartupMaskVisible] = useState(true);
  const uiVariant = import.meta.env.VITE_UI_VARIANT === "cmux" ? "cmux" : "default";

  useWorkspacePersist();

  useEffect(() => {
    async function bootstrap() {
      await Promise.all([persistLoaded, initDefaultShell()]);
      const listStore = useWorkspaceListStore.getState();
      let launchCwd: string | null = null;
      try {
        launchCwd = await getLaunchCwd();
      } catch { /* ignore */ }

      if (listStore.workspaces.length === 0) {
        if (launchCwd) {
          const workspaceId = crypto.randomUUID();
          const { panes, splitColumns } = useWorkspaceLayoutStore.getState().buildInitialPanes(workspaceId, "1x1");

          for (const pane of panes) {
            pane.cwd = launchCwd;
            for (const tab of pane.tabs) {
              tab.cwd = launchCwd;
            }
          }

          listStore.createWorkspace("Terminal", "1x1", panes, splitColumns, {
            id: workspaceId,
          });
        }
      }

      const currentListState = useWorkspaceListStore.getState();
      const activeWorkspaceId = currentListState.activeWorkspaceId
        ?? currentListState.workspaces[0]?.id
        ?? null;
      const startupSessionIds = currentListState.workspaces.flatMap((workspace) => {
        const shouldGateWorkspace = workspace.id === activeWorkspaceId
          || workspace.panes.some(paneHasRestorableAgentSession);
        if (!shouldGateWorkspace) return [];
        return workspace.panes.flatMap((pane) => {
            const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId) ?? pane.tabs[0];
            return [activeTab.sessionId];
          });
      });
      prepareStartupSessionGate(startupSessionIds);
      setStartupMaskVisible(true);

      setReady(true);
    }
    bootstrap();

    // PTY metadata listener — also computes processIsShell which drives the
    // authoritative "working" indicator (blue dot). Rust sysinfo polls every
    // 3 seconds so this is a deterministic, non-flickering signal.
    //
    // Mirrors agent session metadata into BOTH paneMetadataStore (live UI) AND
    // workspaceListStore (persisted via toConfig). Without the latter mirror,
    // toConfig only sees stale Pane.claudeSessionId and saves null, which is
    // why session restore was broken before v0.6.1.
    const unlistenMeta = onPtyMetadata((meta) => {
      const processIsShell = isShellProcess(meta.process_name ?? undefined);
      if (processIsShell) {
        usePaneMetadataStore.getState().clearAgentSessionId(meta.session_id);
        usePaneMetadataStore.getState().clearClaudeSessionId(meta.session_id);
        // Also clear the persisted Pane/Tab fields so the next save doesn't
        // ressurect a stale agent session for a pane that's now back in shell.
        useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(meta.session_id, null);
      }
      usePaneMetadataStore.getState().setMetadata(meta.session_id, {
        cwd: meta.cwd,
        gitBranch: meta.git_branch,
        processTitle: meta.process_name ?? undefined,
        processIsShell,
        claudeSessionId: processIsShell ? undefined : meta.claude_session_id ?? undefined,
        agentKind: processIsShell ? undefined : meta.agent_kind ?? undefined,
        agentSessionId: processIsShell ? undefined : meta.agent_session_id ?? undefined,
      });
      // Mirror live session metadata into workspaceListStore only on truthy
      // values. Launcher (crsm/shell-starter) reports no claude/agent session,
      // so this `if` naturally skips and we don't accidentally clear a session
      // that the user is still mid-using on a tab swap.
      if (!processIsShell && (meta.claude_session_id || meta.agent_session_id)) {
        useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(meta.session_id, {
          claudeSessionId: meta.claude_session_id ?? undefined,
          agentKind: (meta.agent_kind as AgentSessionKind | undefined) ?? undefined,
          agentSessionId: meta.agent_session_id ?? undefined,
        });
      }
    });

    // Work-done listener: backend detects a foreground process transition
    // from a working process (claude/node/python/…) back to a shell and
    // emits this event. Badge the pane unless it's currently focused.
    const unlistenWorkDone = onPtyWorkDone((evt) => {
      const prevProcess = evt.prev_process.toLowerCase();
      // Agent -> shell transition = intentional exit, not a restart restore target.
      if (prevProcess.includes("claude") || prevProcess.includes("codex")) {
        usePaneMetadataStore.getState().clearAgentSessionId(evt.session_id);
      }
      if (prevProcess.includes("claude")) {
        usePaneMetadataStore.getState().clearClaudeSessionId(evt.session_id);
      }
      const activePaneId = useUiStore.getState().activePaneId;
      if (activePaneId === evt.session_id) return;
      usePaneMetadataStore.getState().notifyWorkDone(evt.session_id);
    });

    // Drag-and-drop: route folder drops to the correct terminal pane
    const unlistenDragDrop = getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      const { paths, position } = event.payload;
      if (!paths || paths.length === 0) return;

      // Convert physical pixels to CSS pixels
      const scale = window.devicePixelRatio || 1;
      const cssX = position.x / scale;
      const cssY = position.y / scale;

      // Find the terminal pane under the drop position
      const el = document.elementFromPoint(cssX, cssY);
      const paneEl = el?.closest("[data-session-id]");
      if (!paneEl) return;
      const sessionId = paneEl.getAttribute("data-session-id");
      if (!sessionId) return;

      if (paths.length === 1) {
        try {
          const isDir = await isDirectory(paths[0]);
          if (isDir) {
            // Normalize backslashes for Git Bash compatibility
            const normalized = paths[0].replace(/\\/g, "/");
            await writeToSession(sessionId, `cd "${normalized}"\r`);
            return;
          }
        } catch { /* fall through to paste */ }
      }

      // Paste file paths as quoted strings
      const quoted = paths
        .map((p) => `"${p.replace(/\\/g, "/")}"`)
        .join(" ");
      await writeToSession(sessionId, quoted + " ");
    });

    const refreshAgentSessionMappings = (): void => {
      void applyAgentSessionMappings().catch((error) => {
        console.warn("[sessions] Failed to read agent session mappings:", error);
      });
    };
    refreshAgentSessionMappings();
    window.addEventListener(STARTUP_RESTORE_COMPLETE_EVENT, refreshAgentSessionMappings);
    const mappingFallbackTimer = window.setTimeout(refreshAgentSessionMappings, 15000);

    return () => {
      unlistenMeta.then((f) => f()).catch(() => {});
      unlistenWorkDone.then((f) => f()).catch(() => {});
      unlistenDragDrop.then((f) => f()).catch(() => {});
      window.removeEventListener(STARTUP_RESTORE_COMPLETE_EVENT, refreshAgentSessionMappings);
      window.clearTimeout(mappingFallbackTimer);
    };
  }, []);

  useEffect(() => {
    if (!ready) return;

    let cancelled = false;
    let rafA = 0;
    let rafB = 0;

    const revealWindow = (): void => {
      rafA = requestAnimationFrame(() => {
        rafB = requestAnimationFrame(async () => {
          if (cancelled) return;
          try {
            const { expected } = getStartupSessionGateSnapshot();
            const startupTimeoutMs = Math.min(12000, Math.max(1800, 700 + expected * 350));
            const gateResult = await waitForStartupSessionGate(startupTimeoutMs);
            if (gateResult.timedOut) {
              console.warn(`[startup] reveal timeout with ${gateResult.pending} sessions still pending`);
            }
            if (cancelled) return;
            await revealMainWindow();
            await new Promise((resolve) => window.setTimeout(resolve, gateResult.timedOut ? 250 : 160));
            if (cancelled) return;
            setStartupMaskVisible(false);
          } catch (error) {
            console.error(error);
            setStartupMaskVisible(false);
          }
        });
      });
    };

    revealWindow();

    return () => {
      cancelled = true;
      if (rafA) cancelAnimationFrame(rafA);
      if (rafB) cancelAnimationFrame(rafB);
    };
  }, [ready]);

  if (!ready) {
    return (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          background: "#0a0a0a",
        }}
      />
    );
  }

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "#0a0a0a" }}>
      <ErrorBoundary>
        <AppShell uiVariant={uiVariant} />
      </ErrorBoundary>
      {startupMaskVisible && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "#0a0a0a",
            zIndex: 9999,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}

export default App;
