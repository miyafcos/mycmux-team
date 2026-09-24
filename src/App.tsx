import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import {
  useWorkspaceListStore,
  usePaneMetadataStore
} from "./stores/workspaceStore";
import { createWorkspaceAtCwd } from "./lib/workspaceBootstrap";
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
  getTerminalConfig,
  takePendingOpenPaths,
} from "./lib/ipc";
import { OPEN_PATHS_EVENT, openPathsInMainWindow } from "./lib/openWithPaths";
import { isMainWindow, windowLabel, useWindowRole } from "./lib/windowContext";
import { installChildWindowDevHook } from "./lib/multiWindowDev";
import { useUiStore } from "./stores/uiStore";
import { agentSessionIdentityKey } from "./stores/workspaceListStore";
import { useSettingsStore } from "./stores/settingsStore";
import { isShellProcess } from "./lib/notificationStatus";
import { confirmAgentSessionClear } from "./lib/agentSessionClearGuard";
import type { AgentSessionKind } from "./types";
import {
  STARTUP_RESTORE_COMPLETE_EVENT,
  collectStartupSessionIds,
  getStartupSessionGateSnapshot,
  prepareStartupSessionGate,
  waitForStartupSessionGate,
} from "./lib/startupSessionGate";
import AppShell from "./components/layout/AppShell";
import DetachedPaneShell from "./components/layout/DetachedPaneShell";
import { detachedWorkspaceForWindow } from "./lib/detachedPane";
import ErrorBoundary from "./components/common/ErrorBoundary";
import ToastHost from "./components/common/ToastHost";
import { initDefaultShell } from "./lib/agents";
import { isSavepointTransferPath, receiveSavepointTransfer } from "./lib/savepointTransfer";
import { useToastStore } from "./stores/toastStore";
import { onlineStrings } from "./components/online/onlineStrings";
import { useAgentDormancy } from "./hooks/useAgentDormancy";
import { connectSessionAttentionStore } from "./stores/sessionAttentionStore";
import { connectStallStore } from "./stores/stallStore";
import { connectDispatchWatchdog } from "./stores/dispatchWatchdogStore";
import { startAutoPaneNaming, stopAutoPaneNaming } from "./lib/autoPaneNaming";
import { IS_MAC } from "./lib/keybindings";

/** Longest a visible window waits for its first frames before it reveals anyway. */
const REVEAL_FRAME_FALLBACK_MS = 250;

// Kick off config fetch immediately — will be cached by the time terminals mount
preloadTerminalConfig();

// unhandledrejection is handled once in main.tsx (registered earlier, logs and
// surfaces a throttled toast) — do not register a second listener here.

function waitForSettingsHydration(): Promise<void> {
  if (useSettingsStore.persist.hasHydrated()) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let unsubscribe = () => {};
    unsubscribe = useSettingsStore.persist.onFinishHydration(() => {
      unsubscribe();
      resolve();
    });
    if (useSettingsStore.persist.hasHydrated()) {
      unsubscribe();
      resolve();
    }
  });
}

function inferAgentKindFromProcessTitle(processTitle?: string): AgentSessionKind | null {
  const lowerTitle = processTitle?.toLowerCase() ?? "";
  if (lowerTitle.includes("claude-codex")) return "claude-codex";
  if (lowerTitle.includes("grok")) return "grok";
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
        if (tab.agentId === "grok") return "grok";
        if (tab.agentId === "claude-codex") return "claude-codex";
      }
    }
  }
  return null;
}

