import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  useWorkspaceListStore,
  useWorkspaceLayoutStore,
  usePaneMetadataStore
} from "./stores/workspaceStore";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useWorkspacePersist, persistLoaded } from "./components/layout/SocketListener";
import { preloadTerminalConfig, onPtyMetadata, isDirectory, writeToSession, getLaunchCwd } from "./lib/ipc";
import AppShell from "./components/layout/AppShell";
import { initDefaultShell } from "./lib/agents";

// Kick off config fetch immediately — will be cached by the time terminals mount
preloadTerminalConfig();
initDefaultShell();

// Prevent unhandled promise rejections from crashing the app
window.addEventListener("unhandledrejection", (e) => {
  console.warn("[mycmux] unhandled rejection:", e.reason);
  e.preventDefault();
});

function App() {
  const [ready, setReady] = useState(false);
  const uiVariant = import.meta.env.VITE_UI_VARIANT === "cmux" ? "cmux" : "default";

  useWorkspacePersist();

  useEffect(() => {
    async function bootstrap() {
      await persistLoaded;
      const listStore = useWorkspaceListStore.getState();
      if (listStore.workspaces.length === 0) {
        // Check if app was launched with a folder path argument
        let launchCwd: string | null = null;
        try {
          launchCwd = await getLaunchCwd();
        } catch { /* ignore */ }

        const workspaceId = crypto.randomUUID();
        const { panes, splitRows } = useWorkspaceLayoutStore.getState().buildInitialPanes(workspaceId, "1x1");

        if (launchCwd) {
          for (const pane of panes) {
            pane.cwd = launchCwd;
          }
        }

        listStore.createWorkspace("Terminal", "1x1", panes, splitRows);
      }
      setReady(true);
    }
    bootstrap();

    // PTY metadata listener
    const unlistenMeta = onPtyMetadata((meta) => {
      usePaneMetadataStore.getState().setMetadata(meta.session_id, {
        cwd: meta.cwd,
        gitBranch: meta.git_branch,
        processTitle: meta.process_name ?? undefined,
      });
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
            await writeToSession(sessionId, `cd "${normalized}"`);
            return;
          }
        } catch { /* fall through to paste */ }
      }

      // Paste file paths as quoted strings
      const quoted = paths.map((p) => `"${p}"`).join(" ");
      await writeToSession(sessionId, quoted + " ");
    });

    return () => {
      unlistenMeta.then((f) => f()).catch(() => {});
      unlistenDragDrop.then((f) => f()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (ready) {
      getCurrentWindow().show().catch(console.error);
    }
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

  return <AppShell uiVariant={uiVariant} />;
}

export default App;