async function applyAgentSessionMappings(): Promise<void> {
  const sessionIds = useWorkspaceListStore.getState().workspaces.flatMap((workspace) =>
    workspace.panes.flatMap((pane) => [pane.sessionId, ...pane.tabs.map((tab) => tab.sessionId)]),
  );
  const mappings = await readAgentSessionMappings(sessionIds);
  for (const [sessionId, mapping] of Object.entries(mappings)) {
    const metadataState = usePaneMetadataStore.getState();
    const current = metadataState.metadata[sessionId];
    if (current?.processIsShell) {
      continue;
    }
    const processKind = inferAgentKindFromProcessTitle(metadataState.volatileMetadata[sessionId]?.processTitle);
    const tabKind = inferAgentKindFromTab(sessionId);
    const kind = mapping.agent_kind ?? processKind ?? tabKind;
    if (!kind) {
      continue;
    }
    if (!processKind && tabKind && tabKind !== kind) {
      continue;
    }
    const payload = {
      claudeSessionId: kind === "claude"
        ? mapping.session_id
        : (current?.claudeSessionId ?? undefined),
      agentKind: kind,
      agentSessionId: mapping.session_id,
    };
    const claim = useWorkspaceListStore.getState().setPaneAgentSessionFromMetadata(sessionId, payload);
    if (claim.conflict) {
      const currentKey = agentSessionIdentityKey(
        current?.agentKind,
        current?.agentSessionId,
        current?.claudeSessionId,
      );
      if (currentKey === claim.conflict.key) {
        usePaneMetadataStore.getState().clearAgentSessionId(sessionId);
        usePaneMetadataStore.getState().clearClaudeSessionId(sessionId);
      }
      continue;
    }
    usePaneMetadataStore.getState().setMetadata(sessionId, {
      agentKind: kind,
      agentSessionId: mapping.session_id,
      claudeSessionId: kind === "claude" ? mapping.session_id : current?.claudeSessionId,
    });
  }
}

function App() {
  const [ready, setReady] = useState(false);
  const [startupMaskVisible, setStartupMaskVisible] = useState(true);
  const [childProbeError, setChildProbeError] = useState<string | null>(null);
  const uiVariantEnv = import.meta.env.VITE_UI_VARIANT;
  const uiVariant = uiVariantEnv === "mycmux" || uiVariantEnv === "cmux" ? "cmux" : "default";
  // Startup identity controls hydration/reveal; shared tasks follow the role.
  const isMain = isMainWindow();
  const hasRole = useWindowRole();
  // Selecting the workspace itself (not the array) keeps the main window off
  // this subscription entirely: it resolves to a stable null, so unrelated
  // layout churn no longer re-renders the whole shell.
  const detachedWorkspace = useWorkspaceListStore(
    (state) => detachedWorkspaceForWindow(state.workspaces, isMain),
  );

  useWorkspacePersist();
  useAgentDormancy(ready && hasRole);

  useEffect(() => {
    if (!ready || !isMain) return;
    let live = true;
    let unlisten: (() => void) | undefined;
    let drainTail: Promise<void> = Promise.resolve();
    const drain = () => {
      drainTail = drainTail.then(async () => {
        if (!live) return;
        const paths = await takePendingOpenPaths();
        await openPathsInMainWindow(paths);
      }).catch((error) => {
        if (live) useToastStore.getState().pushToast(`Failed to receive file-open request: ${String(error)}`, "error");
      });
    };
    void listen(OPEN_PATHS_EVENT, drain).then((unsubscribe) => {
      if (!live) unsubscribe();
      else { unlisten = unsubscribe; drain(); }
    }).catch((error) => {
      if (live) useToastStore.getState().pushToast(`Failed to listen for file-open requests: ${String(error)}`, "error");
    });
    return () => { live = false; unlisten?.(); };
  }, [ready, isMain]);

  useEffect(() => {
    if (!ready || !hasRole) return;
    return connectDispatchWatchdog();
  }, [ready, hasRole]);

  useEffect(() => {
    if (!ready || !hasRole) return;
    startAutoPaneNaming();
    return stopAutoPaneNaming;
  }, [ready, hasRole]);

  useEffect(() => {
    async function bootstrap() {
      await Promise.all([persistLoaded, initDefaultShell()]);
      await waitForSettingsHydration();
      const listStore = useWorkspaceListStore.getState();
      let launchCwd: string | null = null;
      try {
        launchCwd = await getLaunchCwd();
      } catch { /* ignore */ }

      // No launch cwd (Start Menu / pinned shortcut) intentionally creates
      // nothing — AppShell shows the empty-state panel instead of dropping the
      // user into a bare app behind a modal.
      // Child windows never bootstrap a workspace either: they start empty and
      // receive their workspaces by adoption (Phase 3b), so creating one here
      // would spawn a stray PTY on every tear-out.
      if (isMain && listStore.workspaces.length === 0 && launchCwd) {
        createWorkspaceAtCwd(launchCwd);
      }

      const currentListState = useWorkspaceListStore.getState();
      const activeWorkspaceId = currentListState.activeWorkspaceId
        ?? currentListState.workspaces[0]?.id
        ?? null;
      const startupSessionIds = collectStartupSessionIds(
        currentListState.workspaces,
        activeWorkspaceId,
      );
      prepareStartupSessionGate(startupSessionIds);
      setStartupMaskVisible(true);

      setReady(true);
    }
    bootstrap();

    // PTY metadata listener — also computes processIsShell which drives the
    // "working" indicator (blue dot). Rust sysinfo polls every 5 seconds, and
    // the deepest-child heuristic can transiently report a shell while an
    // agent runs tool subprocesses, so a single observation is NOT a reliable
    // exit signal — marker clearing goes through confirmShellObservation.
    //
    // Mirrors agent session metadata into BOTH paneMetadataStore (live UI) AND
    // workspaceListStore (persisted via toConfig). Without the latter mirror,
    // toConfig only sees stale Pane.claudeSessionId and saves null, which is
    // why session restore was broken before v0.6.1.
    const unlistenMeta = onPtyMetadata((meta) => {
      const processIsShell = isShellProcess(meta.process_name ?? undefined);
      const agentActive = meta.agent_active === true;
      const paneMetadataStore = usePaneMetadataStore.getState();
      const workspaceListStore = useWorkspaceListStore.getState();
      const clearSuppressed = paneMetadataStore.metadata[meta.session_id]?.agentStatus === "waiting";
      if (confirmAgentSessionClear(meta.session_id, processIsShell, agentActive, clearSuppressed)) {
        paneMetadataStore.clearAgentSessionId(meta.session_id);
        paneMetadataStore.clearClaudeSessionId(meta.session_id);
        // Also clear the persisted Pane/Tab fields so the next save doesn't
        // ressurect a stale agent session for a pane that's now back in shell.
        workspaceListStore.setPaneAgentSessionFromMetadata(meta.session_id, null);
      }
      const sessionPayload = agentActive && (meta.claude_session_id || meta.agent_session_id)
        ? {
            claudeSessionId: meta.claude_session_id ?? undefined,
            agentKind: (meta.agent_kind as AgentSessionKind | undefined) ?? undefined,
            agentSessionId: meta.agent_session_id ?? undefined,
          }
        : null;
      const sessionClaim = sessionPayload
        ? workspaceListStore.setPaneAgentSessionFromMetadata(meta.session_id, sessionPayload)
        : null;
      const sessionClaimAccepted = sessionClaim?.accepted ?? true;
      if (sessionClaim?.conflict) {
        const currentMeta = paneMetadataStore.metadata[meta.session_id];
        const currentMetaKey = agentSessionIdentityKey(
          currentMeta?.agentKind,
          currentMeta?.agentSessionId,
          currentMeta?.claudeSessionId,
        );
        if (currentMetaKey === sessionClaim.conflict.key) {
          paneMetadataStore.clearAgentSessionId(meta.session_id);
          paneMetadataStore.clearClaudeSessionId(meta.session_id);
        }
      }
      paneMetadataStore.setMetadata(meta.session_id, {
        cwd: meta.cwd,
        gitBranch: meta.git_branch,
        processIsShell,
        backendProcessStatus: meta.process_status,
        claudeSessionId: sessionClaimAccepted && agentActive ? meta.claude_session_id ?? undefined : undefined,
        agentKind: sessionClaimAccepted && agentActive ? meta.agent_kind ?? undefined : undefined,
        agentSessionId: sessionClaimAccepted && agentActive ? meta.agent_session_id ?? undefined : undefined,
      });
      paneMetadataStore.setVolatileMetadata(meta.session_id, {
        processTitle: meta.process_name ?? undefined,
        backendLastOutputAt: meta.last_output_at,
      });
      // The workspace claim is intentionally applied before pane metadata.
      // Otherwise a rejected duplicate can re-enter persistence via toConfig's
      // paneMetadataStore fallback.
    });

    // Work-done listener: backend detects a foreground process transition
    // from a working process (claude/node/python/…) back to a shell and
    // emits this event. Badge the pane unless it's currently focused.
    // Deliberately does NOT clear agent session markers here: the transition
    // signal fires for agent tool subprocesses too, and a single misfire used
    // to permanently delete the persisted session id. The metadata listener's
    // confirmShellObservation guard above owns marker clearing.
    const unlistenWorkDone = onPtyWorkDone((evt) => {
      const activePaneId = useUiStore.getState().activePaneId;
      if (activePaneId === evt.session_id) return;
      usePaneMetadataStore.getState().notifyWorkDone(evt.session_id);
    });
    const unlistenAttention = connectSessionAttentionStore();
    unlistenAttention.catch((error) => {
      console.warn("[attention] Failed to subscribe to session status changes", error);
    });
    const disconnectStallDetection = connectStallStore();

    // Drag-and-drop: route folder drops to the correct terminal pane
    const unlistenDragDrop = getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== "drop") return;
      const { paths, position } = event.payload;
      if (!paths || paths.length === 0) return;

      if (paths.length === 1 && isSavepointTransferPath(paths[0])) {
        try {
          const result = await receiveSavepointTransfer(paths[0]);
          useToastStore.getState().pushToast(
            result.imported
              ? onlineStrings.transferReceived
              : onlineStrings.transferAlreadyReceived,
            "info",
          );
        } catch (error) {
          console.error("[mycmux] failed to receive dropped savepoint transfer", error);
          useToastStore.getState().pushToast(
            onlineStrings.transferReceiveErrorPrefix + String(error),
            "error",
          );
        }
        return;
      }

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
      unlistenAttention.then((f) => f()).catch(() => {});
      disconnectStallDetection();
      unlistenDragDrop.then((f) => f()).catch(() => {});
      window.removeEventListener(STARTUP_RESTORE_COMPLETE_EVENT, refreshAgentSessionMappings);
      window.clearTimeout(mappingFallbackTimer);
    };
  }, []);

  // Child boot probe: prove IPC actually works in this window before letting it
  // masquerade as a usable shell. A capability mismatch (capabilities/default.json
  // must list the `mycmux-w*` glob) leaves a child window permission-less, and
  // then *every* invoke fails — which would otherwise show up as an empty,
  // inert window with errors buried in a devtools console nobody opened.
  useEffect(() => {
    installChildWindowDevHook();
    if (isMain) return;

    let cancelled = false;
    getTerminalConfig()
      .then(() => {
        if (!cancelled) setChildProbeError(null);
      })
      .catch((error) => {
        console.error("[multiwindow] child window IPC probe failed", error);
        if (!cancelled) {
          setChildProbeError(error instanceof Error ? error.message : String(error));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isMain]);

  useEffect(() => {
    if (!ready) return;

    let cancelled = false;
    let started = false;
    let rafA = 0;
    let rafB = 0;
    let frameFallback: ReturnType<typeof setTimeout> | null = null;

    const reveal = async (): Promise<void> => {
      if (cancelled || started) return;
      started = true;
      cancelAnimationFrame(rafA);
      cancelAnimationFrame(rafB);
      if (frameFallback !== null) clearTimeout(frameFallback);
      try {
        if (!isMain) {
          // Child windows are built hidden (open_child_window →
          // `.visible(false)`) and reveal themselves once they have painted.
          // There is no startup session gate to wait for: a child restores
          // nothing in Phase 3a.
          const childWindow = getCurrentWindow();
          await childWindow.show();
          await childWindow.setFocus();
          setStartupMaskVisible(false);
          return;
        }
        const { expected } = getStartupSessionGateSnapshot();
        const startupTimeoutMs = Math.min(12000, Math.max(1800, 700 + expected * 350));
        const gateCompletion = waitForStartupSessionGate(startupTimeoutMs);
        await revealMainWindow();
        if (cancelled) return;
        setStartupMaskVisible(false);
        void gateCompletion.then((gateResult) => {
          if (gateResult.timedOut) {
            console.warn(`[startup] session gate timed out with ${gateResult.pending} sessions still pending`);
          }
        });
      } catch (error) {
        console.error(error);
        setStartupMaskVisible(false);
      }
    };

    // Normally the window shows after its second frame, so the first paint is
    // already there. WKWebView runs no animation frames for a window that is not
    // on screen, though, and every child window is built hidden: on macOS those
    // frames never came, and a torn-out pane sat invisible until the 6 s Rust
    // fallback showed it (measured on a Mac mini, 2026-09-17). A hidden Mac page
    // therefore reveals right away and paints once it is visible; anywhere else
    // a missing frame (an occluded window) costs at most the fallback delay.
    rafA = requestAnimationFrame(() => {
      rafB = requestAnimationFrame(() => { void reveal(); });
    });
    frameFallback = setTimeout(
      () => { void reveal(); },
      IS_MAC && document.visibilityState === "hidden" ? 0 : REVEAL_FRAME_FALLBACK_MS,
    );

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafA);
      cancelAnimationFrame(rafB);
      if (frameFallback !== null) clearTimeout(frameFallback);
    };
  }, [ready, isMain]);

  if (childProbeError) {
    return (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          background: "color-mix(in srgb, var(--cmux-red) 16%, var(--cmux-boot-bg, #0a0a0a))",
          color: "var(--cmux-boot-fg, #ededed)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          padding: 32,
          textAlign: "center",
          font: "13px/1.6 system-ui, sans-serif",
          userSelect: "text",
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 700 }}>
          このウィンドウはバックエンドに接続できません
        </div>
        <div style={{ maxWidth: 620 }}>
          ウィンドウ <code>{windowLabel()}</code> からの IPC が失敗しました。
          <br />
          src-tauri/capabilities/default.json の windows に
          <code> &quot;mycmux-w*&quot; </code>
          が含まれているか確認してください。
        </div>
        <pre
          style={{
            maxWidth: "80vw",
            maxHeight: "40vh",
            overflow: "auto",
            background: "rgba(0,0,0,0.35)",
            padding: 12,
            borderRadius: 6,
            fontSize: 12,
            whiteSpace: "pre-wrap",
          }}
        >
          {childProbeError}
        </pre>
      </div>
    );
  }

  if (!ready) {
    return (
      <div
        style={{
          width: "100vw",
          height: "100vh",
          background: "var(--cmux-boot-bg, #0a0a0a)",
        }}
      />
    );
  }

  return (
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "var(--cmux-boot-bg, #0a0a0a)" }}>
      <ErrorBoundary>
        {detachedWorkspace
          ? <DetachedPaneShell workspace={detachedWorkspace} />
          : <AppShell uiVariant={uiVariant} />}
        <ToastHost />
      </ErrorBoundary>
      {startupMaskVisible && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "var(--cmux-boot-bg, #0a0a0a)",
            zIndex: 9999,
            pointerEvents: "none",
          }}
        />
      )}
    </div>
  );
}

export default App;
